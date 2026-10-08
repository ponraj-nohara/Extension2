// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_ATTEMPTS = 3;
const CHECK_INTERVAL_SECONDS = 10;
const ALARM_NAME = 'loginCheckAlarm';
const USERNAME = 'cs40pkg7';
const MAX_LOGS = 30;
const ALLOWED_HOST = 'www.khelguru777.com';

// ─── URL Allow-list ───────────────────────────────────────────────────────────
// Returns true ONLY for these two exact URLs:
//   https://www.khelguru777.com
//   https://www.khelguru777.com/sport
function isAllowedUrl(url) {
  if (!url) return false;
  try {
    const { protocol, hostname, pathname } = new URL(url);
    return (
      protocol === 'https:' &&
      hostname === ALLOWED_HOST &&
      (pathname === '/' || pathname === '' || pathname === '/sport')
    );
  } catch {
    return false;
  }
}

// ─── Default State ────────────────────────────────────────────────────────────
const defaultState = {
  isRunning: false,
  attempts: 0,
  isLoggedIn: false,
  lockedOut: false,
  logs: [],
  mainTabId: null,
  childTabIds: [],
  matchesOpened: 0,
  scheduleSettings: {
    leadMinutes: 2   // only leadMinutes — no fixed interval or startTime
  }
};

// ─── Storage Helpers ──────────────────────────────────────────────────────────
function getState() {
  return new Promise(resolve => chrome.storage.local.get(defaultState, resolve));
}

function setState(partial) {
  return new Promise(resolve => chrome.storage.local.set(partial, resolve));
}

function addLog(logs, message) {
  const entry = `[${new Date().toLocaleTimeString()}] ${message}`;
  const next = [entry, ...logs];
  if (next.length > MAX_LOGS) next.length = MAX_LOGS;
  return next;
}

// ─── Broadcast to popup (fire-and-forget) ─────────────────────────────────────
async function broadcastStatus() {
  const state = await getState();
  chrome.runtime.sendMessage({ action: 'statusUpdate', state }).catch(() => { });
}

// ─── Extension icon badge ─────────────────────────────────────────────────────
// Green "ON" when running, gray "OFF" when stopped/locked.
async function updateBadge(isEnabled) {
  try {
    if (isEnabled) {
      await chrome.action.setBadgeText({ text: 'ON' });
      await chrome.action.setBadgeBackgroundColor({ color: '#6aad8a' });
    } else {
      await chrome.action.setBadgeText({ text: 'OFF' });
      await chrome.action.setBadgeBackgroundColor({ color: '#4a5054' });
    }
  } catch { /* ignore in headless/test environments */ }
}

// ─── Send message to content script (with auto-inject fallback) ───────────────
// The inject fallback is gated on isAllowedUrl so we never inject content.js
// onto an arbitrary page the user may have navigated to.
async function sendToContentScript(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!isAllowedUrl(tab.url)) {
        console.warn('[MatchOpener] Inject blocked — tab is not on an allowed URL:', tab.url);
        return;
      }
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tabId, message);
    } catch (err) {
      console.warn('Could not reach content script:', err.message);
    }
  }
}

// ─── Close child tabs ─────────────────────────────────────────────────────────
async function closeChildTabs(mainTabId, childTabIds) {
  const childSet = new Set(childTabIds);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(t => t.id !== mainTabId && (t.openerTabId === mainTabId || childSet.has(t.id)))
    .map(t => t.id);

  if (toClose.length === 0) {
    console.log('No child tabs to close.');
    return 0;
  }

  await chrome.tabs.remove(toClose);
  console.log(`Closed ${toClose.length} child tab(s):`, toClose);
  return toClose.length;
}

// ─── Track JS-opened child tabs ───────────────────────────────────────────────
chrome.tabs.onCreated.addListener(async tab => {
  if (tab.openerTabId == null) return;
  const state = await getState();
  if (!state.isRunning) return;
  if (state.childTabIds.includes(tab.id)) return;
  await setState({ childTabIds: [...state.childTabIds, tab.id] });
});

// ─── Alarm: check every CHECK_INTERVAL_SECONDS ────────────────────────────────
// Sends the current leadMinutes to the content script on every tick so it can
// decide which upcoming matches fall within the lead window right now.
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== ALARM_NAME) return;

  const state = await getState();
  if (!state.isRunning || state.lockedOut || state.mainTabId === null) return;

  // Verify the monitored tab is still on an allowed URL.
  try {
    const tab = await chrome.tabs.get(state.mainTabId);
    if (!isAllowedUrl(tab.url)) {
      console.warn('[MatchOpener] Alarm skipped — tab navigated away from allowed URL:', tab.url);
      return;
    }
  } catch {
    console.warn('[MatchOpener] Alarm skipped — monitored tab no longer exists.');
    return;
  }

  await sendToContentScript(state.mainTabId, {
    action: 'checkLogin',
    leadMinutes: state.scheduleSettings.leadMinutes
  });
});

// ─── Message Handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message, sendResponse);
  return true;
});

async function handleMessage(message, sendResponse) {
  const { action } = message;

  // ── Popup: get current status ──────────────────────────────────────────────
  if (action === 'getStatus') {
    const state = await getState();
    sendResponse({ state });
    return;
  }

  // ── Popup: start automation ────────────────────────────────────────────────
  if (action === 'start') {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!isAllowedUrl(activeTab?.url)) {
      console.warn('[MatchOpener] Start blocked — active tab is not on an allowed URL:', activeTab?.url);
      sendResponse({ error: 'not_allowed_url' });
      return;
    }

    const mainTabId = activeTab.id;
    const state = await getState();
    const scheduleSettings = message.scheduleSettings || state.scheduleSettings;

    await setState({
      isRunning: true,
      attempts: 0,
      lockedOut: false,
      mainTabId,
      childTabIds: [],
      scheduleSettings,
      logs: addLog(state.logs, `Automation started on tab ${mainTabId}.`)
    });

    chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: 0,
      periodInMinutes: CHECK_INTERVAL_SECONDS / 60
    });
    broadcastStatus();
    updateBadge(true);
    return;
  }

  // ── Popup: stop automation ─────────────────────────────────────────────────
  if (action === 'stop') {
    const state = await getState();
    await setState({
      isRunning: false,
      matchesOpened: 0,
      logs: addLog(state.logs, 'Automation stopped by user.')
    });
    chrome.alarms.clear(ALARM_NAME);
    if (state.mainTabId !== null) {
      sendToContentScript(state.mainTabId, { action: 'stopScanner' });
    }
    broadcastStatus();
    updateBadge(false);
    return;
  }

  // ── Popup: reset attempts ──────────────────────────────────────────────────
  if (action === 'reset') {
    const state = await getState();
    await setState({
      attempts: 0,
      lockedOut: false,
      matchesOpened: 0,
      logs: addLog(state.logs, 'Attempt counter reset.')
    });
    broadcastStatus();
    return;
  }

  // ── Content: already logged in ─────────────────────────────────────────────
  if (action === 'alreadyLoggedIn') {
    const state = await getState();
    await setState({
      isLoggedIn: true,
      logs: addLog(state.logs, `Already logged in as: ${USERNAME}.`)
    });
    broadcastStatus();
    return;
  }

  // ── Content: login attempt started ─────────────────────────────────────────
  if (action === 'loginStarted') {
    const state = await getState();
    const newAttempts = state.attempts + 1;
    await setState({
      attempts: newAttempts,
      isLoggedIn: false,
      logs: addLog(state.logs, `Login attempt ${newAttempts}/${MAX_ATTEMPTS}.`)
    });
    broadcastStatus();
    return;
  }

  // ── Content: login result ──────────────────────────────────────────────────
  if (action === 'loginVerified') {
    const state = await getState();

    if (message.success) {
      await setState({
        isLoggedIn: true,
        logs: addLog(state.logs, `Login successful as ${USERNAME}.`)
      });
      broadcastStatus();
      return;
    }

    const failedLogs = addLog(state.logs, `Login failed. (Attempt ${state.attempts}/${MAX_ATTEMPTS})`);
    await setState({ isLoggedIn: false, logs: failedLogs });

    if (state.attempts >= MAX_ATTEMPTS) {
      const lockedLogs = addLog(failedLogs, 'Max attempts reached. Closing child tabs…');
      await setState({ lockedOut: true, isRunning: false, logs: lockedLogs });
      chrome.alarms.clear(ALARM_NAME);
      broadcastStatus();
      updateBadge(false);
      await closeChildTabs(state.mainTabId, state.childTabIds);
      await setState({ childTabIds: [] });
      return;
    }

    broadcastStatus();
    return;
  }

  // ── Content: open match tab ────────────────────────────────────────────────
  if (action === 'openTab') {
    const state = await getState();
    const tab = await chrome.tabs.create({ url: message.url, openerTabId: state.mainTabId });

    const fresh = await getState();
    if (!fresh.childTabIds.includes(tab.id)) {
      const newCount = (fresh.matchesOpened || 0) + 1;
      await setState({
        childTabIds: [...fresh.childTabIds, tab.id],
        matchesOpened: newCount
      });
      console.log(`[MatchOpener] Matches opened: ${newCount}`);
    } else {
      const newCount = (fresh.matchesOpened || 0) + 1;
      await setState({ matchesOpened: newCount });
      console.log(`[MatchOpener] Matches opened: ${newCount}`);
    }
    broadcastStatus();
    return;
  }

  // ── Content: log ──────────────────────────────────────────────────────────
  if (action === 'log') {
    const state = await getState();
    await setState({ logs: addLog(state.logs, message.text) });
    broadcastStatus();
  }
}

// ─── On Install ───────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  await setState(defaultState);
  updateBadge(false);
  console.log('Match Tab Opener installed.');
});
