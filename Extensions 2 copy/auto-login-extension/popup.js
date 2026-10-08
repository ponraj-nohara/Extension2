// ─── Elements ─────────────────────────────────────────────────────────────────
const statusBlock = document.getElementById('statusBlock');
const statusText = document.getElementById('statusText');
const mainTabTitle = document.getElementById('mainTabTitle');
const btnStartStop = document.getElementById('btnStartStop');
const btnActionText = document.getElementById('btnActionText');
const btnReset = document.getElementById('btnReset');
const lockedBanner = document.getElementById('lockedBanner');
const inputLead = document.getElementById('inputLead');

// Tracks whether automation is currently running.
let running = false;

// ─── Constants ────────────────────────────────────────────────────────────────
const INTERVAL_MINUTES = 30; // Fixed — not exposed to user

// ─── Auto-compute Start Time ──────────────────────────────────────────────────
// Always returns the NEXT 30-minute slot strictly after the current time.
//   4:00 → 4:30 │ 4:02 → 4:30 │ 4:15 → 4:30 │ 4:32 → 5:00
function computeAutoStartTime() {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();

  if (m < 30) {
    // Next slot is HH:30
    return `${String(h).padStart(2, '0')}:30`;
  } else {
    // Next slot is (HH+1):00, wrapping at midnight
    const nextH = (h + 1) % 24;
    return `${String(nextH).padStart(2, '0')}:00`;
  }
}

// ─── Input helpers ────────────────────────────────────────────────────────────
function parseIntClamped(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// ─── Render State ─────────────────────────────────────────────────────────────
function renderState(state) {
  const { isRunning, isLoggedIn, lockedOut } = state;
  running = isRunning;

  // ── Status badge ──
  statusBlock.className = 'status-badge';

  if (lockedOut) {
    statusBlock.classList.add('locked');
    statusText.textContent = 'Locked';
  } else if (isRunning) {
    // Running always wins — show the pulsing Active badge regardless of login state.
    statusBlock.classList.add('active');
    statusText.textContent = 'Active';
  } else if (isLoggedIn) {
    // Idle but already logged in from a previous session.
    statusBlock.classList.add('logged-in');
    statusText.textContent = 'Logged In';
  } else {
    statusBlock.classList.add('paused');
    statusText.textContent = 'Idle';
  }


  // ── Main tab pill ──
  mainTabTitle.textContent = isLoggedIn ? 'cs40pkg7' : 'Not logged in';

  // ── Locked banner ──
  lockedBanner.classList.toggle('visible', lockedOut);

  // ── Start / Stop button ──
  if (isRunning) {
    btnStartStop.className = 'btn-action btn-stop';
    btnActionText.textContent = 'Stop';
  } else {
    btnStartStop.className = 'btn-action btn-start';
    btnActionText.textContent = 'Start';
  }
  btnStartStop.disabled = lockedOut;

  // ── Lock lead input while running ──
  inputLead.disabled = isRunning;
}

// ─── Load initial state ────────────────────────────────────────────────────────
// Lead time is restored from saved settings; start time & interval are auto-computed.
chrome.runtime.sendMessage({ action: 'getStatus' }, response => {
  if (!response?.state) return;
  const { scheduleSettings } = response.state;
  if (scheduleSettings) {
    inputLead.value = scheduleSettings.leadMinutes ?? 2;
  }
  renderState(response.state);
});

// ─── Live updates from background ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener(message => {
  if (message.action === 'statusUpdate' && message.state) {
    renderState(message.state);
  }
});

// ─── Button: Start / Stop toggle ──────────────────────────────────────────────
btnStartStop.addEventListener('click', () => {
  if (running) {
    chrome.runtime.sendMessage({ action: 'stop' });
    return;
  }

  const scheduleSettings = {
    startTime: computeAutoStartTime(),           // derived from system clock
    intervalMinutes: INTERVAL_MINUTES,                 // fixed at 30
    leadMinutes: parseIntClamped(inputLead.value, 0, 60, 2)
  };

  console.log('[AutoLogin] Starting with scheduleSettings:', scheduleSettings);
  chrome.runtime.sendMessage({ action: 'start', scheduleSettings });
});

// ─── Button: Reset ────────────────────────────────────────────────────────────
btnReset.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'reset' });
});
