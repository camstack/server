# Handover — Dreame `navigation` capability (camera device)

Branch: `feat/navigation-cap`. Status: **foundation complete, paused for later.**
Codegen green, full-repo `npm run typecheck` exit 0, Dreame tests 98 passed.
Full design rationale + mapping tables: `docs/design/2026-09-06-navigation-cap.md`.

## What this adds
A NEW capability **`navigation`** and a NEW camera device that exposes the Dreame
robot-vacuum *camera* control surface (drive the robot, presets, sounds, light).
It is deliberately separate from the existing `ptz`/`vacuum-control` caps and
from the existing `DreameVacuumDevice` (which is untouched).

## Files
- `packages/types/src/capabilities/navigation.cap.ts` — the cap (single source of
  truth; codegen derives routers/types/DeviceProxy). Device-scoped, `deviceNative`,
  `deviceTypes:[Camera]`, widget `host/navigation-panel`, `status:push`,
  runtimeState durability `session`.
  - Primitives (first-class methods): `move({pan,tilt,speed?})`, `stop()`,
    `goToPoint({x,y})`, `runAction({actionId})`, `playSound({soundId})`,
    `setLightOn`/`setLightMode`/`setLightLevel`.
  - `listActions()` → data-driven `NAVIGATION_ACTION_CATALOG` (actions + sounds,
    each `{id,kind,label,icon,soundId?,enabled}`).
  - `getFeatures()` → per-action feature flags (D14 descriptor convention).
  - status/runtimeState `{mode,following,flash,lightMode,lightLevel}`.
  - All command methods are `protected` (matches `ptz.move`, for the Viewer/PTZ path).
- `packages/addon-provider-dreame/src/devices/`:
  - `dreame-camera-device.ts` — NEW `DeviceType.Camera` device; registers `navigation`;
    advertises `DeviceFeature.BatteryOperated` → **prebuffer off** (broker
    `getEffectivePreBufferSec` → 0, same mechanism Reolink battery cams use).
  - `dreame-navigation-actions.ts` — pure raw-MIoT translation (`callAction`/`setProperty`).
    **This is the single seam** to swap for nodedreame's typed `DreameCameraController`
    once that ships in a published `@apocaliss92/nodedreame`.
  - `dreame-navigation-config.ts` — data-driven default feature flags; `goToPoint` OFF.
  - `dreame-container-*` + `dreame-child-class-factory.ts` — spawn the camera child
    only for camera-capable vacuums (`vacuumSupportsCamera` predicate,
    `stableIdSuffix:'camera'`, deviceId `<did>:camera`).
- `dreame-navigation-actions.spec.ts` (11 tests) + a `vacuumSupportsCamera` case.

## Wire actions (raw MIoT — in dreame-navigation-actions.ts)
- Drive (1 Hz while held, one stop on release): `setProperty({siid:4,piid:15,value:JSON.stringify({spdv,spdw,audio,random,timestamp})})`.
  forward 200/0 · left 0/45 · right 0/-45 · turn 0/180 · stop 0/0. `audio:"true"` first move of a gesture, else `"false"`.
- Presets: goHome `callAction(3,1)` · locate `(7,1)` · spotClean `(4,1,[{1:20}])` · findPet `(4,1,[{1:22},{10:'{"findpet":""}'}])` ·
  personFollow `(4,1,[{1:26}])` · stop `(4,2)` · startClean `(2,1)` · pauseClean `(2,2)` · dockWash `(4,4)` · autoEmpty `(15,1)`.
- Light: on/off `setProperty(4,50,'{"k":"FillinLight","v":1|0}')` (anytime); mode/level `callAction(10001, aiid3/piid9, "40".."100" | "101"=auto)` (camera-session gated).
- Sounds `callAction(7,2,[{4:<id>}])`: 684 meow · 685 woof · 686 footsteps · 687 purring · 688 tick-tock.

## Status 2026-09-06 (second pass, branch `feat/navigation-panel` off `db28c9d15`)
Done in this pass:
- **Admin-UI navigation panel** — `packages/ui-library/src/composites/cap-settings/NavigationPanel.tsx`,
  registered as `host/navigation-panel` in `widgets/host-widgets.ts`; driven by
  `hooks/use-navigation.ts` (1 Hz nudges while a drive button is held, one `stop` on release; the
  panel is data-driven from `listActions` / `getFeatures`; manual level slider only in manual mode).
- ~~PTZ-mimic adapter~~ — built, then REMOVED the same day on the operator's decision: `navigation`
  and `ptz` are two separate things (admin UI: two tabs; viewer: one controls panel that shows the
  navigation controls when the device has the cap). The robot camera registers `navigation` only.
- **Live status decode (light)** — `devices/dreame-navigation-status.ts` (pure, spec'd): `4/50`
  packed fill light → `flash`, `10001/9` → `lightMode`/`lightLevel`, applied in `recomputeSlice` on
  every push; a property the robot does not report leaves the command-driven value. `following` is
  still command-driven (no confirmed read-back).
- **Cap-router spec** — `server/backend/src/__tests__/cap-routers/navigation.router.spec.ts`.

Also done (same pass, second commit):
- **Follow read-back** — person-follow is a robot STATE (`MiotState.Following = 26`, the same
  value `personFollow` selects), so `decodeFollowing(handle.status)` now drives `following` and
  `mode: 'following'` from the shared vacuum status; nothing is command-driven any more except
  the light until its first read-back.
- **Per-device feature overrides** — `dreameChildSchema.navigationFeatures` (partial flags) and
  `navigationDisabledEntryIds`; `resolveNavigationFeatures` / `resolveDisabledEntryIds` merge them
  over the addon defaults (`dreame-navigation-config.ts`, spec'd). No UI control yet: these are
  set through the device config; a settings section is a follow-up if the operator wants one.

Third commit (after nodedreame 1.12.0 published):
- **Typed controller swap** — `dreame-navigation-actions.ts` now maps cap calls to
  `DreameCameraController` methods (`ControllerCall` data + `runControllerCall`, exhaustive);
  the camera device builds the controller lazily from the vacuum handle
  (`createCameraController({ accessCode? })`, PIN from `navigationAccessCode` on the child
  config), never `open()`s it, closes it on remove. The raw MIoT builders are gone.
- **`network-link` on the robot** (`DreameVacuumDevice`): `getCurrentSignal()` (bars at the
  robot's position off its Wi-Fi signal map — the cloud has no RSSI/SSID for these vacuums)
  at activation and every 30 min; bars → `signalPercentFromBars(bars, 4)`, 0 = unreached →
  wifi with unknown strength, null → keep. First read INFO, first failure WARN.
- Branch merged with `main` (network-link cap, D367/D368, 1.2.234); generated files
  regenerated over the merged tree.

Merged into `main` and published as 1.2.235 (2026-09-06 midday); the viewer's controls sheet
shows the navigation section (viewer commit `8354c64`).

## Still to do (priority order)
1. `goToPoint` map-coordinate plumbing (rotatePointInfo2Map equivalent), then flip its default flag ON.
3. Verify on the real robot: drive only while the stream is open, `fillinLightSet`, the `4/50`
   read-back shape, the bars at the dock.
4. Optional: a device-settings section for `navigationFeatures`, `navigationDisabledEntryIds`,
   `navigationAccessCode`.

## How to verify after resuming
`npm run codegen && npm run typecheck && npm run test -w packages/addon-provider-dreame`.
Remember: a `.cap.ts` edit without `npm run codegen` = silent drift (CI fails).
