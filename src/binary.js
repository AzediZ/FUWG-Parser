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
