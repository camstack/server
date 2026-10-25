# `navigation` — robot-camera drive/action cap + Dreame provider

> Status: **foundation landed** (2026-09-06, `feat/navigation-cap`); **panel, PTZ mimic, light
> read-back and router spec landed** (same day, `feat/navigation-panel`). The
> cap (`packages/types/src/capabilities/navigation.cap.ts`) is complete and
> codegen'd; the Dreame provider wires every COMMAND through raw MIoT primitives
> and lands a best-effort status slice with a clear TODO. The admin-UI panel +
> the PTZ-mimic adapter are specified here but NOT yet built. Read with
> `packages/types/src/capabilities/ptz.cap.ts`,
> `packages/addon-provider-dreame/src/devices/dreame-camera-device.ts`,
> `packages/addon-provider-dreame/src/devices/dreame-navigation-actions.ts`,
> `packages/addon-provider-dreame/src/devices/dreame-navigation-config.ts`.

## What this delivers

A robot vacuum with an on-board camera (Dreame X50 / r2538z, LinkVisual video)
DRIVES ITSELF — it has no gimbal. `ptz` models a lens gimbal (absolute
pan/tilt/zoom + presets); a robot needs momentary drive nudges plus discrete
ACTIONS (dock, spot-clean, follow-pet, go-to-point, …). Those are a different
physical model, so this is a NEW cap, not an overload of `ptz`.

`navigation` is the SOURCE OF TRUTH. Two consumers adapt FROM it: (1) a native
CamStack navigation panel, data-driven from `listActions` / `getFeatures`; and
(2) the PTZ surface, via a thin adapter that mimics `ptz` from `navigation`.

## The cap shape

`navigation` — `scope: 'device'`, `deviceNative: true`, `mode: 'singleton'`,
`deviceTypes: [Camera]`, `deviceConfig.ui` = widget `host/navigation-panel`
(top-tab), `status.kind: 'push'`, `runtimeState` (durability `session`).

General primitives (first-class methods):

| Method | Kind | Purpose |
| --- | --- | --- |
| `move({pan,tilt,speed?})` | mutation | momentary drive nudge — pan = turn L/R, tilt-up = forward, tilt-down = spin. Normalized [-1,1]. |
| `stop()` | mutation | immediate halt (zero drive vector) |
| `goToPoint({x,y})` | mutation | send the robot to a map coordinate |
| `runAction({actionId})` | mutation | run one discrete dictionary action |
| `playSound({soundId})` | mutation | play a sound by wire id |
| `setLightOn({on})` | mutation | fill-light on/off (`OpenFullLight` — works anytime) |
| `setLightMode({mode,level?})` | mutation | auto/manual (camera-service; needs active stream) |
| `setLightLevel({level})` | mutation | manual level 40..100 (implies manual) |
| `listActions()` | query | data-driven dictionary of `{id,kind,label,icon,soundId?,enabled}` |
| `getFeatures()` | query | per-device feature-flag report for the general primitives |
| `getStatus()` | query (auto) | `{mode,following,flash,lightMode,lightLevel,lastChangedAt}` |

All command methods are `protected` (not `admin`) — deliberately matching
`ptz.move` / `ptz.continuousMove` so the Viewer navigation panel and the
PTZ-mimic path work for any authenticated user.

### Continuous drive (the fluid feel)

`move` is MOMENTARY and STATELESS per call. Fluid navigation comes from the UI /
PTZ adapter sending `move({pan,tilt})` at **1 Hz (1000 ms)** while a direction is
held, and ONE `stop()` on release (clearInterval + a final zero write) — exactly
like the robot app's remote-drive joystick. The provider forwards EACH move to a
single drive write and must NOT debounce or coalesce. Directions map to the
RE'd vectors: forward `spdv 200`, left `spdw 45`, right `spdw -45`, spin
`spdw 180`, stop `0/0`. The drive payload's `audio` field is `"true"` on the
FIRST move of a press gesture (plays the cue once) and `"false"` on every 1 Hz
repeat — the UI passes `gestureStart` (a helper arg on `moveCommand`); the cap
`move` stays stateless.

### Data-driven action dictionary + per-action feature flags

`NAVIGATION_ACTION_CATALOG` is the shared dictionary (actions + sounds), each
entry `{id, kind:'action'|'sound', label, icon (lucide hint), soundId?, enabled}`.
`kind:'action'` entries trigger `runAction({actionId})`; `kind:'sound'` entries
trigger `playSound({soundId})`. `listActions()` returns the dictionary with the
per-entry `enabled` flag resolved for THIS device, and `getFeatures()` reports
the general-primitive flags — so the UI / PTZ render ONLY enabled controls.

Feature flags are DATA (`dreame-navigation-config.ts`:
`DREAME_NAVIGATION_DEFAULT_FEATURES` + `DREAME_NAVIGATION_DISABLED_ENTRY_IDS`),
so enabling / disabling one later is a config change, not code. **Default for
Dreame: `goToPoint` is OFF** (needs map-coordinate plumbing not yet wired); every
other primitive and every dictionary entry default ON. This mirrors the
camstack `getOptions`/descriptor availability convention (D14) rather than the
coarse product-level `FeatureManifest`.

## Where it is attached — a NEW device

Registered on a NEW camstack device, `DreameCameraDevice` (`DeviceType.Camera`),
spawned by `DreameContainerDevice.getAccessoryChildren()` ONLY for camera-capable
vacuums (`vacuumCapabilities.hasCamera`, gated via `vacuumSupportsCamera`). The
existing `DreameVacuumDevice` (vacuum-control / consumables / maps) is untouched.
The camera child's `stableIdSuffix` is `camera`, so its deviceId derives
deterministically from the vacuum container.

**Prebuffer OFF:** the camera device advertises `DeviceFeature.BatteryOperated` —
the SAME flag the Reolink battery-camera path uses (`deriveReolinkCameraFeatures`).
The stream-broker's `getEffectivePreBufferSec` battery rule then sets
`preBufferSec = 0`, so the camera (expensive to cold-start on a battery robot)
streams on demand and is never continuously prebuffered.

## Provider wiring (raw MIoT)

`dreame-navigation-actions.ts` is the single pure seam translating the cap
surface into the RAW primitives the currently-published
`@<github-account>/nodedreame@^1.11.11` already exposes on every handle
(`callAction(siid,aiid,in)` / `setProperty({siid,piid,value})`):

- drive: `setProperty({siid:4,piid:15,value:{spdv,spdw,audio,random,timestamp}})`.
- goHome `callAction(3,1,[])`; locate `callAction(7,1,[])`;
  spotClean `4/1 [{1:20}]`; findPet `4/1 [{1:22},{10:'{"findpet":""}'}]`;
  personFollow `4/1 [{1:26}]`; stop-all `4/2 []`;
  goToPoint `4/1 [{1:23},{10:{spoint,tpoint}}]`;
  startClean `2/1`; pauseClean `2/2`; dockWash `4/4`; autoEmpty `15/1`.
- light on/off: `setProperty({siid:4,piid:50,value:{k:"FillinLight",v:0|1}})`.
- light mode/level: `callAction(10001,3,[{piid:9,value:"40".."100"|"101"}])`
  (string; "101" = auto). CAMERA-service — needs an active stream.
- sounds: `callAction(7,2,[{piid:4,value:<id>}])` (684 Meow … 688 Tick-tock).

**Future swap:** the richer typed `DreameCameraController` (drive / playPetSound /
spotClean / findPet / runVacuumAction; PET_SOUNDS / VACUUM_ACTIONS / VACUUM_MOVE
constants) exists only on the UNPUBLISHED local `nodedreame`
(`feat/video-linkvisual`). When it publishes, `dreame-navigation-actions.ts` +
the dispatch in `dreame-camera-device.ts` are the only files that change; the cap
contract is unaffected.

## PTZ-mimic mapping — REJECTED (2026-09-06)

Built and removed the same day: the operator wants `navigation` and `ptz` to stay two
separate things. Admin UI shows two tabs; the viewer's one controls panel shows the
navigation controls when the device has the cap. The table below is kept as the record of
what a projection would have mapped, not as a plan.

An adapter presents `navigation` as `ptz` for the admin UI and the PTZ control
path. It lives in the adapter, never merged into either cap:

| `ptz` call | `navigation` call |
| --- | --- |
| `continuousMove({pan,tilt})` / `move` | `move({pan,tilt})` (zoom ignored); UI drives the 1 Hz cadence + `stop()` on release |
| `stop()` | `stop()` |
| `goHome()` | `runAction('goHome')` |
| `getPresets()` | `listActions()` → `{id, name:label}` for `kind:'action'` |
| `goToPreset(id)` | `runAction(id)` |
| `getOptions()` | derive `{hasPan:true,hasTilt:true,hasZoom:false,supportsPresets:true}` from `getFeatures()` |

## Remaining TODOs

1. **Live status decode.** `mode` is mapped from the shared vacuum state;
   `flash` / `following` / `lightMode` / `lightLevel` are tracked OPTIMISTICALLY
   from issued commands. There is no confirmed read-back decode of the packed
   fill-light property (`4/50`) or the follow flag. Add a decode in
   `DreameCameraDevice.recomputeSlice`.
2. **`goToPoint` map-coordinate plumbing** — resolve a tap on the live map to
   robot coordinates, then flip `DREAME_NAVIGATION_DEFAULT_FEATURES.goToPoint` on.
3. **Per-device / per-addon feature-flag overrides** — merge config on top of
   the data-driven defaults in `buildFeatures()` / `dreameNavigationCatalog()`.
4. **Admin-UI navigation panel** (`camstack-viewer`): a widget registered as
   `host/navigation-panel` (see `deviceConfig.ui`) — joystick + data-driven
   action/sound buttons + a light on/off toggle + an auto/manual selector + a
   manual level slider shown ONLY when `mode === 'manual'`.
5. **PTZ-mimic adapter**: implement the table above.
6. **Swap to the typed `DreameCameraController`** once `nodedreame` publishes it.
7. **Cap-router spec** in `server/backend/src/__tests__/cap-routers/`.
