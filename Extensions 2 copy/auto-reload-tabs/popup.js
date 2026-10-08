// ─── Elements ─────────────────────────────────────────────────────────────────
const statusBlock  = document.getElementById('statusBlock');
const statusText   = document.getElementById('statusText');
const mainTabTitle = document.getElementById('mainTabTitle');
const btnStartStop = document.getElementById('btnStartStop');
const btnActionText = document.getElementById('btnActionText');

let running = false;

// ─── Render State ─────────────────────────────────────────────────────────────
function renderState(isEnabled, mainTitle) {
  running = isEnabled;

  // Status badge
  statusBlock.className = 'status-badge ' + (isEnabled ? 'active' : 'paused');
  statusText.textContent = isEnabled ? 'Active' : 'Idle';

  // Main tab title
  mainTabTitle.textContent = mainTitle || 'Not recorded';

  // Button
  btnStartStop.className = 'btn-action ' + (isEnabled ? 'btn-stop' : 'btn-start');
  btnActionText.textContent = isEnabled ? 'Stop' : 'Start';
}

// ─── Load initial state ────────────────────────────────────────────────────────
chrome.runtime.sendMessage({ type: 'GET_STATUS' }, response => {
  if (response?.success) {
    renderState(response.isEnabled, response.mainTabTitle);
  }
});

// ─── Live updates via storage change ──────────────────────────────────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'isEnabled' in changes) {
    // Re-fetch full status to get updated mainTabTitle
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, response => {
      if (response?.success) renderState(response.isEnabled, response.mainTabTitle);
    });
  }
});

// ─── Button: Start / Stop ─────────────────────────────────────────────────────
btnStartStop.addEventListener('click', () => {
  const type = running ? 'STOP' : 'START';
  // Optimistically update UI while the background processes the request
  renderState(!running, mainTabTitle.textContent);
  chrome.runtime.sendMessage({ type }, response => {
    if (response?.success) {
      renderState(response.isEnabled, mainTabTitle.textContent);
      // Re-fetch main tab title (only available after START records it)
      if (response.isEnabled) {
        chrome.runtime.sendMessage({ type: 'GET_STATUS' }, r => {
          if (r?.success) renderState(r.isEnabled, r.mainTabTitle);
        });
      }
    }
  });
});
