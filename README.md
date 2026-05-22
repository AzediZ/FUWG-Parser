# HOI4 Game Log Parser Web

A static, GitHub Pages-ready Hearts of Iron IV game-log parser/exporter.

## What it does

- Runs entirely in the browser.
- Lets the user select their HOI4 save folder.
- Watches the folder for new or changed `.hoi4` autosaves and ignores normal/manual save files in live folder mode for speed.
- Exports `gamelog export.zip` for the renderer workflow.
- Carries state controllers forward when a later snapshot is missing a state/controller.
- Attempts normal `.hoi4` binary saves using an experimental local binary fallback.

## Save folder

Typical Windows path:

```text
Documents\Paradox Interactive\Hearts of Iron IV\save games
```

The browser can only read files/folders the user manually selects.

## Hosting

Upload the repo contents to GitHub and enable GitHub Pages from the repo root. No build step is required.

## Notes on binary saves

HOI4's normal `.hoi4` saves may contain binary-encoded gamestate data. This repo does not ask users to change their HOI4 save format. Instead, it tries a limited local binary recovery path and then infers repeated numbered state blocks. If a binary save cannot be parsed yet, `parse_diagnostics.json` inside `gamelog export.zip` will contain the details needed to improve the fallback.


## v7 note

Fixed the `Watch new saves only` button being left disabled after selecting a save folder.


## v8 note

The watch buttons are no longer greyed out by default. They stay clickable and give a clear warning if the browser is using the manual fallback instead of the live Chrome/Edge folder picker. Added a manual folder fallback for local testing.


## v9 note

Added a latest in-game date correction box. If the experimental binary date is wrong, enter the latest/current in-game date before downloading. The export shifts all captured snapshot dates by the same offset, keeping the spacing between autosaves intact. Added a Clear captured data button for restarting a test without refreshing the page.


## v10 note

Binary save date parsing now uses the first/top-level game-date token and avoids overwriting it with later unrelated counters. The manual latest-date override remains as an emergency correction only.


## v11 note

Fixes binary save date extraction by preserving the first top-level HOI4 date token instead of allowing later nested values to overwrite it.


## v12 note

Normal `.hoi4` binary save date conversion now uses the inferred HOI4 binary date epoch `1935-12-10`, fixing the previous +22 day date offset seen in early-1936 test runs.


## v14 note

Adds save-header date diagnostics. The export now lists candidate in-save date fields from the `.hoi4` header so the parser can be aligned with the same date the HOI4 save menu displays, instead of relying on the current TOKEN_13954 guess.


## v17 note

Adds a full top-header token trace and date-candidate dump for normal `.hoi4` binary saves. This is to align the parser with the same date shown by HOI4's in-game save menu. If dates are still wrong, upload the export and the diagnostics will include enough header data to map the correct save-menu date field.


## v18 note

Live folder mode is now autosave-only. The parser only scans `autosave.hoi4`, `autosave_1.hoi4`, `autosave_2.hoi4`, and matching numbered autosaves, so large save folders full of manual saves should not slow each watch check.
