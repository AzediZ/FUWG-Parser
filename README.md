# HOI4 Game Log Parser Web

Static, GitHub Pages-ready HOI4/FUWG game-log parser/exporter.

## Quick host instructions

1. Before the game, make sure the host keeps at least **3 autosaves** / **debug_saves = 3 or higher**. One overwriting autosave can miss large chunks of history.
2. Open the parser in **Chrome or Edge**. GitHub Pages is preferred.
3. Delete all current autosaves. Normal/manual saves are fine to keep.
4. Host the game as normal.
5. Click **Select save folder**.
6. Select:

```text
Documents\Paradox Interactive\Hearts of Iron IV\save games
```

7. When the game is ready to un-pause and start, click **Watch new saves only**.
8. Keep the parser tab open/visible if possible. The app tries to keep the screen awake while watching.
9. At the end of the session, click **Stop watching**.
10. Click **Download gamelog export.zip** and send that file for rendering (currently Azedi).

## What it exports

`gamelog export.zip` includes full effective FUWG province snapshots. Each province uses a save-level province override when present, otherwise it inherits its parent state controller from the embedded FUWG state/province mapping.

## Hosting

Upload the repo contents to GitHub and enable GitHub Pages from the repo root. No build step is required.

## Notes

The parser only reads files/folders the user manually selects. It ignores normal/manual saves in live folder mode and watches `autosave.hoi4`, `autosave_1.hoi4`, `autosave_2.hoi4`, etc.

Version: v27 host checklist update.
