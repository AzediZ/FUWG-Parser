export const PARSER_VERSION = 'web-gamelog-parser-fixed-state-controller-v1';

export function parseDateFromText(text, fileName = '') {
  const saveDate = text.match(/(?:^|\s)date\s*=\s*"?(\d{4})\.(\d{1,2})\.(\d{1,2})"?/);
  if (saveDate) return `${saveDate[1]}-${saveDate[2].padStart(2, '0')}-${saveDate[3].padStart(2, '0')}`;

  const fileDate = fileName.match(/(\d{4})[._-](\d{1,2})[._-](\d{1,2})/);
  if (fileDate) return `${fileDate[1]}-${fileDate[2].padStart(2, '0')}-${fileDate[3].padStart(2, '0')}`;

  return null;
}

export function looksCompressedOrBinary(text) {
  if (text.startsWith('PK\u0003\u0004')) return true;
  const sample = text.slice(0, 5000);
  let nul = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample.charCodeAt(i) === 0) nul++;
  }
  return nul > 5;
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
    diagnostics.warnings.push('No state blocks were found. The selected saves may be compressed/binary or not text-format HOI4 saves.');
  }

  const compact = snapshots.map(makeCompactSnapshot);
  const totalCarriedForward = diagnostics.snapshots.reduce((sum, s) => sum + s.carried_forward_controllers, 0);

  return { snapshots, compact, timeline, diagnostics, totalCarriedForward };
}

export async function parseFileToRawSnapshot(file, path, orderIndex = 0) {
  const text = await file.text();
  if (looksCompressedOrBinary(text)) {
    return {
      skipped: true,
      reason: 'compressed_or_binary',
      file: path || file.name,
      size: file.size,
      lastModified: file.lastModified
    };
  }

  const parsed = parseStateMap(text);
  const date = parseDateFromText(text, file.name) || `unknown-${String(orderIndex + 1).padStart(4, '0')}`;

  return {
    skipped: false,
    date,
    file: path || file.name,
    partialStates: parsed.states,
    foundStatesBlock: parsed.foundStatesBlock,
    totalBlocks: parsed.totalBlocks,
    size: file.size,
    lastModified: file.lastModified
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
