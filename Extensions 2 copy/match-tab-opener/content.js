// ─── URL Guard ────────────────────────────────────────────────────────────────
// Belt-and-suspenders: abort immediately if not on an allowed khelguru777.com page.
{
  const { hostname, pathname } = location;
  if (
    hostname !== 'www.khelguru777.com' ||
    !(pathname === '/' || pathname === '' || pathname === '/sport')
  ) {
    throw new Error('[MatchOpener] Aborted — not on an allowed page.');
  }
}

// ─── State ────────────────────────────────────────────────────────────────────
let loginInProgress = false;
let currentLeadMinutes = 2;

// Tracks URLs already opened this session — cleared on stop.
// Using a Set for O(1) duplicate detection.
const openedMatchUrls = new Set();

// Cached Table Tennis button — invalidated when detached from the DOM.
let _tableTennisBtn = null;

// ─── Utility ──────────────────────────────────────────────────────────────────
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isLoggedIn() {
  const el = document.querySelector('.username-info.d-none-mobile .username');
  return !!el && el.textContent.trim() === 'cs40pkg7';
}

function log(text) {
  console.log('[MatchOpener]', text);
  chrome.runtime.sendMessage({ action: 'log', text }).catch(() => { });
}

function formatTime(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// ─── Table Tennis Tab ─────────────────────────────────────────────────────────
function getTableTennisBtn() {
  if (_tableTennisBtn && !document.contains(_tableTennisBtn)) _tableTennisBtn = null;
  if (!_tableTennisBtn) {
    _tableTennisBtn = Array.from(
      document.querySelectorAll('#home_sports_list .nav-link span')
    ).find(s => s.textContent.trim() === 'Table Tennis')?.closest('a') ?? null;
  }
  return _tableTennisBtn;
}

// Ensures the Table Tennis tab is active. Does NOT start any schedule.
async function clickTableTennis() {
  const btn = getTableTennisBtn();
  if (!btn) {
    log('Table Tennis tab not found.');
    return;
  }
  if (btn.classList.contains('active')) {
    log('Table Tennis tab already active.');
    return;
  }

  btn.click();
  log('Table Tennis tab clicked.');
  await delay(1000);

  if (getTableTennisBtn()?.classList.contains('active')) {
    log('Table Tennis tab confirmed active.');
  } else {
    log('Table Tennis tab did not become active.');
  }
}

// ─── Upcoming Match Scanner ───────────────────────────────────────────────────
// Called on every 10-second alarm tick (when logged in).
// Reads all match time blocks from the DOM, computes how far away each match is,
// and opens a tab for any match that falls within the lead window and hasn't
// been opened yet this session.
//
//   leadMs = leadMinutes × 60,000 ms
//   condition: 0 ≤ (matchTime − now) ≤ leadMs
//
// Example: leadMinutes=2, now=16:28:10
//   match at 16:30 → diff ≈ 110 s ≤ 120 s → OPEN ✓
//   match at 16:31 → diff ≈ 170 s > 120 s → skip (caught next tick)
//   match at 16:27 → diff < 0             → skip (already started)
function openUpcomingMatches(leadMinutes) {
  const leadMs = leadMinutes * 60_000;
  const now = Date.now();
  const blocks = document.querySelectorAll('.game-date');

  for (const block of blocks) {
    const ps = block.querySelectorAll('p');
    if (ps.length < 2) continue; // live match rows have no time <p>

    const timeStr = ps[1].textContent.trim(); // e.g. "16:30"
    const [hStr, mStr] = timeStr.split(':');
    const h = parseInt(hStr, 10);
    const m = parseInt(mStr, 10);
    if (isNaN(h) || isNaN(m)) continue;

    // Build a Date for this match time today.
    const matchDate = new Date();
    matchDate.setHours(h, m, 0, 0);
    const diff = matchDate.getTime() - now;

    // Within lead window and not yet opened.
    if (diff >= 0 && diff <= leadMs) {
      const row = block.closest('.game-title');
      const link = row?.querySelector('a[href*="/sport/game/"]');
      if (link && !openedMatchUrls.has(link.href)) {
        openedMatchUrls.add(link.href);
        chrome.runtime.sendMessage({ action: 'openTab', url: link.href }).catch(() => { });
        log(`Opening match at ${timeStr} (starts in ~${Math.ceil(diff / 60_000)} min): ${link.href}`);
      }
    }
  }
}

// ─── Login Flow ───────────────────────────────────────────────────────────────
function fillInput(el, value) {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function startLoginFlow() {
  if (loginInProgress) return;
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

  // Step 4: wait 2 s then navigate to Table Tennis tab
  await delay(2000);
  await clickTableTennis();

  // Step 5: immediately run the match scanner so we don't wait 10 s for the next alarm
  openUpcomingMatches(currentLeadMinutes);

  loginInProgress = false;
}

// ─── Message Listener ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(message => {
  if (message.action === 'checkLogin') {
    // Update current lead setting on every tick.
    if (message.leadMinutes != null) currentLeadMinutes = message.leadMinutes;

    if (isLoggedIn()) {
      chrome.runtime.sendMessage({ action: 'alreadyLoggedIn' }).catch(() => { });

      // Ensure Table Tennis tab is active, then scan for upcoming matches.
      const btn = getTableTennisBtn();
      if (btn && !btn.classList.contains('active')) {
        // Navigate to TT tab first, then scan after it activates.
        clickTableTennis().then(() => openUpcomingMatches(currentLeadMinutes));
      } else {
        openUpcomingMatches(currentLeadMinutes);
      }
    } else {
      startLoginFlow();
    }
    return;
  }

  if (message.action === 'stopScanner') {
    openedMatchUrls.clear();
    log('Match scanner stopped. Opened URL cache cleared.');
  }
});
