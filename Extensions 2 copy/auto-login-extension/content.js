// ─── URL Guard ────────────────────────────────────────────────────────────────
// Primary enforcement: manifest.json content_scripts.matches + background.js
// isAllowedUrl() checks. This is a secondary safety net that prevents the
// script from initialising if somehow injected onto a non-allowed page.
{
  const { hostname, pathname } = location;
  if (
    hostname !== 'www.khelguru777.com' ||
    !(pathname === '/' || pathname === '' || pathname === '/sport')
  ) {
    throw new Error('[AutoLogin] Aborted — not on an allowed page.');
  }
}

// ─── State ────────────────────────────────────────────────────────────────────
let loginInProgress = false;
let scheduleRunning = false;
let scheduleTimeoutId = null;
let currentSettings = null; // { startTime, intervalMinutes, leadMinutes }

// Cached Table Tennis button — invalidated when detached from the DOM.
let _tableTennisBtn = null;

// ─── Utility ──────────────────────────────────────────────────────────────────
// Promisified delay — replaces nested setTimeout chains with readable async/await.
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isLoggedIn() {
  const el = document.querySelector('.username-info.d-none-mobile .username');
  return !!el && el.textContent.trim() === 'cs40pkg7';
}

// Fire-and-forget log — never blocks content-script execution.
function log(text) {
  console.log('[AutoLogin]', text);
  chrome.runtime.sendMessage({ action: 'log', text }).catch(() => { });
}

function formatTime(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// ─── Compute Next Match Slot (rolling schedule) ───────────────────────────────
// e.g. startTime=08:00, interval=30, now=15:03 → 15:30 (NOT tomorrow 08:00)
function computeNextMatchTime(startTime, intervalMinutes) {
  const [h, m] = startTime.split(':').map(Number);
  const intervalMs = intervalMinutes * 60_000;
  const now = new Date();
  const anchor = new Date(now);
  anchor.setHours(h, m, 0, 0);

  if (anchor > now) return anchor; // still in the future today

  const stepsPast = Math.floor((now - anchor) / intervalMs);
  return new Date(anchor.getTime() + (stepsPast + 1) * intervalMs);
}

// ─── Open Matches by Time ─────────────────────────────────────────────────────
// Collects all match URLs for the target time slot and sends them in a batch.
// Uses for…of on NodeList / Set — avoids callback closure overhead of forEach.
function openMatchesByTime(targetTime) {
  const blocks = document.querySelectorAll('.game-date');
  const hrefs = new Set();

  for (const block of blocks) {
    const ps = block.querySelectorAll('p');
    if (ps.length < 2) continue; // live-match rows have no time <p>
    if (ps[1].textContent.trim() !== targetTime) continue;

    const row = block.closest('.game-title');
    const link = row?.querySelector('a[href*="/sport/game/"]');
    if (link) hrefs.add(link.href);
  }

  if (hrefs.size === 0) {
    log(`No matches found at ${targetTime}`);
    return;
  }

  for (const url of hrefs) {
    chrome.runtime.sendMessage({ action: 'openTab', url }).catch(() => { });
  }
  log(`Opened ${hrefs.size} match(es) at ${targetTime}`);
}

// ─── Match Schedule ───────────────────────────────────────────────────────────
function startMatchSchedule(startTime, intervalMinutes, leadMinutes) {
  if (scheduleRunning) return; // idempotent
  scheduleRunning = true;
  log(`Schedule started — every ${intervalMinutes}min from ${startTime}, ${leadMinutes}min early.`);

  const intervalMs = intervalMinutes * 60_000;
  const leadMs = leadMinutes * 60_000;
  let matchTime = computeNextMatchTime(startTime, intervalMinutes);

  function scheduleNext() {
    const triggerTime = new Date(matchTime.getTime() - leadMs);
    const delay_ms = Math.max(triggerTime.getTime() - Date.now(), 0);
    log(`Next trigger at ${formatTime(triggerTime)} for matches at ${formatTime(matchTime)}`);
    scheduleTimeoutId = setTimeout(runOnce, delay_ms);
  }

  function runOnce() {
    openMatchesByTime(formatTime(matchTime));
    matchTime = new Date(matchTime.getTime() + intervalMs);
    scheduleNext();
  }

  scheduleNext();
}

function startScheduleIfNeeded() {
  if (!currentSettings || scheduleRunning) return;
  const { startTime, intervalMinutes, leadMinutes } = currentSettings;
  startMatchSchedule(startTime, intervalMinutes, leadMinutes);
}

function stopSchedule() {
  if (scheduleTimeoutId !== null) {
    clearTimeout(scheduleTimeoutId);
    scheduleTimeoutId = null;
  }
  if (scheduleRunning) {
    scheduleRunning = false;
    log('Match schedule stopped.');
  }
}

// ─── Table Tennis Tab ─────────────────────────────────────────────────────────
function getTableTennisBtn() {
  // Invalidate cache if the element has been detached from the live DOM.
  if (_tableTennisBtn && !document.contains(_tableTennisBtn)) _tableTennisBtn = null;
  if (!_tableTennisBtn) {
    // Prefer a direct attribute-based selector to avoid full querySelectorAll.
    _tableTennisBtn = Array.from(
      document.querySelectorAll('#home_sports_list .nav-link span')
    ).find(s => s.textContent.trim() === 'Table Tennis')?.closest('a') ?? null;
  }
  return _tableTennisBtn;
}

async function clickTableTennis() {
  const btn = getTableTennisBtn();

  if (!btn) {
    log('Table Tennis tab not found.');
    loginInProgress = false;
    return;
  }

  // Already active — start schedule immediately without an extra click.
  if (btn.classList.contains('active')) {
    log('Table Tennis tab already active.');
    startScheduleIfNeeded();
    loginInProgress = false;
    return;
  }

  btn.click();
  log('Table Tennis tab clicked.');

  // Wait 1 s then confirm the tab became active.
  await delay(1000);
  const confirmed = getTableTennisBtn();
  if (confirmed?.classList.contains('active')) {
    log('Table Tennis tab confirmed active.');
    startScheduleIfNeeded();
  } else {
    log('Table Tennis tab did not become active.');
  }
  loginInProgress = false;
}

// ─── Login Flow ───────────────────────────────────────────────────────────────
function fillInput(el, value) {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function startLoginFlow() {
  if (loginInProgress) return; // guard — skip if already running
  loginInProgress = true;

  chrome.runtime.sendMessage({ action: 'loginStarted' }).catch(() => { });

  const usernameInput = document.querySelector(
    '.d-none-mobile input[type="text"][placeholder="Username*"]'
  );
  if (!usernameInput) {
    log('Username field not found.');
    loginInProgress = false;
    return;
  }
  fillInput(usernameInput, 'cs40pkg7');

  const passwordInput = document.querySelector(
    '.d-none-mobile input[type="password"][placeholder="Password*"]'
  );
  if (!passwordInput) {
    log('Password field not found.');
    loginInProgress = false;
    return;
  }
  fillInput(passwordInput, '@2a4aikmpz8LY');

  const checkbox = document.querySelector('#customCheck');
  if (checkbox && !checkbox.checked) {
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Step 1: wait 1 s then click Login button
  await delay(1000);
  const loginBtn = document.querySelector('.d-none-mobile button[type="submit"]');
  if (!loginBtn) {
    log('Login button not found.');
    loginInProgress = false;
    return;
  }
  loginBtn.removeAttribute('disabled');
  loginBtn.click();
  log('Login button clicked.');

  // Step 2: wait 2 s then verify login
  await delay(2000);
  const success = isLoggedIn();
  chrome.runtime.sendMessage({ action: 'loginVerified', success }).catch(() => { });

  if (!success) {
    log('Login failed. Username not found or does not match.');
    loginInProgress = false;
    return;
  }

  log('Login successful!');

  // Step 3: wait 2 s then close modal
  await delay(2000);
  document.querySelector('.close-home-modal')?.click();

  // Step 4: wait 2 s then click Table Tennis tab
  await delay(2000);
  await clickTableTennis();
}

// ─── Message Listener ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(message => {
  if (message.action === 'checkLogin') {
    if (message.scheduleSettings) currentSettings = message.scheduleSettings;

    if (isLoggedIn()) {
      chrome.runtime.sendMessage({ action: 'alreadyLoggedIn' }).catch(() => { });
      clickTableTennis();
    } else {
      startLoginFlow();
    }
    return; // no sendResponse needed
  }

  if (message.action === 'stopSchedule') {
    stopSchedule();
  }
});
