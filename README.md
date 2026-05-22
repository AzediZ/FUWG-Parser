# HOI4 Game Log Parser

A static, client-side Hearts of Iron IV save parser for creating game-log exports for an animation renderer.

No backend, no install, no Python, no EXE. The app runs in the browser and reads local files only after the user selects a save folder or files.

## Recommended use

1. Open the hosted GitHub Pages site in Chrome or Edge.
2. Click **Select save folder** and choose the HOI4 save/autosave folder.
3. Click **Start watching** before or during the multiplayer game.
4. Keep the tab open while autosaves are generated.
5. When the game is done, click **Download gamelog export.zip**.

The final export file is:

```text
gamelog export.zip
```

## Output files

The export zip contains:

```text
game.json
snapshots.json
snapshots_compact.json
state_controller_timeline.json
parse_diagnostics.json
```

## State-controller fix

Every exported snapshot contains every discovered state.

If a state is missing from a later save parse, the previous known controller is carried forward. If a state has no known controller yet, it is exported as `NUL` instead of being dropped.

This is intended to avoid broken renders caused by incomplete snapshots where countries/states disappear or become null later in the game.

## Browser support

Chrome or Edge are recommended for live watch mode because they support folder selection through the File System Access API.

Fallback file/folder selection is also included, but fallback mode cannot automatically detect new autosaves. Users must reselect files to parse newly-created saves.

## Save format note

This parser expects text/uncompressed HOI4 save files. If saves are compressed/binary, the browser parser will skip them.

For best results, use uncompressed autosaves for the session being parsed.

## GitHub Pages setup

1. Create a new GitHub repo.
2. Upload all files from this folder.
3. Go to **Settings → Pages**.
4. Set source to the main branch and root folder.
5. Open the published Pages URL.

No build step is required.
