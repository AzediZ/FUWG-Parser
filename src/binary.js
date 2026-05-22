
// Fast binary snapshot path used for normal HOI4bin saves.
// It does not require a full token dictionary. It streams the binary token/value
// sequence, finds repeated tag assignments inside numbered state-like blocks,
// and chooses the assignment key with the most distinct state ids.

function dateFromGameDays(days) {
  if (!Number.isFinite(days) || days <= 0 || days > 20000) return null;
  const start = Date.UTC(1936, 0, 1);
  const d = new Date(start + days * 86400000);
  return d.toISOString().slice(0, 10);
}

export function parseBinaryHoi4Snapshot(bytes, fileName = '', log = () => {}) {
  const startsHoi4 = bytes.length >= 7 && String.fromCharCode(...bytes.slice(0, 7)) === 'HOI4bin';
  let pos = startsHoi4 ? 7 : 0;
  const stack = [];
  let pending = null;
  let afterEquals = null;
  const candidates = new Map(); // key token -> Map(state id -> controller tag)
  let dateDays = null;
  let dateSource = null;
  let tokensRead = 0;
  let hardStops = 0;

  const putCandidate = (key, stateId, tag) => {
    if (!candidates.has(key)) candidates.set(key, new Map());
    candidates.get(key).set(stateId, tag);
  };

  const findStateId = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const item = stack[i];
      if (item && item.kind === 'number' && Number.isInteger(item.value) && item.value >= 1 && item.value <= 5000) {
        return item.value;
      }
    }
    return null;
  };

  while (pos + 2 <= bytes.length) {
    const tokenOffset = pos;
    const token = u16(bytes, pos); pos += 2; tokensRead++;
    let kind = 'key';
    let value = null;

    try {
      if (token === 12) { if (pos + 4 > bytes.length) break; kind = 'number'; value = i32(bytes, pos); pos += 4; }
      else if (token === 20) { if (pos + 4 > bytes.length) break; kind = 'number'; value = u32(bytes, pos); pos += 4; }
      else if (token === 13) { if (pos + 4 > bytes.length) break; kind = 'number'; value = i32(bytes, pos); pos += 4; }
      else if (token === 359 || token === 668) { if (pos + 8 > bytes.length) break; kind = 'number'; value = readI64AsNumber(bytes, pos, token === 668); pos += 8; }
      else if (token === 15 || token === 23) {
        if (pos + 2 > bytes.length) break;
        const len = u16(bytes, pos); pos += 2;
        if (len < 0 || len > 65535 || pos + len > bytes.length) { hardStops++; break; }
        kind = 'string'; value = decodeUtf8(bytes, pos, len); pos += len;
      }
      else if (token === 14) { if (pos >= bytes.length) break; kind = 'bool'; value = bytes[pos++]; }
      else if (token === 1) kind = 'equals';
      else if (token === 3) kind = 'open';
      else if (token === 4) kind = 'close';
    } catch (err) {
      hardStops++;
      log(`[WARN] Fast binary parser stopped near byte ${tokenOffset}: ${err.message}`);
      break;
    }

    if (kind === 'equals') {
      afterEquals = pending;
      continue;
    }

    if (kind === 'open') {
      stack.push(afterEquals);
      afterEquals = null;
      continue;
    }

    if (kind === 'close') {
      if (stack.length) stack.pop();
      continue;
    }

    if (kind === 'number' && afterEquals && afterEquals.token === 13954 && value > 0 && value < 20000) {
      // In normal HOI4bin saves TOKEN_13954 appears right at the top of the file as
      // the actual game date, stored as days since 1936-01-01. The same token can
      // appear later inside unrelated nested data, so only accept the first/top-level
      // hit rather than overwriting it during the full state scan.
      if (dateDays === null || stack.length <= 1) {
        dateDays = value;
        dateSource = stack.length <= 1 ? 'TOKEN_13954_top_level' : 'TOKEN_13954_first_seen';
      }
      afterEquals = null;
    }

    if (kind === 'string' && afterEquals) {
      const tag = typeof value === 'string' ? value.trim() : '';
      if (/^[A-Z0-9_]{3}$/.test(tag) && !['YES','NOT','AND','ADD','TAG','DAY'].includes(tag)) {
        const stateId = findStateId();
        if (stateId !== null) putCandidate(afterEquals.token, stateId, tag);
      }
      afterEquals = null;
    }

    if (kind === 'key' || kind === 'number' || kind === 'string') {
      pending = { kind, token, value };
    }
  }

  const ranked = [...candidates.entries()]
    .map(([key, map]) => ({ key, count: map.size, map }))
    .filter(x => x.count >= 30)
    .sort((a, b) => b.count - a.count);

  const best = ranked[0];
  if (!best) {
    return { ok: false, reason: 'binary_fast_no_state_candidates', diagnostics: { tokensRead, bytesRead: pos, bytesTotal: bytes.length, hardStops, candidates: [] } };
  }

  const states = {};
  for (const [id, tag] of best.map.entries()) states[String(id)] = tag;
  const date = dateFromGameDays(dateDays) || parseDateFromName(fileName);
  return {
    ok: true,
    date,
    fileName,
    states,
    binaryFallback: true,
    diagnostics: {
      mode: 'binary_fast',
      tokensRead,
      bytesRead: pos,
      bytesTotal: bytes.length,
      hardStops,
      chosenKey: `TOKEN_${best.key}`,
      chosenCount: best.count,
      inferredStates: Object.keys(states).length,
      dateDays,
      dateSource,
      dateBase: dateDays ? '1936-01-01_plus_days' : null,
      candidates: ranked.slice(0, 8).map(x => ({ key: `TOKEN_${x.key}`, count: x.count }))
    }
  };
}

function readI64AsNumber(bytes, pos, unsigned = false) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) + BigInt(bytes[pos+i]);
  if (!unsigned && (bytes[pos+7] & 0x80)) v -= 1n << 64n;
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  if (v > maxSafe) return Number.MAX_SAFE_INTEGER;
  if (v < -maxSafe) return -Number.MAX_SAFE_INTEGER;
  return Number(v);
}

// Experimental HOI4 binary save reader.
// It deliberately does not ship a full proprietary token resolver. Instead it melts
// known primitive tokens/syntax and then uses a narrow fallback to recover state -> tag
// snapshots from repeated numbered blocks.

const BASE_TOKENS = {
  1: '=', 2: '"', 3: '{', 4: '}', 5: '(', 6: ')', 8: ',', 9: '#',
  11: 'id', 12: '<number>', 13: '<fixed>', 14: '<bool_or_string>',
  15: '<string>', 16: '\n', 17: '\t', 18: ' ', 19: '<EOF>',
  20: '<uint32>', 21: 'idtype', 23: '<string_raw>', 359: '<int64>', 668: '<uint64>'
};

function u16(bytes, pos) { return bytes[pos] | (bytes[pos + 1] << 8); }
function i32(bytes, pos) { return (bytes[pos] | (bytes[pos+1]<<8) | (bytes[pos+2]<<16) | (bytes[pos+3]<<24)) | 0; }
function u32(bytes, pos) { return (bytes[pos] | (bytes[pos+1]<<8) | (bytes[pos+2]<<16) | (bytes[pos+3]<<24)) >>> 0; }
function i64ToString(bytes, pos, unsigned=false) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) + BigInt(bytes[pos+i]);
  if (!unsigned && (bytes[pos+7] & 0x80)) v -= 1n << 64n;
  return String(v);
}
function decodeUtf8(bytes, pos, len) {
  try { return new TextDecoder('utf-8', { fatal:false }).decode(bytes.slice(pos, pos+len)); }
  catch { return ''; }
}

export function meltBinaryHoi4(bytes, log = () => {}) {
  let pos = 0;
  // Most HOI4 binary saves begin with ASCII HOI4bin. Older code expects the first 7 bytes skipped.
  const head7 = String.fromCharCode(...bytes.slice(0, Math.min(7, bytes.length)));
  if (head7.startsWith('HOI4bin')) pos = 7;

  const out = [];
  const unknownCounts = new Map();
  let tokensRead = 0;
  let hardStops = 0;

  while (pos + 2 <= bytes.length) {
    const number = u16(bytes, pos); pos += 2; tokensRead++;
    let text = null;

    try {
      if (number === 12) { if (pos + 4 > bytes.length) break; text = String(i32(bytes, pos)); pos += 4; }
      else if (number === 13) { if (pos + 4 > bytes.length) break; text = (i32(bytes, pos) / 1000).toFixed(3); pos += 4; }
      else if (number === 14) {
        if (pos + 1 > bytes.length) break;
        const b = bytes[pos++];
        if (b === 0 || b === 1) text = b ? 'yes' : 'no';
        else {
          if (pos + 2 > bytes.length) break;
          const len = u16(bytes, pos); pos += 2;
          if (len < 0 || len > 65535 || pos + len > bytes.length) { hardStops++; break; }
          text = decodeUtf8(bytes, pos, len); pos += len;
        }
      }
      else if (number === 15) {
        if (pos + 2 > bytes.length) break;
        const len = u16(bytes, pos); pos += 2;
        if (len < 0 || len > 65535 || pos + len > bytes.length) { hardStops++; break; }
        text = `"${decodeUtf8(bytes, pos, len)}"`; pos += len;
      }
      else if (number === 20) { if (pos + 4 > bytes.length) break; text = String(u32(bytes, pos)); pos += 4; }
      else if (number === 23) {
        if (pos + 2 > bytes.length) break;
        const len = u16(bytes, pos); pos += 2;
        if (len < 0 || len > 65535 || pos + len > bytes.length) { hardStops++; break; }
        text = decodeUtf8(bytes, pos, len); pos += len;
      }
      else if (number === 359) { if (pos + 8 > bytes.length) break; text = i64ToString(bytes, pos, false); pos += 8; }
      else if (number === 668) { if (pos + 8 > bytes.length) break; text = i64ToString(bytes, pos, true); pos += 8; }
      else {
        text = BASE_TOKENS[number] ?? `UNKNOWN_TOKEN_${number}`;
        if (!BASE_TOKENS[number]) unknownCounts.set(number, (unknownCounts.get(number) || 0) + 1);
      }
    } catch (err) {
      hardStops++;
      log(`[WARN] Binary melt stopped near byte ${pos}: ${err.message}`);
      break;
    }
    if (text !== null && text !== '\n' && text !== '\t' && text !== ' ') out.push(text);
  }

  const text = decorateMelted(out.join(' '));
  const topUnknownTokens = [...unknownCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 30)
    .map(([token,count]) => ({ token, count }));
  return { text, diagnostics: { tokensRead, bytesRead: pos, bytesTotal: bytes.length, hardStops, topUnknownTokens } };
}

function decorateMelted(filestring) {
  // Remove a few quote marks around keys where possible.
  filestring = filestring.replace(/"([a-zA-Z0-9_^]+)"\s*=/g, '$1 =');
  filestring = filestring.replace(/\s+/g, ' ');
  return filestring;
}

export function inferStatesFromMeltedBinary(text, fileName = '', dateHint = null) {
  const blocks = iterNumberedBlocksLoose(text);
  const counts = new Map();
  const perBlock = [];

  for (const block of blocks) {
    const idNum = Number(block.id);
    if (!Number.isFinite(idNum) || idNum < 1 || idNum > 5000) continue;
    if (block.body.length > 80000) continue;
    const assignments = [...block.body.matchAll(/\b(UNKNOWN_TOKEN_\d+|owner|controller|controller_tag)\s*=\s*"?([A-Z][A-Z0-9_]{2,4})"?/g)]
      .map(m => ({ key: m[1], tag: m[2] }))
      .filter(x => /^[A-Z0-9_]{3}$/.test(x.tag) && !['YES','NOT','AND','ADD','TAG'].includes(x.tag));
    if (!assignments.length) continue;
    perBlock.push({ id: block.id, assignments });
    for (const a of assignments) counts.set(a.key, (counts.get(a.key) || 0) + 1);
  }

  const candidates = [...counts.entries()].sort((a,b)=>b[1]-a[1]);
  const chosen = candidates.find(([key,count]) => count >= 30) || candidates[0];
  if (!chosen) return { ok:false, reason:'binary_no_repeated_tag_assignments', diagnostics:{ numberedBlocks: blocks.length, candidates: [] } };

  const [key, count] = chosen;
  const states = {};
  for (const b of perBlock) {
    const hit = b.assignments.find(a => a.key === key);
    if (hit) states[b.id] = hit.tag;
  }

  const stateCount = Object.keys(states).length;
  if (stateCount < 30) {
    return { ok:false, reason:'binary_not_enough_inferred_states', diagnostics:{ numberedBlocks: blocks.length, chosenKey:key, chosenCount:count, inferredStates:stateCount, candidates:candidates.slice(0,10).map(([key,count])=>({key,count})) } };
  }
  return { ok:true, date: dateHint || parseDateFromName(fileName), fileName, states, binaryFallback:true, diagnostics:{ numberedBlocks: blocks.length, chosenKey:key, chosenCount:count, inferredStates:stateCount, candidates:candidates.slice(0,10).map(([key,count])=>({key,count})) } };
}

function iterNumberedBlocksLoose(text) {
  const out = [];
  const re = /(?:^|\s)(\d{1,5})\s*=\s*\{/g;
  let match;
  while ((match = re.exec(text))) {
    const id = match[1];
    const open = text.indexOf('{', match.index);
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      const c = text[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          out.push({ id, body: text.slice(open + 1, i) });
          re.lastIndex = i + 1;
          break;
        }
      }
      if (i - open > 1000000) { re.lastIndex = i; break; }
    }
    if (out.length > 20000) break;
  }
  return out;
}

function parseDateFromName(name) {
  const m = name.match(/(\d{4})[_. -](\d{1,2})[_. -](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}` : null;
}
