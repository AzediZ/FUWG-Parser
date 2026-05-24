import { readHoi4SaveFile, parseSnapshot, buildTimeline } from './parser.js';
import { makeExportZip } from './zip.js';

const els = {
  selectFolderBtn: document.getElementById('selectFolderBtn'),
  parseBtn: document.getElementById('parseBtn'),
  watchBtn: document.getElementById('watchBtn'),
  downloadBtn: document.getElementById('downloadBtn'),
  clearBtn: document.getElementById('clearBtn'),
  wakeLockBtn: document.getElementById('wakeLockBtn'),
  wakeLockStatus: document.getElementById('wakeLockStatus'),
  latestDateOverride: document.getElementById('latestDateOverride'),
  watchNewOnlyBtn: document.getElementById('watchNewOnlyBtn'),
  fileFallback: document.getElementById('fileFallback'),
  folderFallback: document.getElementById('folderFallback'),
  pollSeconds: document.getElementById('pollSeconds'),
  log: document.getElementById('log'),
  saveCount: document.getElementById('saveCount'),
  snapshotCount: document.getElementById('snapshotCount'),
  stateCount: document.getElementById('stateCount'),
  provinceCount: document.getElementById('provinceCount'),
  carryCount: document.getElementById('carryCount'),
  recoveryPanel: document.getElementById('recoveryPanel'),
  recoveryStatus: document.getElementById('recoveryStatus'),
  recoverBtn: document.getElementById('recoverBtn'),
  discardRecoveryBtn: document.getElementById('discardRecoveryBtn')
};

let dirHandle = null;
let fallbackFiles = [];
let seen = new Map();
let parsed = new Map();
let latestZipBlob = null;
let watchTimer = null;
let wakeLock = null;
let wakeLockWanted = false;
let parseDiagnostics = [];


const RECOVERY_DB_NAME = 'hoi4-gamelog-parser-recovery-v1';
const RECOVERY_STORE = 'recovery';
const RECOVERY_KEY = 'latest-session';
let recoveryWriteTimer = null;

function openRecoveryDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is not available in this browser/context.'));
      return;
    }
    const request = indexedDB.open(RECOVERY_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECOVERY_STORE)) db.createObjectStore(RECOVERY_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open recovery database.'));
  });
}
function recoveryPut(value) {
  return openRecoveryDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(RECOVERY_STORE, 'readwrite');
    tx.objectStore(RECOVERY_STORE).put(value, RECOVERY_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not save recovery data.')); };
  }));
}
function recoveryGet() {
  return openRecoveryDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(RECOVERY_STORE, 'readonly');
    const req = tx.objectStore(RECOVERY_STORE).get(RECOVERY_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error('Could not read recovery data.'));
    tx.oncomplete = () => db.close();
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not read recovery data.')); };
  }));
}
function recoveryDelete() {
  return openRecoveryDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(RECOVERY_STORE, 'readwrite');
    tx.objectStore(RECOVERY_STORE).delete(RECOVERY_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not delete recovery data.')); };
  }));
}
function buildRecoveryPayload(reason = 'auto') {
  return {
    appVersion: 'v28-crash-recovery',
    savedAt: new Date().toISOString(),
    reason,
    parsedEntries: [...parsed.entries()],
    seenEntries: [...seen.entries()],
    parseDiagnostics
  };
}
async function persistRecovery(reason = 'auto') {
  if (!parsed.size && !parseDiagnostics.length) return;
  try {
    await recoveryPut(buildRecoveryPayload(reason));
    updateRecoveryPanel(await recoveryGet());
  } catch (e) {
    log('[WARN] Could not write crash-recovery checkpoint: ' + e.message);
  }
}
function scheduleRecoverySave(reason = 'auto') {
  clearTimeout(recoveryWriteTimer);
  recoveryWriteTimer = setTimeout(() => {
    persistRecovery(reason).catch(e => log('[WARN] Recovery save failed: ' + e.message));
  }, 250);
}
function updateRecoveryPanel(payload = null) {
  if (!els.recoveryPanel || !els.recoveryStatus) return;
  if (!payload || (!payload.parsedEntries?.length && !payload.parseDiagnostics?.length)) {
    els.recoveryPanel.hidden = true;
    els.recoveryStatus.textContent = 'No recovery checkpoint found.';
    return;
  }
  const savedAt = payload.savedAt ? new Date(payload.savedAt).toLocaleString() : 'unknown time';
  const snapshotCount = payload.parsedEntries?.length || 0;
  els.recoveryPanel.hidden = false;
  els.recoveryStatus.textContent = `Saved checkpoint found: ${snapshotCount} captured snapshot(s), saved ${savedAt}.`;
}
async function checkRecoveryOnLoad() {
  try {
    updateRecoveryPanel(await recoveryGet());
  } catch (e) {
    if (els.recoveryPanel && els.recoveryStatus) {
      els.recoveryPanel.hidden = false;
      els.recoveryStatus.textContent = 'Recovery storage is unavailable: ' + e.message;
    }
  }
}
async function recoverPreviousCapture() {
  const payload = await recoveryGet();
  if (!payload) {
    log('[INFO] No recovery checkpoint found.');
    updateRecoveryPanel(null);
    return;
  }
  parsed = new Map(payload.parsedEntries || []);
  seen = new Map(payload.seenEntries || []);
  parseDiagnostics = payload.parseDiagnostics || [];
  latestZipBlob = null;
  els.downloadBtn.disabled = true;
  log(`[OK] Recovered ${parsed.size} captured snapshot(s) from browser recovery storage.`);
  await updateExport();
  updateRecoveryPanel(payload);
}
async function discardRecovery() {
  await recoveryDelete();
  updateRecoveryPanel(null);
  log('[INFO] Deleted saved crash-recovery checkpoint.');
}

function log(msg) {
  els.log.textContent += msg + '\n';
  els.log.scrollTop = els.log.scrollHeight;
}
function setStats(diag = {}) {
  els.snapshotCount.textContent = diag.snapshots ?? 0;
  els.stateCount.textContent = diag.states ?? 0;
  if (els.provinceCount) els.provinceCount.textContent = diag.provinces ?? 0;
  els.carryCount.textContent = diag.carriedForwardControllers ?? 0;
}

function isAutosaveFileName(name) {
  // Only the rotating autosaves matter for live capture. This avoids repeatedly scanning
  // old manual saves in large save folders.
  return /^autosave(?:_\d+)?\.hoi4$/i.test(name);
}

function filterAutosaveFiles(files, context = 'folder') {
  const autosaves = files.filter(f => isAutosaveFileName(f.name));
  const ignored = files.length - autosaves.length;
  if (ignored > 0) log(`[INFO] Ignored ${ignored} non-autosave .hoi4 file(s) from ${context}.`);
  return autosaves;
}

function parseIsoDate(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}
function shiftIsoDate(value, offsetDays) {
  const dt = parseIsoDate(value);
  if (!dt || !Number.isFinite(offsetDays)) return value;
  dt.setUTCDate(dt.getUTCDate() + offsetDays);
  return dt.toISOString().slice(0, 10);
}
function applyLatestDateOverride(timeline) {
  const target = parseIsoDate(els.latestDateOverride.value);
  if (!target || !timeline.snapshots.length) return null;
  const dated = timeline.snapshots.filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s.date || ''));
  if (!dated.length) return null;
  const originalLastDate = dated[dated.length - 1].date;
  const originalLast = parseIsoDate(originalLastDate);
  const offsetDays = Math.round((target.getTime() - originalLast.getTime()) / 86400000);
  if (!Number.isFinite(offsetDays) || offsetDays === 0) {
    return { applied: offsetDays === 0, targetLatestDate: els.latestDateOverride.value, originalLastDate, offsetDays: 0 };
  }
  for (const snap of timeline.snapshots) snap.date = shiftIsoDate(snap.date, offsetDays);
  for (const entries of Object.values(timeline.stateControllerTimeline)) {
    for (const entry of entries) entry.date = shiftIsoDate(entry.date, offsetDays);
  }
  return { applied: true, targetLatestDate: els.latestDateOverride.value, originalLastDate, offsetDays };
}
function wakeLockSupported() {
  return 'wakeLock' in navigator && typeof navigator.wakeLock?.request === 'function';
}
function updateWakeLockUi() {
  if (!els.wakeLockBtn || !els.wakeLockStatus) return;
  if (!wakeLockSupported()) {
    els.wakeLockBtn.textContent = 'Keep screen awake: unavailable';
    els.wakeLockBtn.disabled = true;
    els.wakeLockStatus.textContent = 'Wake Lock API unavailable in this browser/context';
    return;
  }
  els.wakeLockBtn.disabled = false;
  els.wakeLockBtn.textContent = wakeLockWanted ? 'Keep screen awake: on' : 'Keep screen awake: off';
  els.wakeLockStatus.textContent = wakeLock ? 'Wake lock active' : (wakeLockWanted ? 'Wake lock requested; waiting for visible tab' : 'Wake lock not active');
}
async function requestWakeLock(reason = 'manual') {
  if (!wakeLockSupported()) {
    log('[WARN] Screen Wake Lock is not available in this browser/context. Use Chrome/Edge over HTTPS or localhost if possible.');
    updateWakeLockUi();
    return false;
  }
  wakeLockWanted = true;
  if (document.visibilityState !== 'visible') {
    log('[WARN] Wake lock can only be requested while the tab is visible. It will retry when the tab is visible again.');
    updateWakeLockUi();
    return false;
  }
  if (wakeLock) {
    updateWakeLockUi();
    return true;
  }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
      updateWakeLockUi();
      if (wakeLockWanted && document.visibilityState === 'visible') {
        log('[WARN] Screen wake lock was released by the browser. Retrying...');
        requestWakeLock('reacquire').catch(e => log('[WARN] Wake lock retry failed: ' + e.message));
      } else {
        log('[INFO] Screen wake lock released.');
      }
    });
    log(`[OK] Screen wake lock active (${reason}). Keep this tab visible while watching for best reliability.`);
    updateWakeLockUi();
    return true;
  } catch (e) {
    log('[WARN] Could not activate screen wake lock: ' + e.message);
    updateWakeLockUi();
    return false;
  }
}
async function releaseWakeLock(manual = false) {
  wakeLockWanted = false;
  if (wakeLock) {
    const lock = wakeLock;
    wakeLock = null;
    try { await lock.release(); } catch (_) {}
  }
  if (manual) log('[INFO] Screen wake lock turned off.');
  updateWakeLockUi();
}
function toggleWakeLock() {
  if (wakeLockWanted || wakeLock) releaseWakeLock(true);
  else requestWakeLock('manual toggle');
}

async function clearCapturedData() {
  parsed.clear();
  parseDiagnostics = [];
  latestZipBlob = null;
  els.downloadBtn.disabled = true;
  setStats({ snapshots: 0, states: 0, provinces: 0, carriedForwardControllers: 0 });
  try { await recoveryDelete(); updateRecoveryPanel(null); } catch (e) { log('[WARN] Could not delete recovery checkpoint: ' + e.message); }
  log('[INFO] Cleared captured snapshots/diagnostics and deleted the saved recovery checkpoint. Existing seen-file markers were kept, so watch mode will still ignore saves that were already present.');
}

async function selectFolder() {
  els.log.textContent = '';
  if (!window.showDirectoryPicker) {
    log('[WARN] Live folder watching is only available through the browser folder picker on Chrome/Edge over HTTPS or localhost.');
    log('[INFO] Opening the manual folder fallback instead. This can parse selected files, but it cannot live-watch new autosaves.');
    els.folderFallback.click();
    return;
  }
  dirHandle = await window.showDirectoryPicker({ mode: 'read' });
  fallbackFiles = [];
  seen.clear();
  parsed.clear();
  parseDiagnostics = [];
  latestZipBlob = null;
  try { await recoveryDelete(); updateRecoveryPanel(null); } catch (_) {}
  els.parseBtn.disabled = false;
  els.watchBtn.disabled = true;
  els.watchNewOnlyBtn.disabled = false;
  els.downloadBtn.disabled = true;
  log(`Selected live folder: ${dirHandle.name}`);
  log('[INFO] Live watch is available for this folder.');
  log('[INFO] Autosave-only mode is active: autosave.hoi4, autosave_1.hoi4, autosave_2.hoi4, etc. Non-autosave saves are ignored for speed.');
}

async function collectFilesFromFolder() {
  if (!dirHandle) return [];
  const files = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind !== 'file') continue;
    if (!/\.hoi4$/i.test(name)) continue;
    if (!isAutosaveFileName(name)) continue;
    const file = await handle.getFile();
    files.push(file);
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

async function parseFiles(files, onlyChanged = false) {
  log(onlyChanged ? `Checking ${files.length} file(s)...` : 'Scanning selected folder...');
  els.saveCount.textContent = files.length;
  let changed = 0;
  let skipped = 0;

  for (const file of files) {
    const sig = `${file.name}:${file.size}:${file.lastModified}`;
    if (onlyChanged && seen.get(file.name) === sig) continue;
    seen.set(file.name, sig);
    changed++;

    const read = await readHoi4SaveFile(file, log);
    if (!read.ok) {
      skipped++;
      parseDiagnostics.push({ file: file.name, stage: 'read', reason: read.reason });
      log(`[WARN] Skipped ${file.name} (${read.reason})`);
      scheduleRecoverySave('read-skip');
      continue;
    }
    const snap = read.snapshot || parseSnapshot(read.text, file.name, read.dateHint || null);
    if (!snap.ok) {
      skipped++;
      parseDiagnostics.push({ file: file.name, stage: 'parse', reason: snap.reason, source: read.source, diagnostics: snap.diagnostics, binaryDiagnostics: read.binaryDiagnostics });
      log(`[WARN] Skipped ${file.name} (${snap.reason}, source=${read.source})`);
      if (snap.diagnostics?.candidates?.length) log(`[INFO] Binary candidates: ${snap.diagnostics.candidates.slice(0,3).map(c => `${c.key}:${c.count}`).join(', ')}`);
      scheduleRecoverySave('parse-skip');
      continue;
    }
    const parsedKey = snap.date ? `${snap.date}:${file.name}` : sig;
    parsed.set(parsedKey, snap);
    parseDiagnostics.push({ file: file.name, key: parsedKey, stage: 'parsed', source: read.source, date: snap.date || null, states: Object.keys(snap.states || {}).length, provinces: Object.keys(snap.provinces || {}).length, provinceOverrides: Object.keys(snap.provinceOverrides || {}).length, binaryFallback: !!snap.binaryFallback, diagnostics: snap.diagnostics, binaryDiagnostics: read.binaryDiagnostics });
    log(`[OK] Parsed ${file.name}${snap.date ? ' -> ' + snap.date : ''} (${Object.keys(snap.states || {}).length} states, ${Object.keys(snap.provinces || {}).length} raw province override entries, source=${read.source}${snap.binaryFallback ? ', inferred binary blocks' : ''})`);
    scheduleRecoverySave('parsed-snapshot');
  }

  if (onlyChanged && changed === 0) {
    log(`Checked ${files.length} file(s). No new or changed saves.`);
    return;
  }

  await updateExport();
  if (skipped && parsed.size === 0) {
    log('[NOTE] No state snapshots were recovered yet. You can still download gamelog export.zip for diagnostics.');
  }
}

async function updateExport() {
  const timeline = buildTimeline([...parsed.values()]);
  const dateOverride = applyLatestDateOverride(timeline);
  if (dateOverride?.applied) log(`[INFO] Applied latest-date correction: ${dateOverride.originalLastDate} -> ${dateOverride.targetLatestDate} (${dateOverride.offsetDays >= 0 ? '+' : ''}${dateOverride.offsetDays} days).`);
  const diagnostics = {
    generatedAt: new Date().toISOString(),
    source: 'HOI4 Game Log Parser Web',
    parserVersion: 'v28-crash-recovery-full-province-snapshots-fuwg-states-wakelock',
    ...timeline.diagnostics,
    dateOverride,
    parsedFiles: parseDiagnostics.filter(d => d.stage === 'parsed').map(d => d.file),
    parseDiagnostics
  };
  latestZipBlob = await makeExportZip({
    game: { title: 'Game Log Export', generatedAt: diagnostics.generatedAt },
    snapshots: timeline.snapshots,
    stateControllerTimeline: timeline.stateControllerTimeline,
    provinceControllerTimeline: timeline.provinceControllerTimeline,
    provinceStateMap: timeline.provinceStateMap,
    diagnostics
  });
  els.downloadBtn.disabled = timeline.snapshots.length === 0 && parseDiagnostics.length === 0;
  setStats(timeline.diagnostics);
  log(`[OK] Updated export: ${timeline.diagnostics.snapshots} snapshots, ${timeline.diagnostics.states} states, ${timeline.diagnostics.provinces} effective provinces, ${timeline.diagnostics.rawProvinceOverrideTotal || 0} raw province override entries, ${timeline.diagnostics.carriedForwardControllers} carried-forward state controllers.`);
  scheduleRecoverySave('export-updated');
  if (timeline.snapshots.length) {
    const dates = timeline.snapshots.map(s => s.date || 'NO_DATE');
    const preview = dates.length <= 12 ? dates.join(', ') : `${dates.slice(0, 6).join(', ')} ... ${dates.slice(-6).join(', ')}`;
    log(`[INFO] Snapshot dates: ${preview}`);
  }
}

async function parseNow() {
  const files = dirHandle ? await collectFilesFromFolder() : fallbackFiles;
  await parseFiles(files, false);
}

async function tickWatch() {
  const files = await collectFilesFromFolder();
  await parseFiles(files, true);
}

async function markExistingAsSeen() {
  const files = await collectFilesFromFolder();
  els.saveCount.textContent = files.length;
  for (const file of files) {
    const sig = `${file.name}:${file.size}:${file.lastModified}`;
    seen.set(file.name, sig);
  }
  log(`[INFO] Ignoring ${files.length} existing save file(s). New/changed saves will be parsed from now on.`);
}

function startWatch() {
  if (!dirHandle) {
    log('[WARN] Live watching needs the Chrome/Edge folder picker. Click “Select save folder” and allow folder access, or host this repo on GitHub Pages/localhost. Manual fallback files can be parsed, but cannot be live-watched.');
    return;
  }
  if (watchTimer) {
    log('[INFO] Watch mode is already running.');
    return;
  }
  const seconds = Math.max(2, Number(els.pollSeconds.value) || 5);
  els.watchBtn.disabled = false;
  els.watchNewOnlyBtn.disabled = true;
  log(`Watch mode started. Checking every ${seconds} seconds.`);
  requestWakeLock('watch mode').catch(e => log('[WARN] Wake lock failed: ' + e.message));
  tickWatch();
  watchTimer = setInterval(tickWatch, seconds * 1000);
}

function stopWatch() {
  if (!watchTimer) {
    log('[INFO] Watch mode is not currently running.');
    els.watchBtn.disabled = true;
    if (dirHandle) els.watchNewOnlyBtn.disabled = false;
    return;
  }
  clearInterval(watchTimer);
  watchTimer = null;
  els.watchBtn.disabled = true;
  if (dirHandle) els.watchNewOnlyBtn.disabled = false;
  log('Watch mode stopped.');
  releaseWakeLock(false).catch(() => {});
}

function downloadZip() {
  if (!latestZipBlob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(latestZipBlob);
  a.download = 'gamelog export.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

els.selectFolderBtn.addEventListener('click', () => selectFolder().catch(e => log('[ERROR] ' + e.message)));
els.parseBtn.addEventListener('click', () => parseNow().catch(e => log('[ERROR] ' + e.message)));
els.watchBtn.addEventListener('click', () => stopWatch());
els.watchNewOnlyBtn.addEventListener('click', async () => {
  try {
    if (!dirHandle) {
      log('[WARN] Select a save folder first.');
      return;
    }
    await markExistingAsSeen();
    if (!watchTimer) startWatch();
  } catch (e) {
    log('[ERROR] ' + e.message);
  }
});
els.downloadBtn.addEventListener('click', downloadZip);
els.clearBtn.addEventListener('click', () => clearCapturedData().catch(e => log('[ERROR] ' + e.message)));
els.recoverBtn?.addEventListener('click', () => recoverPreviousCapture().catch(e => log('[ERROR] ' + e.message)));
els.discardRecoveryBtn?.addEventListener('click', () => discardRecovery().catch(e => log('[ERROR] ' + e.message)));
checkRecoveryOnLoad();
els.wakeLockBtn.addEventListener('click', toggleWakeLock);
document.addEventListener('visibilitychange', () => {
  if (wakeLockWanted && document.visibilityState === 'visible' && !wakeLock) {
    requestWakeLock('tab visible again').catch(e => log('[WARN] Wake lock reacquire failed: ' + e.message));
  } else {
    updateWakeLockUi();
  }
});
updateWakeLockUi();
els.latestDateOverride.addEventListener('change', () => {
  if (parsed.size) updateExport().catch(e => log('[ERROR] ' + e.message));
});
els.fileFallback.addEventListener('change', async (e) => {
  els.log.textContent = '';
  log('[INFO] Version v28 crash recovery + host checklist loaded.');
  fallbackFiles = filterAutosaveFiles([...e.target.files].filter(f => /\.hoi4$/i.test(f.name)), 'folder fallback').sort((a,b)=>a.name.localeCompare(b.name));
  dirHandle = null;
  seen.clear();
  parsed.clear();
  parseDiagnostics = [];
  latestZipBlob = null;
  els.parseBtn.disabled = fallbackFiles.length === 0;
  els.watchBtn.disabled = true;
  els.watchNewOnlyBtn.disabled = false;
  els.downloadBtn.disabled = true;
  log(`Selected ${fallbackFiles.length} save file(s) manually.`);
});

els.folderFallback.addEventListener('change', async (e) => {
  els.log.textContent = '';
  log('[INFO] Version v28 crash recovery + host checklist loaded.');
  fallbackFiles = filterAutosaveFiles([...e.target.files].filter(f => /\.hoi4$/i.test(f.name)), 'folder fallback').sort((a,b)=>a.name.localeCompare(b.name));
  dirHandle = null;
  seen.clear();
  parsed.clear();
  parseDiagnostics = [];
  latestZipBlob = null;
  els.parseBtn.disabled = fallbackFiles.length === 0;
  els.watchBtn.disabled = true;
  els.watchNewOnlyBtn.disabled = false;
  els.downloadBtn.disabled = true;
  log(`Selected ${fallbackFiles.length} save file(s) from folder fallback.`);
  log('[INFO] Folder fallback can parse the selected files, but browsers do not refresh this selection as new autosaves appear. Use GitHub Pages/localhost with Chrome/Edge for live watching.');
});
