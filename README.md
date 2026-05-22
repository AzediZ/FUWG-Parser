# HOI4 Game Log Parser Web

Static browser-based Hearts of Iron IV game-log parser/exporter.

## Usage

1. Open `index.html` locally or host the repo with GitHub Pages.
2. Click **Select save folder**.
3. Select:

   `Documents/Paradox Interactive/Hearts of Iron IV/save games`

4. Click **Start watching** while the multiplayer game is running.
5. When finished, click **Download gamelog export.zip**.

The parser runs locally in the browser. It only reads files/folders selected by the user.

## Output

The downloaded `gamelog export.zip` contains:

- `game.json`
- `snapshots.json`
- `snapshots_compact.json`
- `state_controller_timeline.json`
- `parse_diagnostics.json`

## State-controller fix

Each snapshot exports every discovered state. If a later save omits a state controller, the previous controller is carried forward. If the state has never had a known controller, it is exported as `NUL`.

## Save format note

This version supports plain-text `.hoi4` saves and ZIP-compressed `.hoi4` saves that contain a readable `gamestate` entry. Fully binary saves cannot be parsed by this static browser version.
