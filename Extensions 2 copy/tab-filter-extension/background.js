// background.js — Service Worker

'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
const RANGES = [
  { min: 1.86, max: 1.88, label: '1.86 – 1.89' },
  { min: 1.84, max: 1.86, label: '1.84 – 1.86' },
  { min: 1.82, max: 1.84, label: '1.82 – 1.84' },
  { min: 1.80, max: 1.82, label: '1.80 – 1.82' },
  { min: 1.78, max: 1.80, label: '1.78 – 1.80' },
  { min: 1.75, max: 1.78, label: '1.75 – 1.78' }
];

const ALARM_NAME = 'oddsFilterAlarm';

// Guard: prevent concurrent runs
let isRunning = false;

// ── Alarm listener ───────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  notify({ action: 'scheduleTriggered' });
  runFilter();
});

// ── Message listener ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {

    case 'startFiltering':
      runFilter();
      sendResponse({ status: 'started' });
      break;

    case 'setSchedule':
      setSchedule(msg.startTime, msg.intervalMins)
        .then(info => sendResponse({ status: 'ok', nextRun: info.nextRun }))
        .catch(err => sendResponse({ status: 'error', message: err.message }));
      return true; // async

    case 'stopSchedule':
      stopSchedule()
        .then(() => sendResponse({ status: 'stopped' }));
      return true;

    case 'getSchedule':
      getScheduleInfo()
        .then(info => sendResponse(info));
      return true;
  }
});

// ── Core filter ──────────────────────────────────────────────────────────────
function runFilter() {
  if (isRunning) return; // prevent overlap
  isRunning = true;
  startTabFiltering()
    .catch(err => notify({ action: 'log', tag: 'ERROR', text: err.message }))
    .finally(() => { isRunning = false; });
}

async function startTabFiltering() {
  const allTabs = await chrome.tabs.query({ currentWindow: true });

  // Skip main tab (index 0); need at least one more
  if (allTabs.length <= 1) {
    notify({ action: 'done', matched: false, text: 'No tabs to process.' });
    return;
  }

  const tabs = allTabs.slice(1);
  notify({ action: 'log', tag: 'INFO', text: `Scanning ${tabs.length} tab(s)...` });

  // ── Single pass: collect odds from all tabs ──────────────────────────────
  // runData stays in memory — no storage I/O needed
  const runData = []; // [{ tabId, title, odds[] }]

  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];

    if (!(await isTabAlive(tab.id))) continue;

    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: getOddsFromPage
      });
      runData.push({
        tabId: tab.id,
        title: (tab.title || tab.url || '').slice(0, 60),
        odds: Array.isArray(result) ? result : []
      });
    } catch {
      // Tab may be a restricted page (chrome://, extensions page, etc.) — skip silently
    }

    if (i < tabs.length - 1) await sleep(2000);
  }

  if (runData.length === 0) {
    notify({ action: 'done', matched: false, text: 'No accessible tabs found.' });
    return;
  }

  // ── Priority decision pass (no I/O) ─────────────────────────────────────
  let winner = null;
  let winRange = null;
  let winIdx = -1;

  for (let ri = 0; ri < RANGES.length; ri++) {
    const range = RANGES[ri];
    const match = runData.find(e => e.odds.some(x => x >= range.min && x < range.max));
    if (match) {
      winner = match;
      winRange = range;
      winIdx = ri;
      break;
    }
  }

  // ── Close tabs ───────────────────────────────────────────────────────────
  const toClose = winner
    ? runData.filter(e => e.tabId !== winner.tabId)
    : runData;

  for (const entry of toClose) {
    if (await isTabAlive(entry.tabId)) {
      await chrome.tabs.remove(entry.tabId);
    }
  }

  // ── Notify popup ─────────────────────────────────────────────────────────
  if (winner) {
    notify({
      action: 'done',
      matched: true,
      rangeIndex: winIdx,
      rangeLabel: winRange.label
    });
  } else {
    notify({ action: 'done', matched: false, text: 'No match found.' });
  }
}

// ── Page-context function (serialised into the tab) ──────────────────────────
function getOddsFromPage() {
  return Array.from(
    document.querySelectorAll('#market0 .bl-box.back .d-block.odds')
  ).map(el => parseFloat(el.textContent.trim())).filter(n => !isNaN(n));
}

// ── Schedule ─────────────────────────────────────────────────────────────────
async function setSchedule(startTimeStr, intervalMins) {
  const mins = Number(intervalMins);
  if (!Number.isFinite(mins) || mins < 1) throw new Error('Invalid interval');

  const parts = String(startTimeStr).split(':').map(Number);
  const h = parts[0] ?? 0, m = parts[1] ?? 0, s = parts[2] ?? 0;
  if ([h, m, s].some(n => !Number.isFinite(n))) throw new Error('Invalid start time');

  const now = Date.now();
  const target = new Date();
  target.setHours(h, m, s, 0);

  // Advance to next future occurrence (avoid infinite loop with a ceiling)
  const intervalMs = mins * 60_000;
  let attempts = 0;
  while (target.getTime() <= now && attempts++ < 1500) {
    target.setTime(target.getTime() + intervalMs);
  }
  if (target.getTime() <= now) throw new Error('Could not compute a future start time');

  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, {
    when: target.getTime(),
    periodInMinutes: mins
  });

  // Persist only lightweight settings (not run data)
  await chrome.storage.local.set({ schedule: { startTime: startTimeStr, intervalMins: mins } });

  return { nextRun: fmtTime(target) };
}

async function stopSchedule() {
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.storage.local.remove('schedule');
}

async function getScheduleInfo() {
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm) return { active: false };

  const { schedule = {} } = await chrome.storage.local.get('schedule');
  return {
    active: true,
    nextRun: fmtTime(new Date(alarm.scheduledTime)),
    intervalMins: schedule.intervalMins ?? null,
    startTime: schedule.startTime ?? null
  };
}

// ── Utilities ────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function fmtTime(date) {
  return date.toLocaleTimeString('en-GB', { hour12: false });
}

function notify(payload) {
  // Silently fails if popup is closed — expected behaviour
  chrome.runtime.sendMessage(payload).catch(() => { });
}

async function isTabAlive(tabId) {
  try { await chrome.tabs.get(tabId); return true; } catch { return false; }
}
