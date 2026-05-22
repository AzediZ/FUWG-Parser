import { readHoi4SaveFile, parseSnapshot, buildTimeline } from './parser.js';
import { makeExportZip } from './zip.js';

const els = {
  selectFolderBtn: document.getElementById('selectFolderBtn'),
  parseBtn: document.getElementById('parseBtn'),
  watchBtn: document.getElementById('watchBtn'),
  downloadBtn: document.getElementById('downloadBtn'),
  fileFallback: document.getElementById('fileFallback'),
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

async function selectFolder() {
  els.log.textContent = '';
  if (!window.showDirectoryPicker) {
    log('[WARN] Folder selection is not supported in this browser. Use Chrome/Edge or the manual file fallback.');
    return;
  }
  dirHandle = await window.showDirectoryPicker({ mode: 'read' });
  fallbackFiles = [];
  seen.clear();
  parsed.clear();
  parseDiagnostics = [];
  latestZipBlob = null;
  els.parseBtn.disabled = false;
  els.watchBtn.disabled = false;
  els.downloadBtn.disabled = true;
  log(`Selected folder: ${dirHandle.name}`);
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
    const snap = parseSnapshot(read.text, file.name);
    if (!snap.ok) {
      skipped++;
      parseDiagnostics.push({ file: file.name, stage: 'parse', reason: snap.reason, source: read.source, diagnostics: snap.diagnostics, binaryDiagnostics: read.binaryDiagnostics });
      log(`[WARN] Skipped ${file.name} (${snap.reason}, source=${read.source})`);
      if (snap.diagnostics?.candidates?.length) log(`[INFO] Binary candidates: ${snap.diagnostics.candidates.slice(0,3).map(c => `${c.key}:${c.count}`).join(', ')}`);
      continue;
    }
    parsed.set(file.name, snap);
    parseDiagnostics.push({ file: file.name, stage: 'parsed', source: read.source, states: Object.keys(snap.states).length, binaryFallback: !!snap.binaryFallback, diagnostics: snap.diagnostics, binaryDiagnostics: read.binaryDiagnostics });
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
  const diagnostics = {
    generatedAt: new Date().toISOString(),
    source: 'HOI4 Game Log Parser Web',
    ...timeline.diagnostics,
    parsedFiles: [...parsed.keys()].sort(),
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
}

async function parseNow() {
  const files = dirHandle ? await collectFilesFromFolder() : fallbackFiles;
  await parseFiles(files, false);
}

async function tickWatch() {
  const files = await collectFilesFromFolder();
  await parseFiles(files, true);
}

function toggleWatch() {
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
els.downloadBtn.addEventListener('click', downloadZip);
els.fileFallback.addEventListener('change', async (e) => {
  els.log.textContent = '';
  fallbackFiles = [...e.target.files].filter(f => /\.hoi4$/i.test(f.name)).sort((a,b)=>a.name.localeCompare(b.name));
  dirHandle = null;
  seen.clear();
  parsed.clear();
  parseDiagnostics = [];
  latestZipBlob = null;
  els.parseBtn.disabled = fallbackFiles.length === 0;
  els.watchBtn.disabled = true;
  els.downloadBtn.disabled = true;
  log(`Selected ${fallbackFiles.length} save file(s) manually.`);
});
