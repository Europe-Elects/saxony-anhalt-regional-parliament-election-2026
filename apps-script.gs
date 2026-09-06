/* Google Apps Script — bound to the Saxony-Anhalt sheet.
   Setup: Extensions > Apps Script, paste this, then
     - Project Settings > Script Properties: GITHUB_PAT = fine-grained PAT,
       this repo only, Contents: Read and write
     - Triggers > Add Trigger: handleSheetEdit, From spreadsheet, On edit
       (must be installable — a simple onEdit cannot call UrlFetchApp)
     - Run testDispatch once to accept the OAuth consent screen

   Saving the file is the deploy. Deploy > New deployment is for web apps and
   add-ons; an installable trigger always runs the current saved code, so that
   button does nothing here. */

const REPO = 'Europe-Elects/saxony-anhalt-regional-parliament-election-2026';
const DEBOUNCE_MS = 20000;

/* A deny-list on purpose, where this used to keep an allow-list of watched
   tabs. The allow-list failed silently and expensively: `demographic vote -
   Infratest` was wired into the pipeline but never added here, so editing it
   dispatched nothing. Those figures only reached the page when an analyst
   happened to touch some other tab — hours late, with nothing anywhere
   reporting a fault.

   A deny-list fails the cheap way round. Forget to list a tab and the worst
   case is one extra run that ends in "no data changes"; the pipeline already
   no-ops when a tab is unchanged. Add a tab below only if it is edited often
   AND feeds nothing on the page. */
const IGNORED = [
  'opening/closing',  // the team's shift roster, not page data
  'Copy of turnout',  // hidden duplicate of `turnout`, read by nothing
];

function handleSheetEdit(e) {
  if (!e || !e.range) return;
  if (IGNORED.indexOf(e.range.getSheet().getName()) !== -1) return;

  /* Whether we are inside the debounce window is a read-modify-write over one
     shared property, so it has to hold the lock. Without it two edits landing
     together both read the old timestamp, both find the window clear, and both
     dispatch — the twin runs in the same second seen on election night. */
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(10000);

  let windowClear = false;
  if (locked) {
    try {
      const props = PropertiesService.getScriptProperties();
      const now = Date.now();
      const last = Number(props.getProperty('lastDispatch') || 0);
      windowClear = now - last >= DEBOUNCE_MS;
      if (windowClear) props.setProperty('lastDispatch', String(now));
    } finally {
      lock.releaseLock();
    }
  }

  /* Dispatch outside the lock. The HTTP call takes about a second and holding
     the lock across it would queue every concurrent edit behind it. */
  if (windowClear) { dispatch(); return; }

  /* Either inside the window, or another execution held the lock. Both mean
     this edit might be the last of a burst, so make sure something fires after
     it rather than assuming the earlier dispatch covered it. */
  scheduleCatchUp();
}

function scheduleCatchUp() {
  const lock = LockService.getScriptLock();
  /* Waits as long as handleSheetEdit does: under a burst every execution wants
     this lock at once, and a short timeout drops catch-ups on the floor. */
  if (!lock.tryLock(10000)) return;
  try {
    if (pendingCatchUps().length) return;
    ScriptApp.newTrigger('catchUpDispatch').timeBased().after(60000).create();
  } finally {
    lock.releaseLock();
  }
}

function pendingCatchUps() {
  return ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'catchUpDispatch');
}

function catchUpDispatch() {
  pendingCatchUps().forEach(t => ScriptApp.deleteTrigger(t));
  PropertiesService.getScriptProperties().setProperty('lastDispatch', String(Date.now()));
  dispatch();
}

function dispatch() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_PAT');
  if (!token) throw new Error('GITHUB_PAT missing from Script Properties');

  /* No client_payload. The workflow does not read one, and a payload that is
     never read cannot be injected into a run step if this token ever leaks. */
  const res = UrlFetchApp.fetch('https://api.github.com/repos/' + REPO + '/dispatches', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },
    payload: JSON.stringify({ event_type: 'sheet-updated' }),
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  if (code !== 204) throw new Error('dispatch failed: HTTP ' + code + ' ' + res.getContentText());
  console.log('dispatched sheet-updated');
}

function testDispatch() {
  dispatch();
}
