// popup.js — UI controller

'use strict';

// Mirror of background.js RANGES (display only — no logic here)
const RANGES = [
  { label: 'Priority 1', value: '1.86 – 1.89' },
  { label: 'Priority 2', value: '1.84 – 1.86' },
  { label: 'Priority 3', value: '1.82 – 1.84' },
  { label: 'Priority 4', value: '1.80 – 1.82' },
  { label: 'Priority 5', value: '1.78 – 1.80' },
  { label: 'Priority 6', value: '1.75 – 1.78' }
];

// ── DOM references ────────────────────────────────────────────────────────────
const startBtn = document.getElementById('startBtn');
const statusDot = document.getElementById('statusDot');
const statusLabel = document.getElementById('statusLabel');
const scheduleBtn = document.getElementById('scheduleBtn');
const stopBtn = document.getElementById('stopBtn');
const startTimeEl = document.getElementById('startTime');
const intervalEl = document.getElementById('intervalMins');
const nextRunValue = document.getElementById('nextRunValue');
const resultRow = document.getElementById('resultRow');
const resultValue = document.getElementById('resultValue');

// ── State ─────────────────────────────────────────────────────────────────────
let resultState = 'idle'; // 'idle' | 'matched' | 'no-match'

// ── On popup open ─────────────────────────────────────────────────────────────
chrome.runtime.sendMessage({ action: 'getSchedule' }, (info) => {
  if (chrome.runtime.lastError) return; // background not ready
  if (info?.active) applyScheduleActive(info);
});

// ── Background message listener ───────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg?.action) return;

  switch (msg.action) {

    // Scheduled run started (popup may have been closed previously)
    case 'scheduleTriggered':
      setStatus('active', 'Running');
      setResult('idle', '—');
      setRunBtn(true);
      break;

    // Filter finished
    case 'done':
      setRunBtn(false);
      setStatus('done', 'Done');
      if (msg.matched) {
        const r = RANGES[msg.rangeIndex];
        setResult('matched', r ? `${r.label}  ·  ${r.value}` : msg.rangeLabel);
      } else {
        setResult('no-match', 'No match found');
      }
      break;
  }
});

// ── Run Now ───────────────────────────────────────────────────────────────────
startBtn.addEventListener('click', () => {
  setRunBtn(true);
  setStatus('active', 'Running');
  setResult('idle', '—');
  chrome.runtime.sendMessage({ action: 'startFiltering' });
});

// ── Set Schedule ──────────────────────────────────────────────────────────────
scheduleBtn.addEventListener('click', () => {
  const startTime = startTimeEl.value.trim();
  const intervalMins = parseInt(intervalEl.value, 10);

  if (!startTime) {
    showNextRunError('Enter a valid start time');
    return;
  }
  if (!Number.isFinite(intervalMins) || intervalMins < 1) {
    showNextRunError('Enter a valid interval (≥ 1 min)');
    return;
  }

  scheduleBtn.disabled = true;
  scheduleBtn.textContent = 'Saving...';

  chrome.runtime.sendMessage({ action: 'setSchedule', startTime, intervalMins }, (res) => {
    scheduleBtn.disabled = false;
    if (chrome.runtime.lastError || res?.status !== 'ok') {
      showNextRunError('Failed to set schedule');
      scheduleBtn.textContent = 'Set Schedule';
      return;
    }
    applyScheduleActive({ nextRun: res.nextRun, intervalMins, startTime });
  });
});

// ── Stop Schedule ─────────────────────────────────────────────────────────────
stopBtn.addEventListener('click', () => {
  stopBtn.disabled = true;
  chrome.runtime.sendMessage({ action: 'stopSchedule' }, () => {
    stopBtn.disabled = false;
    applyScheduleInactive();
  });
});

// ── UI helpers ────────────────────────────────────────────────────────────────
function setRunBtn(running) {
  startBtn.disabled = running;
  startBtn.textContent = running ? 'Running...' : 'Run Now';
}

function setStatus(state, label) {
  statusDot.className = `status-dot${state ? ' ' + state : ''}`;
  statusLabel.className = `status-label${state ? ' ' + state : ''}`;
  statusLabel.textContent = label;
}

function setResult(state, text) {
  resultState = state;
  resultRow.className = `result-row${state && state !== 'idle' ? ' ' + state : ''}`;
  resultValue.textContent = text;
}

function applyScheduleActive(info) {
  nextRunValue.textContent = `${info.nextRun}  ·  every ${info.intervalMins} min`;
  nextRunValue.style.color = '#7a9ab5';
  scheduleBtn.textContent = 'Update';
  stopBtn.classList.add('visible');
  if (info.startTime) startTimeEl.value = info.startTime;
  if (info.intervalMins) intervalEl.value = info.intervalMins;
}

function applyScheduleInactive() {
  nextRunValue.textContent = 'Not scheduled';
  nextRunValue.style.color = '#7a9ab5';
  scheduleBtn.textContent = 'Set Schedule';
  stopBtn.classList.remove('visible');
}

function showNextRunError(msg) {
  nextRunValue.textContent = msg;
  nextRunValue.style.color = '#c47a8a';
}
