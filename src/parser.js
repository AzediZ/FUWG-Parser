export const PARSER_VERSION = 'web-gamelog-parser-fixed-state-controller-v2-zip-saves';

const textDecoder = new TextDecoder('utf-8', { fatal: false });

function u16(view, offset) { return view.getUint16(offset, true); }
function u32(view, offset) { return view.getUint32(offset, true); }

export function parseDateFromText(text, fileName = '') {
  const saveDate = text.match(/(?:^|\s)date\s*=\s*"?(\d{4})\.(\d{1,2})\.(\d{1,2})"?/);
  if (saveDate) return `${saveDate[1]}-${saveDate[2].padStart(2, '0')}-${saveDate[3].padStart(2, '0')}`;

  const fileDate = fileName.match(/(\d{4})[._-](\d{1,2})[._-](\d{1,2})/);
  if (fileDate) return `${fileDate[1]}-${fileDate[2].padStart(2, '0')}-${fileDate[3].padStart(2, '0')}`;

  return null;
}

function bufferStartsWithZip(buffer) {
  if (buffer.byteLength < 4) return false;
  const view = new DataView(buffer);
  return u32(view, 0) === 0x04034b50;
}

export function looksBinaryText(text) {
  const sample = text.slice(0, 5000);
  let nul = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample.charCodeAt(i) === 0) nul++;
  }
  return nul > 5;
}

async function inflateRaw(bytes) {
  if (!('DecompressionStream' in globalThis)) {
    throw new Error('This browser cannot decompress zipped saves. Use current Chrome/Edge, or disable binary/compressed saves in HOI4 before hosting.');
  }

  const tryFormats = ['deflate-raw', 'deflate'];
  let lastError = null;

  for (const format of tryFormats) {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
      const result = await new Response(stream).arrayBuffer();
      return new Uint8Array(result);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Unable to decompress zip entry.');
}

function findEndOfCentralDirectory(view) {
  const min = Math.max(0, view.byteLength - 0xffff - 22);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (u32(view, i) === 0x06054b50) return i;
  }
  return -1;
}

async function unzipTextEntries(buffer) {
  const view = new DataView(buffer);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw new Error('Zip save has no central directory.');

  const entryCount = u16(view, eocd + 10);
  const centralOffset = u32(view, eocd + 16);
  let offset = centralOffset;
  const entries = [];

  for (let i = 0; i < entryCount && offset < view.byteLength; i++) {
    if (u32(view, offset) !== 0x02014b50) break;

    const method = u16(view, offset + 10);
    const compressedSize = u32(view, offset + 20);
    const uncompressedSize = u32(view, offset + 24);
    const nameLen = u16(view, offset + 28);
    const extraLen = u16(view, offset + 30);
    const commentLen = u16(view, offset + 32);
    const localOffset = u32(view, offset + 42);

    const nameBytes = new Uint8Array(buffer, offset + 46, nameLen);
    const name = textDecoder.decode(nameBytes);

    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }

  const output = [];

  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    if (entry.localOffset + 30 > view.byteLength) continue;
    if (u32(view, entry.localOffset) !== 0x04034b50) continue;

    const localNameLen = u16(view, entry.localOffset + 26);
    const localExtraLen = u16(view, entry.localOffset + 28);
    const dataStart = entry.localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > buffer.byteLength) continue;

    const compressed = new Uint8Array(buffer, dataStart, entry.compressedSize);
    let data;
    if (entry.method === 0) {
      data = compressed;
    } else if (entry.method === 8) {
      data = await inflateRaw(compressed);
    } else {
      continue;
    }

    output.push({ name: entry.name, text: textDecoder.decode(data), uncompressedSize: entry.uncompressedSize });
  }

  return output;
}

async function readSaveText(file) {
  const buffer = await file.arrayBuffer();

  if (bufferStartsWithZip(buffer)) {
    const entries = await unzipTextEntries(buffer);
    const gamestate = entries.find(e => e.name.toLowerCase() === 'gamestate')
      || entries.find(e => e.name.toLowerCase().endsWith('/gamestate'))
      || entries.find(e => /gamestate/i.test(e.name))
      || entries.sort((a, b) => b.text.length - a.text.length)[0];

    if (!gamestate) return { text: '', source: 'zip', error: 'zip_no_readable_entries' };
    if (looksBinaryText(gamestate.text)) return { text: gamestate.text, source: 'zip', error: 'binary_gamestate' };
    return { text: gamestate.text, source: `zip:${gamestate.name}` };
  }

  const text = textDecoder.decode(new Uint8Array(buffer));
  if (looksBinaryText(text)) return { text, source: 'plain', error: 'binary_save' };
  return { text, source: 'plain' };
}

function findNamedBlock(text, name) {
  const re = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*\\{', 'g');
  const m = re.exec(text);
  if (!m) return null;
  const open = text.indexOf('{', m.index);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

function extractTopLevelNumericBlocks(block) {
  const out = [];
  let i = 0;
  while (i < block.length) {
    while (i < block.length && /\s/.test(block[i])) i++;
    const idStart = i;
    while (i < block.length && /\d/.test(block[i])) i++;
    if (i === idStart) { i++; continue; }
    const id = block.slice(idStart, i);
    while (i < block.length && /\s/.test(block[i])) i++;
    if (block[i] !== '=') continue;
    i++;
    while (i < block.length && /\s/.test(block[i])) i++;
    if (block[i] !== '{') continue;
    const open = i;
    let depth = 0;
    for (; i < block.length; i++) {
      if (block[i] === '{') depth++;
      else if (block[i] === '}') {
        depth--;
        if (depth === 0) {
          out.push([id, block.slice(open + 1, i)]);
          i++;
          break;
        }
      }
    }
  }
  return out;
}

function firstTagValue(text, key) {
  const re = new RegExp('(?:^|\\s)' + key + '\\s*=\\s*"?([A-Z0-9_]{2,16})"?', 'm');
  const m = text.match(re);
  return m ? m[1].toUpperCase() : null;
}

export function parseStateMap(text) {
  const statesBlock = findNamedBlock(text, 'states');
  if (!statesBlock) return { states: {}, foundStatesBlock: false, totalBlocks: 0 };

  const blocks = extractTopLevelNumericBlocks(statesBlock);
  const states = {};

  for (const [id, body] of blocks) {
    const controller = firstTagValue(body, 'controller') || firstTagValue(body, 'owner');
    states[id] = { controller: controller || null };
  }

  return { states, foundStatesBlock: true, totalBlocks: blocks.length };
}

export function makeCompactSnapshot(snapshot) {
  const compactStates = {};
  for (const [id, obj] of Object.entries(snapshot.states)) {
    compactStates[id] = obj.controller || 'NUL';
  }
  return { date: snapshot.date, file: snapshot.file, states: compactStates };
}

export function postprocessSnapshots(rawSnapshots) {
  const ordered = [...rawSnapshots].sort((a, b) => {
    return String(a.date || '').localeCompare(String(b.date || '')) || String(a.file || '').localeCompare(String(b.file || ''));
  });

  const allIds = Array.from(new Set(ordered.flatMap(s => Object.keys(s.partialStates || {}))))
    .sort((a, b) => Number(a) - Number(b));

  const last = {};
  const diagnostics = {
    parser_version: PARSER_VERSION,
    selected_files: ordered.length,
    state_count: allIds.length,
    snapshots: [],
    warnings: []
  };
  const snapshots = [];
  const timeline = {};
  for (const id of allIds) timeline[id] = [];

  for (const snap of ordered) {
    const fullStates = {};
    let parsedControllers = 0;
    let carriedForward = 0;
    let nulStates = 0;
    let missingInThisSave = 0;

    for (const id of allIds) {
      const parsed = snap.partialStates?.[id]?.controller || null;
      if (parsed) {
        last[id] = parsed;
        parsedControllers++;
      } else if (!(id in (snap.partialStates || {}))) {
        missingInThisSave++;
      }

      const controller = last[id] || 'NUL';
      if (!parsed && last[id]) carriedForward++;
      if (controller === 'NUL') nulStates++;

      fullStates[id] = { controller };
      timeline[id].push({ date: snap.date, controller });
    }

    snapshots.push({ date: snap.date, file: snap.file, states: fullStates });
    diagnostics.snapshots.push({
      date: snap.date,
      file: snap.file,
      save_source: snap.saveSource || null,
      states_parsed_from_save: Object.keys(snap.partialStates || {}).length,
      parsed_controllers: parsedControllers,
      carried_forward_controllers: carriedForward,
      missing_states_filled: missingInThisSave,
      nul_states: nulStates,
      found_states_block: Boolean(snap.foundStatesBlock),
      raw_state_blocks_seen: snap.totalBlocks || 0
    });
  }

  if (!allIds.length) {
    diagnostics.warnings.push('No state blocks were found. Check that the selected saves are not binary saves and include a readable gamestate.');
  }

  const compact = snapshots.map(makeCompactSnapshot);
  const totalCarriedForward = diagnostics.snapshots.reduce((sum, s) => sum + s.carried_forward_controllers, 0);

  return { snapshots, compact, timeline, diagnostics, totalCarriedForward };
}

export async function parseFileToRawSnapshot(file, path, orderIndex = 0) {
  let read;
  try {
    read = await readSaveText(file);
  } catch (err) {
    return {
      skipped: true,
      reason: `read_error: ${err?.message || err}`,
      file: path || file.name,
      size: file.size,
      lastModified: file.lastModified
    };
  }

  if (read.error) {
    return {
      skipped: true,
      reason: read.error,
      file: path || file.name,
      size: file.size,
      lastModified: file.lastModified,
      saveSource: read.source
    };
  }

  const parsed = parseStateMap(read.text);
  if (!parsed.foundStatesBlock) {
    return {
      skipped: true,
      reason: 'no_states_block',
      file: path || file.name,
      size: file.size,
      lastModified: file.lastModified,
      saveSource: read.source
    };
  }

  const date = parseDateFromText(read.text, file.name) || `unknown-${String(orderIndex + 1).padStart(4, '0')}`;

  return {
    skipped: false,
    date,
    file: path || file.name,
    partialStates: parsed.states,
    foundStatesBlock: parsed.foundStatesBlock,
    totalBlocks: parsed.totalBlocks,
    size: file.size,
    lastModified: file.lastModified,
    saveSource: read.source
  };
}

export function buildOutputFiles({ title, rawSnapshots }) {
  const fixed = postprocessSnapshots(rawSnapshots);
  const game = {
    title: title || 'HOI4 Game Log',
    parser: 'HOI4 Game Log Parser',
    parser_version: PARSER_VERSION,
    created_at: new Date().toISOString(),
    snapshot_count: fixed.snapshots.length,
    state_count: fixed.diagnostics.state_count,
    first_date: fixed.snapshots[0]?.date || null,
    last_date: fixed.snapshots.at(-1)?.date || null,
    notes: 'Every snapshot includes every discovered state. Missing controllers are carried forward; unknown controllers use NUL.'
  };

  return {
    files: {
      'game.json': JSON.stringify(game, null, 2),
      'snapshots.json': JSON.stringify(fixed.snapshots, null, 2),
      'snapshots_compact.json': JSON.stringify(fixed.compact, null, 2),
      'state_controller_timeline.json': JSON.stringify(fixed.timeline, null, 2),
      'parse_diagnostics.json': JSON.stringify(fixed.diagnostics, null, 2)
    },
    summary: {
      snapshotCount: fixed.snapshots.length,
      stateCount: fixed.diagnostics.state_count,
      carriedForward: fixed.totalCarriedForward,
      firstDate: game.first_date,
      lastDate: game.last_date
    }
  };
}
