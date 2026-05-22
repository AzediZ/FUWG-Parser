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
