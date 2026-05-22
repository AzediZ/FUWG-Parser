import { readHoi4SaveFile, parseSnapshot, buildTimeline } from './parser.js';
import { makeExportZip } from './zip.js';

const els = {
  selectFolderBtn: document.getElementById('selectFolderBtn'),
  parseBtn: document.getElementById('parseBtn'),
  watchBtn: document.getElementById('watchBtn'),
  downloadBtn: document.getElementById('downloadBtn'),
  clearBtn: document.getElementById('clearBtn'),
  latestDateOverride: document.getElementById('latestDateOverride'),
  watchNewOnlyBtn: document.getElementById('watchNewOnlyBtn'),
  fileFallback: document.getElementById('fileFallback'),
  folderFallback: document.getElementById('folderFallback'),
  pollSeconds: document.getElementById('pollSeconds'),
  log: document.getElementById('log'),
  saveCount: document.getElementById('saveCount'),
  snapshotCount: document.getElementById('snapshotCount'),
  stateCount: document.getElementById('stateCount'),
  carryCount: document.getElementById('carryCount')
};

let dirHandle = null;
let fallbackFiles = [];
let seen = new Map();
let parsed = new Map();
let latestZipBlob = null;
let watchTimer = null;
let parseDiagnostics = [];

function log(msg) {
  els.log.textContent += msg + '\n';
  els.log.scrollTop = els.log.scrollHeight;
}
function setStats(diag = {}) {
  els.snapshotCount.textContent = diag.snapshots ?? 0;
  els.stateCount.textContent = diag.states ?? 0;
  els.carryCount.textContent = diag.carriedForwardControllers ?? 0;
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
function clearCapturedData() {
  parsed.clear();
  parseDiagnostics = [];
  latestZipBlob = null;
  els.downloadBtn.disabled = true;
  setStats({ snapshots: 0, states: 0, carriedForwardControllers: 0 });
  log('[INFO] Cleared captured snapshots/diagnostics. Existing seen-file markers were kept, so watch mode will still ignore saves that were already present.');
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
  els.parseBtn.disabled = false;
  // Keep watch buttons clickable so they never appear broken/greyed out; handlers validate source support.
  els.watchBtn.disabled = false;
  els.watchNewOnlyBtn.disabled = false;
  els.downloadBtn.disabled = true;
  log(`Selected live folder: ${dirHandle.name}`);
  log('[INFO] Live watch is available for this folder.');
}

async function collectFilesFromFolder() {
  if (!dirHandle) return [];
  const files = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind !== 'file') continue;
    if (!/\.hoi4$/i.test(name)) continue;
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
      continue;
    }
    const snap = read.snapshot || parseSnapshot(read.text, file.name, read.dateHint || null);
    if (!snap.ok) {
      skipped++;
      parseDiagnostics.push({ file: file.name, stage: 'parse', reason: snap.reason, source: read.source, diagnostics: snap.diagnostics, binaryDiagnostics: read.binaryDiagnostics });
      log(`[WARN] Skipped ${file.name} (${snap.reason}, source=${read.source})`);
      if (snap.diagnostics?.candidates?.length) log(`[INFO] Binary candidates: ${snap.diagnostics.candidates.slice(0,3).map(c => `${c.key}:${c.count}`).join(', ')}`);
      continue;
    }
    const parsedKey = snap.date ? `${snap.date}:${file.name}` : sig;
    parsed.set(parsedKey, snap);
    parseDiagnostics.push({ file: file.name, key: parsedKey, stage: 'parsed', source: read.source, date: snap.date || null, states: Object.keys(snap.states).length, binaryFallback: !!snap.binaryFallback, diagnostics: snap.diagnostics, binaryDiagnostics: read.binaryDiagnostics });
    log(`[OK] Parsed ${file.name}${snap.date ? ' -> ' + snap.date : ''} (${Object.keys(snap.states).length} states, source=${read.source}${snap.binaryFallback ? ', inferred binary state blocks' : ''})`);
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
    parserVersion: 'v17',
    ...timeline.diagnostics,
    dateOverride,
    parsedFiles: parseDiagnostics.filter(d => d.stage === 'parsed').map(d => d.file),
    parseDiagnostics
  };
  latestZipBlob = await makeExportZip({
    game: { title: 'Game Log Export', generatedAt: diagnostics.generatedAt },
    snapshots: timeline.snapshots,
    stateControllerTimeline: timeline.stateControllerTimeline,
    diagnostics
  });
  els.downloadBtn.disabled = timeline.snapshots.length === 0 && parseDiagnostics.length === 0;
  setStats(timeline.diagnostics);
  log(`[OK] Updated export: ${timeline.diagnostics.snapshots} snapshots, ${timeline.diagnostics.states} states, ${timeline.diagnostics.carriedForwardControllers} carried-forward controllers.`);
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

function toggleWatch() {
  if (!dirHandle) {
    log('[WARN] Live watching needs the Chrome/Edge folder picker. Click “Select save folder” and allow folder access, or host this repo on GitHub Pages/localhost. Manual fallback files can be parsed, but cannot be live-watched.');
    return;
  }
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
    els.watchBtn.textContent = 'Start watching';
    log('Watch mode stopped.');
    return;
  }
  const seconds = Math.max(2, Number(els.pollSeconds.value) || 5);
  els.watchBtn.textContent = 'Stop watching';
  log(`Watch mode started. Checking every ${seconds} seconds.`);
  tickWatch();
  watchTimer = setInterval(tickWatch, seconds * 1000);
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
els.watchBtn.addEventListener('click', () => toggleWatch());
els.watchNewOnlyBtn.addEventListener('click', async () => {
  try {
    if (!dirHandle) {
      log('[WARN] Select a save folder first.');
      return;
    }
    await markExistingAsSeen();
    if (!watchTimer) toggleWatch();
  } catch (e) {
    log('[ERROR] ' + e.message);
  }
});
els.downloadBtn.addEventListener('click', downloadZip);
els.clearBtn.addEventListener('click', clearCapturedData);
els.latestDateOverride.addEventListener('change', () => {
  if (parsed.size) updateExport().catch(e => log('[ERROR] ' + e.message));
});
els.fileFallback.addEventListener('change', async (e) => {
  els.log.textContent = '';
  log('[INFO] Version v17 save-menu date fix loaded.');
  fallbackFiles = [...e.target.files].filter(f => /\.hoi4$/i.test(f.name)).sort((a,b)=>a.name.localeCompare(b.name));
  dirHandle = null;
  seen.clear();
  parsed.clear();
  parseDiagnostics = [];
  latestZipBlob = null;
  els.parseBtn.disabled = fallbackFiles.length === 0;
  els.watchBtn.disabled = false;
  els.watchNewOnlyBtn.disabled = false;
  els.downloadBtn.disabled = true;
  log(`Selected ${fallbackFiles.length} save file(s) manually.`);
});

els.folderFallback.addEventListener('change', async (e) => {
  els.log.textContent = '';
  log('[INFO] Version v17 save-menu date fix loaded.');
  fallbackFiles = [...e.target.files].filter(f => /\.hoi4$/i.test(f.name)).sort((a,b)=>a.name.localeCompare(b.name));
  dirHandle = null;
  seen.clear();
  parsed.clear();
  parseDiagnostics = [];
  latestZipBlob = null;
  els.parseBtn.disabled = fallbackFiles.length === 0;
  els.watchBtn.disabled = false;
  els.watchNewOnlyBtn.disabled = false;
  els.downloadBtn.disabled = true;
  log(`Selected ${fallbackFiles.length} save file(s) from folder fallback.`);
  log('[INFO] Folder fallback can parse the selected files, but browsers do not refresh this selection as new autosaves appear. Use GitHub Pages/localhost with Chrome/Edge for live watching.');
});
