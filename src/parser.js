import { meltBinaryHoi4, inferStatesFromMeltedBinary, parseBinaryHoi4Snapshot } from './binary.js';
import { FUWG_PROVINCE_TO_STATE, FUWG_STATE_TO_PROVINCES, FUWG_PROVINCE_MAP_META } from './fuwg_province_state_map.js';

const decoder = new TextDecoder('utf-8', { fatal: false });

function logSafeTextSample(text) {
  return text.slice(0, 200).replace(/\s+/g, ' ').trim();
}

export async function readHoi4SaveFile(file, log = () => {}) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const dateHint = extractDateHintFromBytes(bytes, file.name);
  const magic = bytes.length >= 4 ? String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) : '';

  // Most non-ironman HOI4 saves are ZIP containers with entries such as gamestate/meta.
  if (magic.startsWith('PK')) {
    try {
      const unzipper = window.fflate;
      if (!unzipper?.unzipSync) {
        return { ok: false, reason: 'zip_library_not_loaded' };
      }
      const entries = unzipper.unzipSync(bytes);
      const names = Object.keys(entries);
      const preferred = names.find(n => /(^|\/)gamestate$/i.test(n))
        || names.find(n => /gamestate/i.test(n))
        || names.find(n => !/meta|thumbnail|preview/i.test(n));
      if (!preferred) return { ok: false, reason: `zip_no_gamestate entries=${names.join(',')}` };
      const inner = entries[preferred];
      const text = decoder.decode(inner);
      const zipDateHint = extractDateHintFromZipEntries(entries, file.name) || dateHint;
      if (looksLikeTextSave(text)) return { ok: true, text, source: 'zip:' + preferred, dateHint: zipDateHint };

      // Normal HOI4 saves can be binary data inside the .hoi4 ZIP. Try fast binary parsing.
      const fast = parseBinaryHoi4Snapshot(inner, file.name, log);
      if (fast.ok) {
        return { ok: true, snapshot: fast, text: '', source: 'zip-binary-fast:' + preferred, binaryDiagnostics: fast.diagnostics, dateHint: fast.date || zipDateHint };
      }
      const melted = meltBinaryHoi4(inner, log);
      if (melted.text && melted.text.length > 100) {
        return { ok: true, text: melted.text, source: 'zip-binary-melt:' + preferred, binaryDiagnostics: { ...melted.diagnostics, fastDiagnostics: fast.diagnostics, dateHint: zipDateHint }, dateHint: zipDateHint };
      }
      return { ok: false, reason: `zip_gamestate_not_readable entry=${preferred} sample=${logSafeTextSample(text)}` };
    } catch (err) {
      log(`[WARN] ZIP read failed for ${file.name}: ${err.message}`);
      return { ok: false, reason: 'zip_read_failed_' + err.message };
    }
  }

  const text = decoder.decode(bytes);
  if (looksLikeTextSave(text)) return { ok: true, text, source: 'plain', dateHint };

  // Try direct normal .hoi4 binary save parsing first.
  const fast = parseBinaryHoi4Snapshot(bytes, file.name, log);
  if (fast.ok) {
    return { ok: true, snapshot: fast, text: '', source: 'binary-fast', binaryDiagnostics: fast.diagnostics, dateHint: fast.date || dateHint };
  }

  // Fall back to the older melt approach for unusual binary shapes.
  const melted = meltBinaryHoi4(bytes, log);
  if (melted.text && melted.text.length > 100) {
    return { ok: true, text: melted.text, source: 'binary-melt', binaryDiagnostics: { ...melted.diagnostics, fastDiagnostics: fast.diagnostics, dateHint }, dateHint };
  }

  const nulCount = bytes.slice(0, Math.min(bytes.length, 4096)).filter(b => b === 0).length;
  return { ok: false, reason: nulCount > 8 ? 'binary_save_unreadable' : 'not_recognised_as_text_save' };
}

function extractDateHintFromBytes(bytes, fileName = '') {
  const fromName = parseDate('', fileName);
  if (fromName) return fromName;
  // Some binary/container saves still expose the date in plain ASCII metadata.
  const sample = decoder.decode(bytes.slice(0, Math.min(bytes.length, 1024 * 1024 * 2)));
  return parseDate(sample, fileName);
}

function extractDateHintFromZipEntries(entries, fileName = '') {
  const fromName = parseDate('', fileName);
  if (fromName) return fromName;
  const names = Object.keys(entries);
  const likelyMeta = names.filter(n => /meta|descriptor|header/i.test(n));
  for (const name of [...likelyMeta, ...names]) {
    try {
      const sample = decoder.decode(entries[name].slice(0, Math.min(entries[name].length, 1024 * 1024)));
      const found = parseDate(sample, fileName);
      if (found) return found;
    } catch {}
  }
  return null;
}

function looksLikeTextSave(text) {
  if (!text || text.length < 100) return false;
  return /\bstates\s*=\s*\{/.test(text) || /\bcountry\s*=\s*\{/.test(text) || /\bdate\s*=\s*"?\d{4}\.\d{1,2}\.\d{1,2}/.test(text);
}

function findBlock(text, key, start = 0) {
  const re = new RegExp('\\b' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*\\{', 'g');
  re.lastIndex = start;
  const match = re.exec(text);
  if (!match) return null;
  let open = text.indexOf('{', match.index);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { start: open + 1, end: i, body: text.slice(open + 1, i) };
    }
  }
  return null;
}

function iterNumberedBlocks(body) {
  const out = [];
  const re = /(?:^|\s)(\d+)\s*=\s*\{/g;
  let match;
  while ((match = re.exec(body))) {
    const id = match[1];
    const open = body.indexOf('{', match.index);
    let depth = 0;
    for (let i = open; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') {
        depth--;
        if (depth === 0) {
          out.push({ id, body: body.slice(open + 1, i) });
          re.lastIndex = i + 1;
          break;
        }
      }
    }
  }
  return out;
}

function getToken(block, key) {
  const re = new RegExp('\\b' + key + '\\s*=\\s*("[^"]+"|[A-Z0-9_\\.-]+)', 'i');
  const m = block.match(re);
  if (!m) return null;
  return m[1].replace(/^"|"$/g, '').trim();
}

function parseDate(text, fallbackName = '') {
  const direct = text.match(/\bdate\s*=\s*"?(\d{4})\.(\d{1,2})\.(\d{1,2})"?/);
  if (direct) return `${direct[1]}-${direct[2].padStart(2, '0')}-${direct[3].padStart(2, '0')}`;
  const fromName = fallbackName.match(/(\d{4})[_. -](\d{1,2})[_. -](\d{1,2})/);
  if (fromName) return `${fromName[1]}-${fromName[2].padStart(2, '0')}-${fromName[3].padStart(2, '0')}`;
  return null;
}


function parseProvinceControllerBlocks(text) {
  const provincesBlock = findBlock(text, 'provinces');
  if (!provincesBlock) return {};
  const provinces = {};
  for (const pr of iterNumberedBlocks(provincesBlock.body)) {
    let controller = getToken(pr.body, 'controller') || getToken(pr.body, 'owner') || getToken(pr.body, 'controller_tag');
    if (!controller || controller === '---') continue;
    provinces[pr.id] = controller;
  }
  return provinces;
}

export function parseSnapshot(text, fileName = '', dateHint = null) {
  const date = parseDate(text, fileName) || dateHint || null;
  const statesBlock = findBlock(text, 'states');
  if (!statesBlock) {
    const inferred = inferStatesFromMeltedBinary(text, fileName, date);
    if (inferred.ok) return { ...inferred, provinces: inferred.provinces || {} };
    return { ok: false, reason: inferred.reason || 'no_states_block', diagnostics: inferred.diagnostics };
  }

  const states = {};
  for (const st of iterNumberedBlocks(statesBlock.body)) {
    let controller = getToken(st.body, 'controller') || getToken(st.body, 'owner') || getToken(st.body, 'controller_tag');
    if (!controller || controller === '---') controller = null;
    states[st.id] = controller;
  }
  const provinces = parseProvinceControllerBlocks(text);
  return { ok: true, date, fileName, states, provinces };
}

export function buildTimeline(rawSnapshots) {
  const byKey = new Map();
  for (const s of rawSnapshots) {
    const key = s.date || s.fileName;
    byKey.set(key, s);
  }
  const ordered = [...byKey.values()].sort((a, b) => (a.date || a.fileName).localeCompare(b.date || b.fileName));

  // Use the uploaded FUWG history/states data as the authoritative province list.
  // HOI4 saves usually store province control as sparse overrides, so a missing province
  // override should inherit the controller of its parent state for that same snapshot.
  const knownStates = new Set(Object.keys(FUWG_STATE_TO_PROVINCES));
  const knownProvinces = new Set(Object.keys(FUWG_PROVINCE_TO_STATE));
  for (const s of ordered) {
    Object.keys(s.states || {}).forEach(id => knownStates.add(id));
    Object.keys(s.provinces || {}).forEach(id => knownProvinces.add(id));
  }

  const lastStates = {};
  let carriedForwardControllers = 0;
  let effectiveProvinceFallbacks = 0;
  let rawProvinceOverrideTotal = 0;
  const stateIds = [...knownStates].sort((a, b) => Number(a) - Number(b));
  const provinceIds = [...knownProvinces].sort((a, b) => Number(a) - Number(b));

  const snapshots = ordered.map(s => {
    const fullStates = {};
    for (const id of stateIds) {
      const current = (s.states || {})[id];
      if (current) {
        fullStates[id] = current;
        lastStates[id] = current;
      } else if (lastStates[id]) {
        fullStates[id] = lastStates[id];
        carriedForwardControllers++;
      } else {
        fullStates[id] = 'NUL';
      }
    }

    const provinceOverrides = {};
    for (const [id, controller] of Object.entries(s.provinces || {})) {
      if (controller && controller !== 'NUL') provinceOverrides[id] = controller;
    }
    rawProvinceOverrideTotal += Object.keys(provinceOverrides).length;

    const effectiveProvinces = {};
    for (const provinceId of provinceIds) {
      const override = provinceOverrides[provinceId];
      if (override) {
        effectiveProvinces[provinceId] = override;
        continue;
      }
      const stateId = FUWG_PROVINCE_TO_STATE[provinceId];
      const fallback = stateId ? fullStates[stateId] : null;
      effectiveProvinces[provinceId] = fallback || 'NUL';
      effectiveProvinceFallbacks++;
    }

    return {
      date: s.date,
      file: s.fileName,
      states: fullStates,
      provinces: effectiveProvinces,
      provinceOverrides
    };
  });

  const stateControllerTimeline = {};
  for (const id of stateIds) {
    stateControllerTimeline[id] = snapshots.map(s => ({ date: s.date, controller: s.states[id] }));
  }

  const provinceControllerTimeline = {};
  for (const id of provinceIds) {
    provinceControllerTimeline[id] = snapshots.map(s => ({ date: s.date, controller: s.provinces[id] || 'NUL' }));
  }

  return {
    snapshots,
    stateControllerTimeline,
    provinceControllerTimeline,
    provinceStateMap: FUWG_PROVINCE_TO_STATE,
    diagnostics: {
      snapshots: snapshots.length,
      states: knownStates.size,
      provinces: knownProvinces.size,
      rawProvinceOverrideTotal,
      effectiveProvinceFallbacks,
      carriedForwardControllers,
      carriedForwardProvinceControllers: 0,
      provinceMap: FUWG_PROVINCE_MAP_META
    }
  };
}
