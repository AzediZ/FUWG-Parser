export async function makeExportZip(payload) {
  const zip = new window.JSZip();
  zip.file('game.json', JSON.stringify(payload.game, null, 2));
  zip.file('snapshots.json', JSON.stringify(payload.snapshots, null, 2));
  zip.file('snapshots_compact.json', JSON.stringify(payload.snapshots));
  zip.file('state_controller_timeline.json', JSON.stringify(payload.stateControllerTimeline, null, 2));
  zip.file('province_controller_timeline.json', JSON.stringify(payload.provinceControllerTimeline || {}, null, 2));
  zip.file('province_state_map.json', JSON.stringify(payload.provinceStateMap || {}, null, 2));
  zip.file('parse_diagnostics.json', JSON.stringify(payload.diagnostics, null, 2));
  return await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}
