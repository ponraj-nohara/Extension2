// ─── Elements ─────────────────────────────────────────────────────────────────
const statusBlock = document.getElementById('statusBlock');
const statusText = document.getElementById('statusText');
const mainTabTitle = document.getElementById('mainTabTitle');
const btnStartStop = document.getElementById('btnStartStop');
const btnActionText = document.getElementById('btnActionText');
const btnReset = document.getElementById('btnReset');
const lockedBanner = document.getElementById('lockedBanner');
const inputLead = document.getElementById('inputLead');

let running = false;

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


  mainTabTitle.textContent = isLoggedIn ? 'cs40pkg7' : 'Not logged in';
  lockedBanner.classList.toggle('visible', lockedOut);

  if (isRunning) {
    btnStartStop.className = 'btn-action btn-stop';
    btnActionText.textContent = 'Stop';
  } else {
    btnStartStop.className = 'btn-action btn-start';
    btnActionText.textContent = 'Start';
  }
  btnStartStop.disabled = lockedOut;
  inputLead.disabled = isRunning;
}

// ─── Load initial state ────────────────────────────────────────────────────────
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
    leadMinutes: parseIntClamped(inputLead.value, 0, 60, 2)
  };

  console.log('[MatchOpener] Starting with leadMinutes:', scheduleSettings.leadMinutes);
  chrome.runtime.sendMessage({ action: 'start', scheduleSettings });
});

// ─── Button: Reset ────────────────────────────────────────────────────────────
btnReset.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'reset' });
});
