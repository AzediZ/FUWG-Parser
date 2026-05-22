import { buildOutputFiles, parseFileToRawSnapshot } from './parser.js';
import { downloadBlob, makeZip } from './zip.js';

const el = {
  gameTitle: document.getElementById('gameTitle'),
  watchSeconds: document.getElementById('watchSeconds'),
  pickFolderBtn: document.getElementById('pickFolderBtn'),
  fallbackFiles: document.getElementById('fallbackFiles'),
  parseNowBtn: document.getElementById('parseNowBtn'),
  startWatchBtn: document.getElementById('startWatchBtn'),
  stopWatchBtn: document.getElementById('stopWatchBtn'),
  downloadBtn: document.getElementById('downloadBtn'),
  clearBtn: document.getElementById('clearBtn'),
  saveCount: document.getElementById('saveCount'),
  snapshotCount: document.getElementById('snapshotCount'),
  stateCount: document.getElementById('stateCount'),
  carryCount: document.getElementById('carryCount'),
  watchBadge: document.getElementById('watchBadge'),
  log: document.getElementById('log')
};

let directoryHandle = null;
let fallbackFileList = [];
let fileMeta = new Map();
let rawByPath = new Map();
let outputFiles = null;
let watchTimer = null;
let pollRunning = false;
let orderCounter = 0;

function clearLog(message = '') {
  el.log.textContent = message;
}

function log(message, level = '') {
  const prefix = level ? `[${level.toUpperCase()}] ` : '';
  el.log.textContent += `${el.log.textContent ? '\n' : ''}${prefix}${message}`;
  el.log.scrollTop = el.log.scrollHeight;
}

function isSaveLike(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tmp')) return false;
  return lower.endsWith('.hoi4') || lower.endsWith('.txt') || lower.endsWith('.log') || lower.endsWith('.json');
}

function updateButtons() {
  const hasSource = Boolean(directoryHandle) || fallbackFileList.length > 0;
  const watching = Boolean(watchTimer);
  el.parseNowBtn.disabled = !hasSource || watching;
  el.startWatchBtn.disabled = !directoryHandle || watching;
  el.stopWatchBtn.disabled = !watching;
  el.downloadBtn.disabled = !outputFiles;
  el.watchBadge.textContent = watching ? 'Watching save folder' : 'Not watching';
  el.watchBadge.classList.toggle('live', watching);
}

function refreshOutput() {
  const rawSnapshots = [...rawByPath.values()];
  const built = buildOutputFiles({
    title: el.gameTitle.value.trim() || 'HOI4 Game Log',
    rawSnapshots
  });
  outputFiles = rawSnapshots.length ? built.files : null;
  el.saveCount.textContent = String(rawSnapshots.length);
  el.snapshotCount.textContent = String(built.summary.snapshotCount);
  el.stateCount.textContent = String(built.summary.stateCount);
  el.carryCount.textContent = String(built.summary.carriedForward);
  updateButtons();
  return built.summary;
}

async function* walkDirectory(handle, prefix = '') {
  for await (const [name, child] of handle.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (child.kind === 'file') {
      if (isSaveLike(path)) {
        const file = await child.getFile();
        yield { file, path };
      }
    } else if (child.kind === 'directory') {
      yield* walkDirectory(child, path);
    }
  }
}

async function collectDirectoryFiles() {
  const files = [];
  if (!directoryHandle) return files;
  for await (const entry of walkDirectory(directoryHandle)) files.push(entry);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

async function parseEntries(entries, { onlyChanged = false } = {}) {
  let parsed = 0;
  let skipped = 0;
  let unchanged = 0;

  for (const entry of entries) {
    const { file, path } = entry;
    const sig = `${file.size}:${file.lastModified}`;
    if (onlyChanged && fileMeta.get(path) === sig) {
      unchanged++;
      continue;
    }

    fileMeta.set(path, sig);
    const raw = await parseFileToRawSnapshot(file, path, orderCounter++);
    if (raw.skipped) {
      skipped++;
      log(`Skipped ${path} (${raw.reason})`, 'warn');
      continue;
    }

    rawByPath.set(path, raw);
    parsed++;
    log(`Parsed ${path}: ${raw.date}, ${Object.keys(raw.partialStates || {}).length} states`);
  }

  const summary = refreshOutput();
  if (parsed || skipped) {
    log(`Updated export: ${summary.snapshotCount} snapshots, ${summary.stateCount} states, ${summary.carriedForward} carried-forward controllers.`, 'ok');
  } else if (unchanged && onlyChanged) {
    log(`Checked ${unchanged} file(s). No new or changed saves.`);
  }
}

async function parseNow() {
  try {
    el.parseNowBtn.disabled = true;
    if (directoryHandle) {
      log('Scanning selected folder...');
      const entries = await collectDirectoryFiles();
      log(`Found ${entries.length} save-like file(s).`);
      await parseEntries(entries, { onlyChanged: false });
    } else {
      const entries = fallbackFileList.map(file => ({ file, path: file.webkitRelativePath || file.name })).filter(e => isSaveLike(e.path));
      log(`Parsing ${entries.length} selected file(s).`);
      await parseEntries(entries, { onlyChanged: false });
    }
  } catch (err) {
    log(String(err && err.stack || err), 'bad');
  } finally {
    updateButtons();
  }
}

async function watchTick() {
  if (pollRunning || !directoryHandle) return;
  pollRunning = true;
  try {
    const entries = await collectDirectoryFiles();
    await parseEntries(entries, { onlyChanged: true });
  } catch (err) {
    log(String(err && err.stack || err), 'bad');
  } finally {
    pollRunning = false;
  }
}

el.pickFolderBtn.addEventListener('click', async () => {
  if (!('showDirectoryPicker' in window)) {
    log('This browser does not support live folder picking. Use Chrome or Edge, or use the fallback selector for one-off parsing.', 'warn');
    return;
  }

  try {
    directoryHandle = await window.showDirectoryPicker({ mode: 'read' });
    fallbackFileList = [];
    clearLog(`Selected folder: ${directoryHandle.name}`);
    updateButtons();
    await parseNow();
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    log(String(err && err.stack || err), 'bad');
  }
});

el.fallbackFiles.addEventListener('change', event => {
  fallbackFileList = Array.from(event.target.files || []);
  directoryHandle = null;
  clearLog(`Selected ${fallbackFileList.length} file(s) with fallback picker.`);
  updateButtons();
});

el.parseNowBtn.addEventListener('click', parseNow);

el.startWatchBtn.addEventListener('click', async () => {
  if (!directoryHandle || watchTimer) return;
  const seconds = Math.max(2, Math.min(60, Number(el.watchSeconds.value || 5)));
  log(`Watch mode started. Checking every ${seconds} seconds.`);
  await watchTick();
  watchTimer = setInterval(watchTick, seconds * 1000);
  updateButtons();
});

el.stopWatchBtn.addEventListener('click', () => {
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
  log('Watch mode stopped.');
  updateButtons();
});

el.downloadBtn.addEventListener('click', () => {
  if (!outputFiles) return;
  downloadBlob(makeZip(outputFiles), 'gamelog export.zip');
});

el.clearBtn.addEventListener('click', () => {
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
  directoryHandle = null;
  fallbackFileList = [];
  fileMeta = new Map();
  rawByPath = new Map();
  outputFiles = null;
  orderCounter = 0;
  el.fallbackFiles.value = '';
  clearLog('Session cleared. Select a HOI4 save folder to begin.');
  refreshOutput();
});

refreshOutput();
updateButtons();
