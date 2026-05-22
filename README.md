# HOI4 Game Log Parser Web

A static, GitHub Pages-ready Hearts of Iron IV game-log parser/exporter.

## What it does

- Runs entirely in the browser.
- Lets the user select their HOI4 save folder.
- Watches the folder for new or changed `.hoi4` autosaves.
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
