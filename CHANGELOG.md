# Changelog

## Unreleased

- Text in the preview can be selected and copied: each page carries an invisible text layer over the words the canvas draws, including paragraphs updated live. Suggested by @EvanMa1 (#19).
- New `realtimeTex.env` setting: environment variables for rtex and TeX, with `${mainDir}` and `${workspaceFolder}`. Set the `TEXMFHOME` or `TEXINPUTS` your own build uses (LaTeX Workshop's tools, a `.latexmkrc`) so the preview and **Export PDF** read the project's own `texmf` folder too (#14).
- The build files no longer fill the drive VS Code keeps them on: from rtex 0.0.7 they link to the files of the main file's folder instead of copying the whole folder, three times over (#13, #15). Run **Realtime TeX: Update rtex Engine** once it is released.
- Internal link navigation keeps up to 50 previous positions. Use the mouse back button to return; positions adapt to zoom changes and are cleared when the document resets.
- Hyperlinks in the preview: the link annotations of the background PDF (`\href`, `\url`, `\ref`, table of contents, …) are laid over the pages. Clicking one opens the URL or jumps within the document. Works on pages drawn from display lists too, and links under a paragraph being edited stay hidden until the next full compile so they cannot point at moved text.
- PDF links are parsed in a worker from the displayed layout's PDF snapshot. Link areas and destinations account for page rotation and cropping; visible link nodes are reused to preserve keyboard focus.

## 0.0.3

- The extension is now called **Realtime TeX**, and new releases are published to the VS Code Marketplace.
- **Preview This File Only** previews one file of a project on its own. A file with its own `\documentclass` is previewed as it is; a file without one is wrapped in the new `realtimeTex.previewTemplate` setting (a plain `article` by default), with its paths resolved from the main file's folder. Suggested by @EvanMa1 (#9).

## 0.0.2

- Double-clicking the preview now jumps to the source even when that paragraph comes from a file no editor has open, such as an `\include`d chapter. Before, it said "No source paragraph found". Thanks to @Steve-Li-1998 (#7).

## 0.0.1

First release.

- Live preview that re-typesets the edited paragraph through rtex's fast path and installs background layouts as they arrive.
- Native display-list renderer for OpenType/TrueType fonts (glyph indices) and Type1/TFM fonts (through `pdftex.map`), with colors, rules, images and graphicx transforms. Pages it cannot draw exactly fall back to the background PDF, rendered by pdf.js.
- Live markers next to the line numbers: a solid green bar beside the parts that update live as you type, a dotted amber bar beside the parts that wait for the full compile, with the reason on hover (`realtimeTex.editor.liveMarkers`).
- **Install rtex** downloads the prebuilt engine of the latest realtime-tex release (v0.0.2 and later) for Linux (x86_64, arm64), macOS (arm64, x86_64) or Windows (x86_64), checks its SHA-256 and unpacks it into the extension's storage; no Rust needed. **Install rtex (Build from Source)** still builds realtime-tex `main` with `cargo`, and `realtimeTex.installFrom` picks the default. Updates follow the way the rtex in use was installed (a newer release, or new commits on `main`). **Install TeX Live** downloads realtime-tex's installer script instead of cloning the repository.
- `realtimeTex.engine.fastBudgetMs` defaults to 50 ms, rtex's own default since 0.0.2.
- Windows support (realtime-tex `3741920`): the preview runs rtex natively on Windows. **Install rtex** and **Install TeX Live** run their scripts in Git Bash, the managed binary is `rtex.exe`, and lualatex is found as `lualatex.exe`. CI runs the integration suite on Linux, macOS and Windows.
- Two-way navigation: the preview follows the cursor, and a double-click in the preview jumps to the source.
- LaTeX errors and warnings in the Problems panel; a status pill and status bar entry that explain what the engine is doing.
- Export PDF, recompile, restart and stop commands; automatic main-file detection.
- Guided setup: walkthrough, **Check Setup**, one-click **Install rtex** (build from source) and an optional minimal TeX Live install.
- A first compile that fails or takes long explains itself (with the LaTeX log one click away) instead of waiting silently.
- Keep rtex up to date: **Update rtex Engine** pulls the latest realtime-tex, rebuilds it and restarts the engine; the `realtimeTex.updateCheck` setting (`notify` / `auto` / `off`) checks once a day.
- Follows realtime-tex `e5cab6a`: a full compile that produces no pages (`compile: Failed`) keeps the previous pages on screen with a banner (before the first layout it explains the failure); paragraphs rtex reports as `removed` are cleared; TikZ pictures reused from the picture cache are drawn from the PDF; new routing reasons are explained in plain words.
- Engine settings: `realtimeTex.engine.eligibility`, `realtimeTex.engine.fastBudgetMs`, `realtimeTex.engine.pictureCache` (passed to `rtex serve` only when changed, so older rtex builds still start); changing them restarts the engine.
- Removed the workaround for projects with subfolders: rtex creates them itself since `e324bef` (update rtex with **Update rtex Engine**).
- Debugging: `realtimeTex.debug.enabled` (and `realtimeTex.debug.directory`) makes rtex save a bundle for every live-engine failure; the extension announces each bundle with **Reveal Bundle** / **Copy Path**. **Open Debug Folder** opens the folder.
