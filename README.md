# HOI4 Game Log Parser Web

Static browser-based parser for FUWG/HOI4 game-log animation exports.

## Host checklist

1. Before the game, make sure the host keeps at least **3 autosaves** / `debug_saves = 3` or higher.
2. Open this page in **Chrome or Edge**.
3. Delete all current autosaves. Normal/manual saves are fine to keep.
4. Host the game as normal.
5. Click **Select save folder** and choose `Documents\Paradox Interactive\Hearts of Iron IV\save games`.
6. When the game is ready to un-pause and start, click **Watch new saves only**.
7. At the end, click **Stop watching**.
8. Click **Download gamelog export.zip** and send it for the animation render.

## v30 changes

- Keeps v29 crash recovery and wake lock.
- Makes watching more stable by **not rebuilding the full province export after every autosave**.
- Full province export is built only when downloading.
- Adds cleaned province overrides to reduce random speckle dots in the renderer.
- Raw override candidates are still kept in `snapshot.provinceOverrides` for debugging.
- Accepted/rejected override decisions are stored in each snapshot.

## Output

`gamelog export.zip` contains:

- `game.json`
- `snapshots.json`
- `snapshots_compact.json`
- `state_controller_timeline.json`
- `province_controller_timeline.json`
- `province_state_map.json`
- `parse_diagnostics.json`

Use `snapshots.json -> provinces` for the cleaned effective province map.
