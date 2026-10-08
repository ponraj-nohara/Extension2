/**
 * Auto Reload Tabs — Background Service Worker (MV3)
 *
 * All timing values are hardcoded — never taken from the user.
 *
 * SWITCH_EVERY_MS          =  2 s   — interval between tab switches
 * REVISIT_MAIN_EVERY_MS    =  5 min — how often the switcher returns to the main tab
 * RELOAD_DELAY_MS          =  1 min — delay before a newly opened tab is eligible for reload
 * MAX_ACTIVE_MS            = 20 min — how long a tab stays open after its reload before auto-close
 *
 * Reload sequencing:
 *   When a tab's RELOAD_DELAY_MS elapses it is added to a "dueTabIds" set.
 *   The tab switcher reloads each due tab the moment it makes that tab active.
 *   This staggers reloads 2 s apart even when many tabs become due simultaneously.
 */

// ─── Constants ────────────────────────────────────────────────────────────────
const SWITCH_EVERY_MS       = 2  * 1000;        //  2 seconds
const REVISIT_MAIN_EVERY_MS = 5  * 60 * 1000;   //  5 minutes
const RELOAD_DELAY_MS       = 1  * 60 * 1000;   //  1 minute
const MAX_ACTIVE_MS         = 20 * 60 * 1000;   // 20 minutes

const ALARM_RELOAD_PREFIX   = 'reload_';
const ALARM_CLOSE_PREFIX    = 'close_';

// ─── In-memory state ──────────────────────────────────────────────────────────
const switchIntervalId = { ref: null };

// ─── Storage helpers ──────────────────────────────────────────────────────────
function getSession() {
  return chrome.storage.session.get({
    isEnabled:  false,
    mainTabId:  null,
    tabOrder:   [],   // ordered child-tab IDs for cycling
    cycleIndex: 0,    // current position in tabOrder
    dueTabIds:  []    // tabs whose delay has elapsed, waiting for switcher to activate them
  });
}

function setSession(partial) {
  return chrome.storage.session.set(partial);
}

function getLocal() {
  return chrome.storage.local.get({ isEnabled: false });
}

// ─── Badge ────────────────────────────────────────────────────────────────────
async function updateBadge(isEnabled) {
  try {
    if (isEnabled) {
      await chrome.action.setBadgeText({ text: 'ON' });
      await chrome.action.setBadgeBackgroundColor({ color: '#6aad8a' });
    } else {
      await chrome.action.setBadgeText({ text: 'OFF' });
      await chrome.action.setBadgeBackgroundColor({ color: '#4a5054' });
    }
  } catch { /* headless / test env */ }
}

// ─── Serial queue ─────────────────────────────────────────────────────────────
// All tab-lifecycle writes go through this queue so read-modify-write cycles
// never interleave and lose updates when many tabs open simultaneously.
let _queue = Promise.resolve();
const enqueue = fn => (_queue = _queue.then(fn).catch(console.error));

// ─── Perform reload + start close countdown ───────────────────────────────────
// Called by the switcher when it activates a due tab.
// Keeps reload logic in one place, separate from the "mark due" path.
async function performReload(tabId) {
  try {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return; }
    if (!tab?.id) return;

    await chrome.tabs.reload(tabId);
    console.log(`[AutoReload] Reloaded tab ${tabId}.`);

    // Start max-active countdown — auto-close the tab after MAX_ACTIVE_MS
    const closeAt = Date.now() + MAX_ACTIVE_MS;
    await chrome.alarms.create(`${ALARM_CLOSE_PREFIX}${tabId}`, { when: closeAt });
    console.log(
      `[AutoReload] Tab ${tabId} will auto-close at ${new Date(closeAt).toLocaleTimeString()}`
    );
  } catch (err) {
    console.error(`[AutoReload] Error reloading tab ${tabId}:`, err);
  }
}

// ─── Tab Switcher ─────────────────────────────────────────────────────────────
// Cycles through child tabs every SWITCH_EVERY_MS.
// Every REVISIT_MAIN_EVERY_MS it switches back to the main tab for one tick.
// On each tab switch, if the tab is "due", reload it immediately — one tab
// per switch cycle, so reloads are always staggered by SWITCH_EVERY_MS.

let _revisitCountdown = Math.round(REVISIT_MAIN_EVERY_MS / SWITCH_EVERY_MS);

function startSwitcher() {
  stopSwitcher(); // clear any existing interval first
  _revisitCountdown = Math.round(REVISIT_MAIN_EVERY_MS / SWITCH_EVERY_MS);

  switchIntervalId.ref = setInterval(async () => {
    const session = await getSession();
    if (!session.isEnabled) { stopSwitcher(); return; }

    const { mainTabId, tabOrder, cycleIndex, dueTabIds } = session;

    // ── Periodic revisit to main tab ──────────────────────────────────────────
    _revisitCountdown--;
    if (_revisitCountdown <= 0) {
      _revisitCountdown = Math.round(REVISIT_MAIN_EVERY_MS / SWITCH_EVERY_MS);
      if (mainTabId != null) {
        try { await chrome.tabs.update(mainTabId, { active: true }); } catch { /* tab gone */ }
      }
      return;
    }

    if (!tabOrder || tabOrder.length === 0) return;

    // ── Advance to next tab ───────────────────────────────────────────────────
    const nextIndex = (cycleIndex + 1) % tabOrder.length;
    const nextTabId = tabOrder[nextIndex];

    try {
      await chrome.tabs.update(nextTabId, { active: true });
      await setSession({ cycleIndex: nextIndex });

      // ── If this tab is due, reload it now (staggered, one at a time) ───────
      if ((dueTabIds || []).includes(nextTabId)) {
        // Remove from due list first so a concurrent tick can't double-reload
        const updatedDue = (dueTabIds || []).filter(id => id !== nextTabId);
        await setSession({ dueTabIds: updatedDue });
        await performReload(nextTabId);
      }

    } catch {
      // Tab no longer exists — remove from rotation and due list
      enqueue(async () => {
        const s = await getSession();
        const filtered = (s.tabOrder || []).filter(id => id !== nextTabId);
        const safeIndex = filtered.length > 0 ? nextIndex % filtered.length : 0;
        const updatedDue = (s.dueTabIds || []).filter(id => id !== nextTabId);
        await setSession({ tabOrder: filtered, cycleIndex: safeIndex, dueTabIds: updatedDue });
      });
    }
  }, SWITCH_EVERY_MS);

  console.log('[AutoReload] Tab switcher started.');
}

function stopSwitcher() {
  if (switchIntervalId.ref !== null) {
    clearInterval(switchIntervalId.ref);
    switchIntervalId.ref = null;
    console.log('[AutoReload] Tab switcher stopped.');
  }
}

// ─── Schedule reload delay for a newly created tab ────────────────────────────
// Funnelled through the serial queue so batch tab-open events never race.
function scheduleReload(tab) {
  enqueue(async () => {
    if (!tab?.id) return;
    const tabId = tab.id;

    const session = await getSession();
    if (!session.isEnabled) return;

    // Never schedule the main tab
    if (session.mainTabId != null && tabId === session.mainTabId) return;

    // Add to rotation list (de-duplicate)
    const tabOrder = session.tabOrder || [];
    if (!tabOrder.includes(tabId)) {
      await setSession({ tabOrder: [...tabOrder, tabId] });
    }

    // Set alarm — when it fires, the tab goes into dueTabIds (not reloaded yet)
    const reloadAt = Date.now() + RELOAD_DELAY_MS;
    await chrome.alarms.create(`${ALARM_RELOAD_PREFIX}${tabId}`, { when: reloadAt });

    console.log(
      `[AutoReload] Tab ${tabId} reload delay starts — due at ${new Date(reloadAt).toLocaleTimeString()}`
    );
  });
}

// ─── Mark tab as due (called when reload alarm fires) ────────────────────────
// Does NOT reload immediately. Adds tabId to dueTabIds so the switcher can
// reload it the next time it makes this tab active — one tab at a time.
async function markTabDue(tabId) {
  if (tabId == null) return;
  await chrome.alarms.clear(`${ALARM_RELOAD_PREFIX}${tabId}`);

  try {
    const { isEnabled } = await getLocal();
    if (!isEnabled) return;

    const session = await getSession();
    if (session.mainTabId != null && tabId === session.mainTabId) return;

    // Confirm tab still exists
    try { await chrome.tabs.get(tabId); } catch {
      console.log(`[AutoReload] Tab ${tabId} no longer exists — skipping due mark.`);
      return;
    }

    const dueTabIds = session.dueTabIds || [];
    if (!dueTabIds.includes(tabId)) {
      await setSession({ dueTabIds: [...dueTabIds, tabId] });
      console.log(
        `[AutoReload] Tab ${tabId} marked as due — will reload when switcher activates it.`
      );
    }
  } catch (err) {
    console.error(`[AutoReload] Error marking tab ${tabId} as due:`, err);
  }
}

// ─── Auto-close tab after max active time ─────────────────────────────────────
async function executeClose(tabId) {
  if (tabId == null) return;
  await chrome.alarms.clear(`${ALARM_CLOSE_PREFIX}${tabId}`);

  try {
    const { isEnabled } = await getLocal();
    if (!isEnabled) return;

    const session = await getSession();
    if (session.mainTabId != null && tabId === session.mainTabId) return;

    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return; }
    if (!tab?.id) return;

    await chrome.tabs.remove(tabId);
    console.log(`[AutoReload] Auto-closed tab ${tabId} after max active time.`);
  } catch (err) {
    console.error(`[AutoReload] Error auto-closing tab ${tabId}:`, err);
  }
}

// ─── Clear all pending alarms for a tab ───────────────────────────────────────
async function clearTabAlarms(tabId) {
  await chrome.alarms.clear(`${ALARM_RELOAD_PREFIX}${tabId}`);
  await chrome.alarms.clear(`${ALARM_CLOSE_PREFIX}${tabId}`);
}

// ─── Stop monitoring ──────────────────────────────────────────────────────────
async function stopAll() {
  stopSwitcher();

  const alarms = await chrome.alarms.getAll();
  await Promise.all(
    alarms
      .filter(a => a.name.startsWith(ALARM_RELOAD_PREFIX) || a.name.startsWith(ALARM_CLOSE_PREFIX))
      .map(a => chrome.alarms.clear(a.name))
  );

  await chrome.storage.local.set({ isEnabled: false });
  await setSession({ isEnabled: false, tabOrder: [], cycleIndex: 0, dueTabIds: [] });
  await updateBadge(false);
  console.log('[AutoReload] Monitoring stopped. All alarms and due list cleared.');
}

// ─── Start monitoring ─────────────────────────────────────────────────────────
async function startAll() {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const mainTabId = activeTab?.id ?? null;

  await chrome.storage.local.set({ isEnabled: true });
  await setSession({ isEnabled: true, mainTabId, tabOrder: [], cycleIndex: 0, dueTabIds: [] });
  await updateBadge(true);

  startSwitcher();
  console.log(`[AutoReload] Monitoring started. Main tab: ${mainTabId}`);
}

// ─── Event Listeners ──────────────────────────────────────────────────────────

// New tab opened
chrome.tabs.onCreated.addListener(tab => scheduleReload(tab));

// Tab closed — clean up alarms, rotation list, and due list
chrome.tabs.onRemoved.addListener(tabId => {
  clearTabAlarms(tabId);
  enqueue(async () => {
    const session = await getSession();
    const tabOrder = (session.tabOrder || []).filter(id => id !== tabId);
    const cycleIndex = tabOrder.length > 0
      ? Math.min(session.cycleIndex, tabOrder.length - 1)
      : 0;
    const dueTabIds = (session.dueTabIds || []).filter(id => id !== tabId);
    await setSession({ tabOrder, cycleIndex, dueTabIds });
    if (session.mainTabId === tabId) {
      await setSession({ mainTabId: null });
    }
  });
});

// Alarm fired — wake service worker and dispatch
chrome.alarms.onAlarm.addListener(async alarm => {
  if (!alarm?.name) return;

  if (alarm.name.startsWith(ALARM_RELOAD_PREFIX)) {
    const tabId = parseInt(alarm.name.slice(ALARM_RELOAD_PREFIX.length), 10);
    // Mark as due — switcher will do the actual reload when it visits the tab
    if (!isNaN(tabId)) await markTabDue(tabId);
    return;
  }

  if (alarm.name.startsWith(ALARM_CLOSE_PREFIX)) {
    const tabId = parseInt(alarm.name.slice(ALARM_CLOSE_PREFIX.length), 10);
    if (!isNaN(tabId)) await executeClose(tabId);
  }
});

// Messages from popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === 'GET_STATUS') {
        const local = await getLocal();
        const session = await getSession();

        let mainTabTitle = 'No tab recorded';
        if (session.mainTabId != null) {
          try {
            const tab = await chrome.tabs.get(session.mainTabId);
            mainTabTitle = tab.title || tab.url || `Tab #${session.mainTabId}`;
          } catch { mainTabTitle = `Tab #${session.mainTabId} (closed)`; }
        }

        sendResponse({
          success: true,
          isEnabled: local.isEnabled === true,
          mainTabTitle,
          mainTabId: session.mainTabId
        });

      } else if (message.type === 'START') {
        await startAll();
        sendResponse({ success: true, isEnabled: true });

      } else if (message.type === 'STOP') {
        await stopAll();
        sendResponse({ success: true, isEnabled: false });
      }
    } catch (err) {
      console.error('[AutoReload] Message handler error:', err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true;
});

// ─── On Install / Startup ─────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ isEnabled: false });
  await updateBadge(false);
  console.log('[AutoReload] Extension installed.');
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.storage.local.set({ isEnabled: false });
  await setSession({ isEnabled: false, mainTabId: null, tabOrder: [], cycleIndex: 0, dueTabIds: [] });
  await updateBadge(false);
});

// Resume switcher if the service worker restarted mid-session
(async () => {
  const session = await getSession();
  if (session.isEnabled) {
    console.log('[AutoReload] Service worker resumed — restarting switcher.');
    startSwitcher();
  }
})();
