---
title: The Windows agent — the desktop app as an agent node on Windows x64
applies-to:
  - packages/desktop/scripts/node-bundle.mjs
  - packages/desktop/scripts/stage-deps.mjs
  - packages/desktop/scripts/winsw-bundle.mjs
  - packages/desktop/scripts/png-to-ico.mjs
  - packages/desktop/src/node-env.ts
  - packages/desktop/src/windows-service/service-manager.ts
  - packages/desktop/src/windows-service/service-script.ts
  - packages/desktop/src/windows-service/supervisor.ts
  - packages/desktop/src/windows-service/winsw-config.ts
  - packages/types/src/deps/python-downloader.ts
  - packages/types/src/deps/zip-extract.ts
  - packages/types/src/deps/archive-extract.ts
  - packages/types/src/util/owner-only-file.ts
  - packages/system/src/builtins/platform-probe/windows-hardware.ts
  - packages/addon-pipeline/python/pool_platform.py
last-verified: 2026-10-13
---

# The Windows agent

The Electron desktop app can run as an **agent** node on Windows x64: the same
app, the same `@camstack/server` closure, the same agent role as macOS and
Linux. This page is what was done to make that true, **what has been checked
and what has not** (everything below was built on a Mac, with no Windows host),
and how to install and test it on one.

Hub on Windows is out of scope. ARM64 Windows is out of scope (no pinned
ffmpeg/Python build is verified for it; the code refuses it by name).

## What changed, by blocker

| # | Blocker | What now happens |
| --- | --- | --- |
| 1 | The bundled Node was a Linux/macOS tarball with `bin/node`; on Windows the app silently fell back to Electron-as-Node (the V8 external-buffer problem) | `packages/desktop/scripts/node-bundle.mjs` picks the archive per platform (`.zip` with `node.exe` at the root on Windows), verifies it against nodejs.org's `SHASUMS256.txt` **on every platform** before extracting, and `resolveBundledNode` looks for `node/node.exe`. node-av's Windows prebuild is `@seydx/node-av-win32-x64-msvc` (there is no bare `win32-x64` package). |
| 2 | Portable Python threw on win32, hard-coded `bin/python3`, shelled out to `unzip` | Same upstream release (`python-headless-3.12.12-windows-x86_64.zip`, interpreter at `bin/python.exe`); every Python target now has a pinned SHA-256 verified before extraction; zips are unpacked in-process on Windows (`zip-extract.ts`: zip-slip and CRC checked), tarballs by System32's `tar.exe`. |
| 3 | `inference_pool.py` imported `fcntl` and `resource` at module level — and asyncio cannot adopt Node's child stdin/stdout pipes on Windows | `pool_platform.py`: `flock` on POSIX / a one-byte `msvcrt` range lock on Windows; `psapi` for memory; on Windows stdin is read on a thread and stdout written through an executor. Linux/macOS take the same calls as before. |
| 4 | No `win32-x64` ffmpeg | jellyfin-ffmpeg `win64-clang-gpl` zip, same release and feature set as the other targets — see [ffmpeg.md](ffmpeg.md). |
| 5 | The hardware probe read only `/sys` | `windows-hardware.ts`: GPU vendor/model and the AMD XDNA NPU (`VEN_1022&DEV_1502` / `DEV_17F0`) from WMI via PowerShell, `wmic` as the fallback, bounded, never blocking boot. NVIDIA keeps `nvidia-smi` for exact VRAM. OpenVINO's requirements install on win32; **WebGPU is not scored, offered or installed there** until it has its own device key. |
| 6 | `chmod 0600` is a no-op on Windows, so `agent.json` (the mesh key) was readable by every local user | `@camstack/types/node` `writeOwnerOnlyFileSync` & co: chmod on POSIX; on Windows `icacls` (owner + SYSTEM, no inheritance) applied to the still-empty temp file *before* the secret is written. A failure is raised, not swallowed. `scripts/check-secret-files-owner-only.ts` refuses a new bare `0o600`. |
| 7 | Startup was a login item only | Opt-in **Run as Windows service** — see below. The login item stays the default. |
| 8 | No `icon.ico`; unknown whether a Windows build packages | `packages/desktop/scripts/png-to-ico.mjs` packs the icon (no ImageMagick). `electron-builder --win` produced both `win-unpacked` and an NSIS installer from macOS **without wine**. The release workflow's Windows leg is still off (TODO in `release.yml`). |

## The Windows service (opt-in)

Tray → **Run as Windows service (starts at boot)**, agent role, installed app
only. The choice, and why, is [D846](../decisions/adr-0846-the-windows-agent-service-is-a-pinned-winsw-around-a-supervisor-and-never-runs-user-writable-code.md).

What it is: WinSW (`WinSW.NET461.exe` v2.12.0, pinned and SHA-256-verified **at
build time**, shipped as `resources/service/winsw.exe`) running
`node.exe service-supervisor.js starter.js`. The supervisor relaunches the
starter on *any* exit — WinSW alone restarts only on an error exit, and the node
asks for its own restart (an update) by exiting 0, so without it the agent would
go offline after its first update. The environment is the one the shell gives
its child (`node-env.ts`, one builder for both).

How it is installed: one UAC-elevated, `-EncodedCommand` PowerShell. The XML
travels inside the script (not as a temp file someone could swap), the service
directory and the service data directory are locked to Administrators + SYSTEM
*before* anything is written, and the outcome is logged to
`%ProgramData%\CamStack\service-last-action.log` so a failure can be explained.

Rules it enforces (a service runs as SYSTEM, so it must not run code a user can
write):

- **Installed for all users only.** The NSIS installer defaults to per-user
  (`%LOCALAPPDATA%`); the toggle refuses to install unless the app lives under
  `Program Files`, and says "reinstall choosing *Install for all users*".
- **Its own data dir**, `%ProgramData%\CamStack\agent-data` (admin-only),
  seeded with the user's `agent.json` only. The user's data dir holds the addons
  the node executes and is user-writable. **Consequence:** while the service is
  on, changing the hub address or secret in the setup window changes the user's
  copy, not the service's — toggle the service off and on to carry it over (or
  edit through the agent's own status page).
- The app never starts a second node while the service owns it (one port, one
  node id).

## Install steps (a Windows x64 host)

1. Build on a Windows host (the build host's platform *is* the target platform;
   `stage-deps` is not a cross-builder): `npm ci`, then
   `npm run desktop:dist:win` (= `build` + `stage-deps` + `electron-builder --win`).
   Needs Node 24, `curl.exe` and `tar.exe` (both ship with Windows 10 1803+).
2. Run `CamStack-Setup-<v>.exe`. For the service, choose **Install for all
   users**.
3. First launch: role **Agent**, hub address (or automatic). The setup window asks for
   no secret (D857): the hub pairs the agent (System → Cluster → Agents, the same six digits on
   both screens).
4. Optional: tray → *Run as Windows service*, accept UAC. Check
   `Get-Service CamStackAgent` and `%ProgramData%\CamStack\service\logs`.
5. Remove: tray → untick the same item (UAC again), then uninstall normally.

## Verified, and not

Verified on the Mac that produced this (unit tests with platform / fs /
child_process fakes, plus real artifacts):

- The real `python-headless-…-windows-x86_64.zip` and the real ffmpeg zip
  extract byte-for-byte with the in-process extractor; the real
  `node-v24.x-win-x64.zip` is checksum-verified against nodejs.org and its
  `node.exe` extracted with the exact argv `stage-deps` uses.
- The ffmpeg build's configure string (`--enable-dxva2 --enable-d3d11va
  --enable-d3d12va --enable-amf --enable-libvpl --enable-nvenc …`) was read out
  of the binary. It was **not run**.
- `electron-builder --win --dir` and the NSIS installer build from macOS; the
  unpacked tree has `resources/node/node.exe`, `resources/service/winsw.exe`,
  `resources/service/service-supervisor.js`.
- The supervisor's relaunch-on-clean-exit loop runs (smoke-tested with a fake
  starter) and stops on SIGINT.
- Python tests of the pool seams on POSIX, with a fake `msvcrt`.

**Needs a real Windows host** (none of this has ever executed on Windows):

- The bundled `node.exe` running the starter; `better-sqlite3`'s
  `prebuild-install` for win32; node-av's `-msvc` prebuild loading; `sharp`.
- Portable `python.exe`, pip wheels for `onnxruntime` / `openvino` on Windows,
  and the pool actually talking to the host over the threaded stdio and holding
  `msvcrt.locking` / `psapi` as modelled.
- The shape of the real WMI/`wmic` output (the parsers accept the object and
  array forms PowerShell emits and `wmic`'s CSV header), and that the AMD NPU
  shows up under `Win32_PnPEntity`.
- `ffmpeg.exe -hwaccels` (`expectedHwaccels` claims only `d3d11va`, `dxva2`).
- `icacls` doing what the helper assumes, including the principal string.
- WinSW install/start/stop, the UAC script, SCM recovery, a service update
  cycle, and `electron-updater` replacing files a running service holds open
  (stop the service before an app update — not automated yet).
- Whether `electron-builder` embedded the icon and signed anything: on a Mac
  without wine, resource editing and Authenticode are skipped or best-effort.
- Graceful stop: a child of the app is stopped with `kill()`, which on Windows is
  `TerminateProcess` — no flush, no shutdown handlers. Fine for an agent today
  (no SQLite on agents); it is a gap for anything that needs a clean exit.

## Where the code is

| | |
| --- | --- |
| Node staging, archive shapes, checksums | `packages/desktop/scripts/node-bundle.mjs`, `stage-deps.mjs` |
| Pinned WinSW | `packages/desktop/scripts/winsw-bundle.mjs` |
| Service definition, installer script, manager, supervisor | `packages/desktop/src/windows-service/` |
| Shared node environment | `packages/desktop/src/node-env.ts` |
| Owner-only files | `packages/types/src/util/owner-only-file.ts` (shell: alias `@camstack/owner-only-file`, `tsup.config.ts`) |
| Archive extraction | `packages/types/src/deps/archive-extract.ts`, `zip-extract.ts` |
| Windows hardware probe | `packages/system/src/builtins/platform-probe/windows-hardware.ts` |
| Python pool seams | `packages/addon-pipeline/python/pool_platform.py` |
