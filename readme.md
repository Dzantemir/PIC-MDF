<h1 align="center">PIC-MDF</h1>

<p align="center">
  <strong>Microcontroller Development Framework</strong> — build, flash, configure and monitor <b>Microchip PIC</b> projects across <b>FOUR architectures</b> with ONE VS Code extension:<br>
  <b>8-bit PIC</b> (XC8) · <b>16-bit PIC24 / dsPIC33</b> (XC16) · <b>32-bit PIC32M / PIC32C</b> (XC32) · <b>dsPIC33A/C/E/F + dsPIC30</b> (XC-DSC)
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-0.4.2-orange">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green">
  <img alt="platform" src="https://img.shields.io/badge/platform-Win%20%7C%20Linux%20%7C%20macOS-lightgrey">
</p>

---

## Highlights

- 🧩 **One extension, four architectures** — the compiler (`xc8` / `xc16` / `xc32` / `xcdsc`) is chosen **automatically from the selected MCU** — there is no toolchain setting to maintain. Each project compiles with the matching Microchip compiler from a single, unified UI.
- ⚙️ **Native Microchip drivers** — the extension drives the real command-line tools: `xc8-cc`, `xc16-gcc`, `xc32-gcc`/`xc32-g++`, `xc-dsc-gcc`/`xc-dsc-g++`, plus the device linker scripts (`-T p<device>.gld`), `bin2hex`, `objdump` and `ar`.
- 🗂️ **Device database + MCU Manager** — the same page design as avr-mdf / sdcc-mdf: a vendor-series tree with a filter and a source switcher, ⓘ tooltips on every field; search by any substring, filter built-in/global/folder/project profiles, create, edit, duplicate and delete custom MCU definitions, and import/export JSON profiles. Built-in profiles are read-only; custom definitions live update-safe in `~/.pic-mdf/boards` or project `.pic/boards` overrides. Memory sizes are in **bytes** everywhere (flash, RAM, EEPROM); 1926 of the ~2480 built-in MCUs carry sizes (see the changelog for the conventions and sources).
- 🔥 **Configuration Bits editor** — the PIC analogue of the AVR fuse editor: named config fields (or a raw hex editor) written as `#pragma config` statements on the next build.
- ⚡ **Programming** — `ipecmd` (MPLAB IPE), `pk3cmd`, `pk2cmd`, `nw_prog` or a fully custom `upload.tool` + args with `${…}` expansion; chip erase, EEPROM/data upload & download.
- 📡 **Serial Monitor** — port/baud dropdowns, a send line, timestamps and auto-scroll.
- 📊 **Memory report** — Flash / RAM / EEPROM bars against the device limits, top symbols (via `nm`), and a build history chart.
- 📚 **XC Reference** — a browsable catalogue of the common XC headers, delays, interrupts, SFR access, memory attributes, driver options and utilities.
- 🧱 **Components (main + `components/<name>/`)** — the application and every component have their own sources, include folders and **prebuilt `.a` libraries** (checked against the project's architecture), edited in the Component Editor from the sidebar — the esp8266-idf model.
- 🧰 **Card-based Project Editor** — configure macro defines, clock override, DFP, C/C++/assembly/link flags, optimization, LTO (XC32), upload and lifecycle hooks. Paths inside the project are stored relatively for portability.
- ✅ **tasks.json / launch.json / IntelliSense** write themselves (merge-only, add-if-missing).
- 📥 **Import** — `PIC: Import Project…` runs through the menu (the same flow as avr-mdf / sdcc-mdf): choose *MPLAB X project* (`nbproject/configurations.xml`), *Makefile* or *plain folder*, pick it, choose the MCU if the device has no definition, review the draft and confirm. Imported in place — only `pic-project.json` is written.

## Requirements

At least one Microchip compiler toolchain. The extension auto-detects them on `PATH`, under a configured root folder, and in the standard install locations. Set the paths explicitly if needed:

| Setting | Toolchain |
|---|---|
| `pic.rootPath` | the folder that contains `xc8/v*`, `xc16/v*`, `xc32/v*`, `xc-dsc/v*` |
| `pic.xc8.path` | MPLAB XC8 (8-bit PIC) |
| `pic.xc16.path` | MPLAB XC16 (16-bit PIC24/dsPIC33) |
| `pic.xc32.path` | MPLAB XC32 (32-bit PIC32M/PIC32C) |
| `pic.xcdsc.path` | MPLAB XC-DSC (dsPIC33A/C/E/F + dsPIC30) |

Optional: a Microchip programmer CLI (`ipecmd`, `pk3cmd`, …) for flashing.

## The four architectures

| Compiler id | Architecture | Driver | Device flag | HEX step |
|---|---|---|---|---|
| `xc8` | 8-bit PIC (baseline / mid / enhanced / PIC18) | `xc8-cc` | `-mcpu=<device>` | produced by `xc8-cc` directly |
| `xc16` | 16-bit PIC24 / dsPIC33 | `xc16-gcc` | `-mcpu=<device>` | `xc16-bin2hex` |
| `xc32` | 32-bit PIC32M (MIPS) / PIC32C (ARM) | `xc32-gcc` / `xc32-g++` | `-mprocessor=<device>` | `xc32-bin2hex` |
| `xcdsc` | dsPIC33A/C/E/F + dsPIC30 | `xc-dsc-gcc` / `xc-dsc-g++` | `-mcpu=<device>` | `xc-dsc-bin2hex` |

## Quick start

1. Install a Microchip compiler (MPLAB XC8/XC16/XC32/XC-DSC); the extension finds it automatically.
2. **Create New Project** (sidebar) → name → device → a fresh folder (the compiler follows the device).
3. Write code in `src/main.c` (the template blinks) → **Build** (`Ctrl+Alt+B`).
4. Pick a programmer and **Flash** (`Ctrl+Alt+F`); the Serial Monitor opens automatically.

## The sidebar

| View | What it gives you |
|---|---|
| **Project & Commands** | Create / Import / Manage MCU definitions, live config status, the **MCU** row, the **Components** group (main + components, checkbox = enable / disable), **Actions** (Build / Flash / Clean / Disassembly), **Device** (Configuration Bits… / Chip Erase / EEPROM upload & download), **Port Settings** |
| **Memory** | usage bars with threshold, top symbols, build-history chart |
| **Serial Monitor** | port/baud dropdowns, Connect/Disconnect, timestamps, send line |
| **Development Tools** | the four toolchains with live binutils/device counts |
| **XC Reference** | headers, delays, interrupts, SFR access, driver options |

## Components

The project is **main** (the application — `sources` / `includes` / `libraries` of `pic-project.json`) plus any number of **components**, laid out exactly like in esp8266-idf. The *Project Editor* has no Sources / Includes / Libraries / Components cards and no Output directory field — everything lives in the sidebar group **Project Folder → 📦 Components**:

- click a component → the **Component Editor**: its sources (folder, file or `{"path":"src","pattern":"**/*.c"}` rule), include folders, **prebuilt libraries** (`.a` — add with *Add…*, copied into `<component>/lib` or referenced in place) and `requires`; every library is inspected — an archive built for another architecture than the one of the selected MCU (8-bit PIC / PIC24·dsPIC / PIC32) is flagged before the link fails — and the editor shows what the build will really use;
- the checkbox enables / disables a component (`disabled_components` in `pic-project.json`); inline buttons add libraries, edit or delete;
- toolbar: **New Component…** (source / prebuilt template) and **Add Existing Component…** (a folder outside the project, referenced in `components`);
- a component keeps its settings in `components/<name>/component.json` (`description`, `sources`, `includes`, `libraries`, `requires`; paths relative to the component). A folder **without** `component.json` works as before: every source below it is compiled, `inc/` / `include/` join the include path.

Build: the sources of main and of every component are compiled to `build/obj/**` and linked together, then the prebuilt libraries — main's first, then the components' in `requires` order (several libraries go into one `--start-group`). Include folders are global (one compiler command). For **XC8** the libraries ride on the `xc8-cc` command line (before 0.4.0 the XC8 pipeline ignored libraries entirely). The output folder is `build` (or `build.output_dir` if you set it by hand in `pic-project.json`).

## The compiler follows the MCU

There is no *Toolchain* setting any more (no card in the Project Editor, no sidebar row, no `Ctrl+Alt+T`). The compiler is derived from the selected device — the MCU definition names it, otherwise the device name decides (PIC10/12/16/18 → XC8, PIC24/dsPIC → XC16 or XC-DSC, PIC32 → XC32). An old `toolchain` key in `pic-project.json` is still honoured when the MCU says nothing, and is dropped the next time the project is saved from the Project Editor.

## Project layout

```
my-project/
├─ pic-project.json     # the project file (visual editor: ✎ in the tree)
├─ src/                 # the application (component "main"): .c/.cpp/.s/.S sources (recursively)
├─ include/ lib/        # the application's headers and prebuilt .a libraries
├─ components/<name>/   # one component each: component.json, src/, include/, lib/*.a …
└─ build/               # obj/** (application AND components), firmware.elf/.hex/.map
```

Minimal `pic-project.json`:

```json
{
  "name": "blink",
  "board": "pic18f4550",
  "sources": ["src"],
  "build": { "output_dir": "build", "output_name": "firmware" }
}
```

## Incremental builds

For XC16, XC32 and XC-DSC, PIC-MDF tracks compiler arguments plus the contents of project-local headers and assembler `.include` files. An unchanged object is reused only when its stored build fingerprint still matches; changing a nested header or compiler option triggers recompilation. XC8 uses the one-step driver and performs a full build.

## License

[MIT](https://github.com/Dzantemir/pic-mdf/blob/HEAD/LICENSE.txt) © Dzantemir
