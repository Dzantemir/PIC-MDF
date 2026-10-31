## 0.4.2 — 2026-10-29 — Output folder is back; one unit (bytes) for the memory data of the MCU database

- **Output folder** is back in the *Build* card next to *Output name* (optional; empty = `build`, nothing is written to the project file; variables such as `build/${buildMode}` work, with the `${…}` button). The page checks the value as you type (`..`, an absolute path, the project folder, `src` / `.git` / `include` / `lib` / `components` are flagged) and **Save refuses** an unsafe folder — *Clean* deletes the output folder recursively. A value written by hand in the project file is shown in the field and kept.
- **Clean safety guard** — the check that refuses a dangerous output folder (`.git`, `.vscode`, `src`, `node_modules`, a folder that holds the project file or a nested repository) existed only in pic-mdf; avr-mdf and sdcc-mdf now have the same one. All three also protect `include`, `lib` and `components` — the folders of the components model.
- **Memory data of the built-in MCUs is in bytes, consistently.** Before, the units were mixed: PIC18F4550 had `flash: 16384` (that is *words*; 32768 bytes), 12/14-bit parts were in words, a few in bits/8, and only 32 of ~2480 MCUs had any sizes at all. Now **1926 MCUs have a flash size, 718 RAM, 912 EEPROM** (`upload.maximum_size` mirrors flash).
  - **8-bit PIC (897 MCUs)** — program size, EEPROM and (where it passed a sanity check) RAM come from the gputils 1.5.2 device database. Flash of PIC10/12/16 is `words × 2` — the size of the image in the HEX file (a PIC16F877A with 8K words = 16384; Microchip's «14 KB» counts 14 bits per word). PIC18 is in bytes already (for the PIC18F-J series, whose last bytes hold the configuration words, the nominal size is used: 65536, not 65528).
  - **PIC24 / dsPIC33 / PIC32MX/MZ/MK/MM (1028 MCUs)** — flash only, from the size encoded in the part name (`PIC24FJ128GA010` → 128 KB, `PIC32MZ2048…` → 2048 KB). RAM / EEPROM are not derivable from the name and stay empty.
  - **Not filled (no reliable source):** the newest 8-bit parts missing from gputils (PIC18-Q, PIC16F13xxx …), dsPIC30F, PIC32C*/PIC32A*/PIC32W*, PIC32MZ DA/W. An empty size means *unknown*: the memory report shows no percentage for it.
  - **RAM is deliberately not taken from gputils where its linker scripts are known to be wrong** for PIC18 (e.g. PIC18F26K40: 3710 in the script, 3615 in the datasheet).
  - **Corrected on the way:** PIC16F1503 RAM 256 → 128, PIC18F46K22 RAM 3936 → 3896, dsPIC33EP512MU810 flash 536870912 → 524288, dsPIC33FJ128MC804 RAM 8192 → 16384.
  - Not re-checked and left as they were: RAM of dsPIC33CK256MP508, dsPIC33AK512MPS512, PIC32CM5164LS00048.
- Code that reads the sizes copes with partial data (`${board.ram}` is `0`, not `undefined`; the MCU picker and the manager list show only the sizes that are known). The Board Manager hints state the conventions.

## 0.4.1 — 2026-10-29 — Import through the menu; MCU Definitions back in the common design

- **`PIC: Import Project…` runs through the menu**, like in avr-mdf and sdcc-mdf — the webview page *PIC-MDF — Import Project* is gone. Steps: *what to import* (MPLAB X project / Makefile / plain folder) → the native folder / file dialog (a Makefile may have any name; for MPLAB X pick the `.X` folder or a folder that contains one — several projects below it → a list to choose from) → analysis → **the MCU pick** (only when the device read from the project has no MCU definition; cancelling it writes nothing) → the existing-`pic-project.json` guard (modal *Replace*) → **a review of the draft** (name, MCU and compiler, sources, include folders, defines, libraries, optimization, programmer, plus every note about what was guessed or skipped) → write, add the folder to the workspace, make it the active project, open the Project Editor. The draft goes through the same validator as the Project Editor before anything is written; the busy latch is held for the whole flow and released on every exit.
- **MCU Definitions (Board Manager) is back in the avr-mdf / sdcc-mdf design.** 0.3.8 had replaced the page by a plainer one, which looked different from the other extensions. The page now has the same layout — vendor-series tree with filter, collapse / expand all and a source switcher (All / Built-in / Global / Folder / Project), cards *Identity · Target · Memory · Programming · Save destination* with ⓘ tooltips, a fixed save bar — and PIC fields instead of the AVR leftovers it used to carry (avrdude, signature, `usbasp`): **Device** (`-mcpu=` / `-mprocessor=`), **Compiler** (xc8 / xc16 / xc32 / xc-dsc — every project that uses the MCU is built with it), **Family**, **Clock** (one number in Hz), **Programmer** (ipecmd / pk3cmd / pk2cmd), optional **Maximum image size**, note and docs URL. The 0.3.8 host fixes stay: Duplicate keeps the real device name, a new MCU without an id gets one from its device name, ids are stored lower-case, an explicit maximum image size is kept, built-in definitions are read-only.
- The tree of the (~2500) PIC MCUs starts folded the first time; rows no longer show `0/0B` for the MCUs without memory data or repeat the device name next to an identical id. Selecting an MCU in the manager no longer offers to install its device pack (that happens when a project is created / built).
- Removed `media/importProject.html` and `media/boardManager.html` (the host builds the Board Manager page itself, as in the other extensions).

## 0.4.0 — 2026-10-27 — Components (main + components/, prebuilt libraries); the compiler follows the MCU

- **Components, the esp8266-idf way.** The Project Editor lost its **Sources**, **Includes**, **Libraries**, **Components** cards and the **Output directory** field; the sidebar rows *Sources / Includes / Libraries / Output / Components: N* are gone too. Instead the Project Folder has a **📦 Components** group: `main` (the application) plus every `components/<name>/`. Click one to open the new **Component Editor** (sources, include folders, prebuilt `.a` libraries, `requires`, with a live preview of what the build will use); the checkbox enables / disables a component; *New Component…* (source / prebuilt template), *Add Existing Component…*, *Prebuilt Libraries…*, *Edit*, *Delete* are inline buttons. A component's settings live in `components/<name>/component.json`; a folder without one behaves as before. `main` keeps its settings in `pic-project.json` (`sources`, `includes`, `libraries`, optional `requires`) — **existing projects open unchanged**, and Save in the Project Editor leaves those keys (and `build.output_dir`) exactly as they are.
- **Prebuilt libraries per component.** Add `.a` files (copied into `<component>/lib` or referenced in place); each library is inspected — an archive built for another architecture than the one of the project's MCU (8-bit PIC, PIC24 / dsPIC, PIC32 MIPS / ARM) is flagged before the link fails. Link order: main's libraries first, then the components' in `requires` order; several libraries are wrapped in one `-Wl,--start-group … --end-group`.
- **Build.** The sources of main and of all components are compiled to `build/obj/**` and linked together (sources outside the project go to `obj/_external/`); the per-component `ar` archives are no longer produced. All include folders are global. A broken `component.json` blocks the build with a clear message instead of silently falling back. `components/` of the project is always scanned (disable a component with its checkbox / `disabled_components`).
- **XC8 projects now link prebuilt libraries** (they were ignored by the XC8 pipeline before): the `.a` files are passed to `xc8-cc` after the sources.
- **The compiler is chosen automatically from the MCU.** The *Toolchain* card of the Project Editor, the *Toolchain* row of the sidebar, the `Ctrl+Alt+T` shortcut and the `PIC: Switch Toolchain` command are gone — nothing to maintain, nothing that can contradict the selected device. The status-bar chip still shows the compiler in use and now opens *Select Toolchain* (the compiler install folders). An old `toolchain` key is honoured only when the MCU definition does not name a compiler, and is dropped when the project is saved from the Project Editor.
- IntelliSense and *Show Project Problems* use the same component resolution as the build (a component's include folders reach `c_cpp_properties.json`).
- Fixed in the shared component model: a project that lists `"components": ["components"]` (every project created by the wizard) no longer gets a bogus "component exists twice" warning.

## 0.3.8 — 2026-10-22 — second audit pass: Import wizard, MCU Definitions, XC Reference, guarded clock macros

- **Import Project works.** `PIC: Import Project…` was a half-ported AVR flow: the wizard page (`media/importProject.html`) never received any data. It now analyses an MPLAB X project (`nbproject/configurations.xml`: device, tool, XC compiler, sources, excluded items, include dirs, defines, optimization), a Makefile or a plain folder, pre-fills the page (board, toolchain XC8 / XC16 / XC32 / XC-DSC, sources, includes, defines, libraries, output name, optimization, programmer: PICkit 3 → `pk3cmd`; PICkit 4/5, SNAP, ICD 3-5, REAL ICE → `ipecmd` + hardware) and writes `pic-project.json`. It then adds the folder to the workspace, makes it the active project and opens the Project Editor. An existing `pic-project.json` is only replaced after an explicit confirmation.
- **MCU Definitions page works.** The command opened an AVR-flavoured page (avrdude, `usbasp`, signature…) that did not match the PIC page shipped in `media/boardManager.html`. The host now serves the PIC page and speaks its protocol: select / New / Duplicate / Save / Delete / Open JSON / Import / Export. An existing user definition is saved back to the folder it came from, a new one or a duplicate goes to `~/.pic-mdf/boards`, built-in definitions stay read-only. **Duplicate keeps the real device name** (it used to overwrite `build.device` with the new id, which the compiler would then receive as `-mcpu=`); a new MCU without an id gets one from its device name; ids are stored lower-case like the loader reads them; an explicit "Maximum image size" is kept; the result of Save is shown in the footer.
- **XC Reference view.** The inline buttons passed the tree item to handlers that expected the data row, so "Details" printed an empty message and "Insert #include" did nothing (the menu entry for it also targeted a context value that was never set). Fixed; both commands also work from the palette through a picker, and an `#include` that is already present is not inserted twice.
- **`#ifndef F_CPU` default no longer suppresses the automatic clock `-D`.** A header with the usual `#ifndef F_CPU / #define F_CPU … / #endif` is a default, not a project definition; only unguarded `#define F_CPU / FCY / _XTAL_FREQ` in the project's own sources and headers disable the automatic `-D`.

## 0.3.7 — 2026-10-21 — Project Editor: toolchain picker layout

- The four architecture buttons (XC8 / XC16 / XC32 / XC-DSC) no longer wrap into a ragged second row; they sit in a tidy 2×2 grid (one column on very narrow panels).

## 0.3.6 — 2026-10-21 — Project Editor replaces the toolchain picker; unified editor typography

- **Change Architecture opens the Project Editor.** The sidebar "Toolchain" row, the status-bar chip, `Ctrl+Alt+T` and the palette command no longer show a quick-pick; the architecture (XC8 / XC16 / XC32 / XC-DSC) is switched in the Project Editor's Toolchain card. Saving the editor now also refreshes the Reference view and the status-bar chip.
- **Project Editor typography unified** with sdcc-mdf and avr-mdf: same page width (920 px), title 18/600, card titles 13/600, labels/inputs/buttons 12 px, hints 11 px, line heights, control paddings, tip icons; bold text is 600 everywhere.

## 0.3.5 — 2026-10-20 — XC8/XC16/XC32/XC-DSC docs audit

- **Pack catalog regenerated** from packs.download.microchip.com (133 device packs, 3717 devices). Added the missing packs `dsPIC33EDV-MC-205_DFP`, `SAMRH707_DFP`, `SAMV71-RT_DFP` and 130 missing devices in 15 packs (all `dsPIC33CH512/1024…` incl. `S1` variants, `PIC32MX155/175/255/275…B/D`, `MCP191xx`, `ATSAME70/S70/V70/V71…` non-B parts, `ATtiny3214`, …). Automatic DFP lookup now works for them.
- **`-flto` is passed to XC32 only.** The XC16, XC8 and XC-DSC guides document no LTO option, so `build.lto` is ignored (and logged) for them.
- **`-Wall` is no longer passed to XC8 (PIC).** The XC8 for PIC guide has no `-Wall` (warnings are controlled with `-mwarn` / `-w` / `-W[no-]msg`; add them to `pic.extraArgs`). XC16/XC32/XC-DSC still get it.
- **No more "macro redefined" for the clock macros.** When the project's own sources or headers already define `_XTAL_FREQ`, `F_CPU` or `FCY`, the automatic `-D` for that name is skipped.
- **XC32 v6 `-fno-common` hint.** A "multiple definition of …" link error with `xc32-gcc` now explains the new default (XC32 v6.00 release notes, "Tentative Definitions") and the fix.

## 0.3.4 — 2026-10-19 — audit follow-up: Serial Monitor, hooks escaping, lazy git, wired settings

- Serial Monitor (audit items 4 & 8):
  - Port names and baud rates are validated against strict whitelists BEFORE anything is interpolated into a shell command (fixes the PowerShell injection via `pic.comPort` / manual entry).
  - Windows: one PowerShell process now pumps SerialPort RX to stdout in a background runspace while the main thread forwards stdin bytes to the port — **Send works**, and partial lines are displayed immediately (no more ReadLine blocking).
  - POSIX: `stty -F/-f <port> <baud> raw -echo` configures the line discipline before `cat` starts (baud is actually applied now); TX goes through a dedicated write fd on the tty instead of the never-connected `cat` stdin.
  - `pic.monitorEol` is finally read: it seeds the EOL selector in the toolbar and is the default terminator for Send.
- Hook commands (audit item 3): every `${…}` value (project vars, `${env:…}`, `${config:…}`) is escaped according to the quoting context it lands in, for the pinned shell family (PowerShell / cmd / POSIX / fish). A crafted git branch or environment value can no longer inject shell metacharacters. Single-pass substitution also stops values that look like `${env:…}` from triggering a second substitution.
- Build variables (audit item 10): `git:hash` / `git:branch` are now lazy — `git rev-parse` runs only when a hook or template actually references them, not on every build/flash. `extendVars()` copies the vars without evaluating the getters.
- Clean (audit item 1 hardening): build output is additionally refused for `.git`, `.hg`, `.svn`, `.bzr`, `.vscode`, `src`, `node_modules` (direct children of the project) and for directories that themselves contain a repository or `pic-project.json`.
- Previously dead settings are now wired: `pic.autoHexBin` (emit `.bin` after build via the toolchain objcopy; `.eep` when the ELF carries a data-EEPROM section), `pic.memory.historyLimit`, `pic.packStorePath`, `pic.xc8.cStandard` (`-std=c90/c99`), `pic.monitorEol`.
- `pic.programmerHardware` (read by flash since 0.3.0) is finally declared in the manifest with an enum (PK4 / PK5 / SNAP / ICD4 / ICD5 / RICE / PM3).
- `pic.extraArgs` is split respecting double/single quotes: `-DX="a b"` is one flag, not three.

## 0.3.3 — 2026-10-16 — all Add path buttons

- Apply identical fixed 92 × 30 px sizing to ALL four Add path buttons: Sources, Includes, Libraries, Components.

## 0.3.2 — 2026-10-16 — source picker button

- Fix Sources Add button to 92 × 30 CSS pixels, top-aligned and non-stretching, consistently across AVR/PIC/SDCC. Other buttons unchanged.

## 0.3.1 — 2026-10-16 — audit patch

- Require Workspace Trust (Restricted Mode no longer advertises partial execution safety).
- Reject external/root/symlink output directories after expansion and before Clean.
- Invoke executable paths correctly in PowerShell, including flash/fuse commands.
- Anchor terminal commands and hooks to the active project directory.
- Repair compiler/linker diagnostic regexes.
- Stream ZIP/ATPACK extraction asynchronously with CRC/path/size checks; no GNU tar dependency.
- Handle download stream errors, aborted responses, bounded HTTPS redirects and partial-file cleanup.

# Changelog

## 0.3.0
- Project Editor redesigned after the AVR-MDF / SDCC-MDF family: a searchable MCU dropdown with a hover detail pane and characteristics line, a grouped ${…} variable menu with per-variable tooltips for hooks / output paths / the custom upload tool, live Windows-path validation with a disabled-Save guard, reveal-refresh of the MCU list (Board Manager edits reach the open editor without discarding unsaved changes), and a raw-option fallback that never erases hand-written optimization/programmer values.
- ${…} variables now expand in the custom upload TOOL path as well as its arguments; hooks gained git:hash / git:branch; the Optimization select in the Project Editor was rebuilt (its options were never populated, silently erasing the override on Save).
- Fixed the collapsed-views command (workbench.actions.treeView.pic.projectView.collapseAll), the post-import Memory-view refresh call and removed dead AVR-era import code.

## 0.2.1
- Unified the Project Editor, MCU Definitions (Board Manager), and Import Project webview naming and visual style.
- Replaced the legacy native-dialog importer with a guided, editable import wizard that validates before writing `pic-project.json`.
- Aligned XC32 DFP path handling with current Microchip documentation; made DFP resolution toolchain-specific.
- Added compiler-generated `-MD/-MF` dependency files to incremental XC16/XC32/XC-DSC C/C++ builds so changed DFP and local headers invalidate objects.
- Debug builds now define Microchip's documented `__DEBUG=1` (and preserve `DEBUG=1` compatibility).
- Live device-pack catalog updates are merged with the bundled fallback and applied immediately.
- Added Add… dialogs to the Import Project wizard for sources, include folders, libraries and components; external include/library paths are preserved.
- Fixed escaped-space handling in generated dependency files and ensured object paths containing spaces are quoted with `-MQ`.
- The project and import editors now use the same PIC-MDF window/header naming; project-level `default` optimization inherits the per-toolchain setting.

## 0.2.0 — complete project and MCU editors; safer incremental builds

- Replaced the placeholder MCU Manager notification with a full two-pane editor matching the AVR-MDF / SDCC-MDF card design. It supports substring search, source filters, create/edit/duplicate/delete, JSON open, import and export; built-in profiles are protected and user-created profiles remain update-safe.
- Upgraded Project Editor with editable Sources, Includes, Defines, Libraries and Components lists; native multi-select file/folder pickers; DFP and external-SDK folder pickers; project clock override; compiler flags, optimization, GC sections, LTO, upload settings and hooks.
- Connected component sources and their `inc` / `include` directories to the actual build, removed duplicate include flags, and implemented the documented `sources` / `components` JSON `pattern` filters.
- Applied project clock and optimization overrides to the toolchain commands; wired C/C++/assembly/link flags and supported GC-sections / LTO options.
- Replaced source-mtime-only incremental skipping for XC16/XC32/XC-DSC with command fingerprints and recursive project-local header / assembly-include content tracking. A failed compile cannot save a fresh fingerprint.
- Added project clock and optimization validation; made the board import flow ignore invalid JSON profiles.

## 0.1.0 — initial release (four architectures, one extension)

- **Unified Microchip PIC framework.** One extension drives **four** Microchip compiler toolchains, each selectable per project via the `toolchain` field in `pic-project.json`:
  - `xc8` — 8-bit PIC (baseline / mid-range / enhanced mid-range / PIC18), one-step `xc8-cc` (emits ELF + HEX directly).
  - `xc16` — 16-bit PIC24 / dsPIC33, `xc16-gcc` compile → link (`-T p<device>.gld`) → `xc16-bin2hex`.
  - `xc32` — 32-bit PIC32M (MIPS) and PIC32C (ARM), `xc32-gcc`/`xc32-g++` → `xc32-bin2hex`.
  - `xcdsc` — dsPIC33A/C/E/F + dsPIC30, `xc-dsc-gcc`/`xc-dsc-g++` → `xc-dsc-bin2hex`.
- **Toolchain detection** from a configured root, explicit per-compiler settings, `PATH` and the standard install locations; binutils and the device list are resolved per toolchain (from `deviceSupport.xml` where shipped, device headers / linker scripts otherwise).
- **MCU database** with a curated starter set across all four architectures; user boards live update-safe in `~/.pic-mdf/boards`; a project may keep `.pic/boards` overrides.
- **Build pipeline** — batched compilation (one terminal batch, the link step carries the exit marker), incremental rebuilds (object newer than source), and the stale-object guard.
- **Memory report** from `objdump -h` section sizes mapped per architecture, with `nm` symbol sizes and a persisted build history.
- **Configuration Bits editor**, chip erase, EEPROM/data upload & download through the Microchip programmer CLIs (`ipecmd`, `pk3cmd`, `pk2cmd`, `nw_prog`, custom).
- **Serial Monitor**, **XC Reference**, **tasks.json / launch.json / IntelliSense** sync, and an **Import** wizard for MPLAB X and Makefile projects.
- Shares the proven infrastructure of the AVR-MDF / SDCC-MDF / ESP8266-IDF family (terminal + exit-code markers, pinned shell, Problems panel, busy gate).
