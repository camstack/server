---
title: OSD Manager
last-verified: 2026-11-10
applies-to:
  - packages/addon-osd-manager/**
  - packages/types/src/capabilities/osd-manager.cap.ts
  - packages/types/src/capabilities/osd.cap.ts
  - packages/addon-post-analysis/src/pipeline-analytics/*gallery*
---

# OSD Manager

OSD Manager binds camera-owned text overlay slots to CamStack values. The text
is burned into the camera video by the camera itself; OSD Manager decides what
to write and when.

Its federated page lives under **Detection → OSD Manager**. The page shell
matches the Notifications / Alarm revamp (`AdminPage` gutter, icon header,
centered loading and empty states, content in a `Card`). Two tabs: **Cameras**
(bindings) and **Templates** (named device templates). Cameras sit in the
shared `DeviceList` (generic mode): search, capability filter, one accordion
row at a time. Unsupported cameras remain visible and explain that they expose
no writable OSD capability. An expanded row keeps the camera toolbar (render
now, duplicate) and a horizontally scrollable slot tab strip — the active
writable slot's editor is always mounted (no per-slot Edit); a read-only slot
tab shows an explanation instead.

Device values are picked with the shared `DeviceTemplateField` from `@camstack/ui-library`
(the same field as Actions and Notifications).

## Sources and rendering ([D1029](../decisions/adr-1029-the-osd-text-is-a-device-template-the-clock-and-the-last-recognition-are-template-variables.md))

A writable slot's source is one of three kinds (`OsdSourceSchema`): `none`
(blank overlay text; the binding stays so CamStack owns the slot), `static`
(literal text) and `template`, which points at a **named template**. A named
template (`listTemplates` / `upsertTemplate` / `deleteTemplate` / `previewTemplate`,
stored under the osd-manager settings key) is `{ id, name, text }`. The text is a
**device template** (D1021): `{{ garage.temperature | unit('°C') | round(1) }}`,
`{% if garage.humidity > 60 %}damp{% endif %}`. Aliases are the device aliases of
the rest of CamStack; there is no second binding shape. The editor's "insert a
device value" button writes them, and `round(0)` gives the whole numbers some
firmware needs.

Three names are not devices:

- `camera` is the camera the slot is rendered for, so ONE template serves every
  camera and copying a camera copies nothing device-specific;
- `now` is the server time (`{{ now | time('HH:mm') }}`);
- `camera.lastPerson` / `camera.lastPlate` are the latest recognitions (empty text
  when there is none).

The manager renders only through `deviceManager.renderDeviceTemplates`, passing
`thisDevice` with the two recognition values. Schedules and Notification Center
conditions (the gate) are evaluated before rendering; identical text is not
written twice. A **refused or unavailable** render (a device that cannot be read,
a template error) keeps the last good text on the camera, logs once per reason
with `tags: { deviceId }`, and never writes an error string to the overlay
(the slot reports `unreadable`).

### Re-render on events, throttled

The manager does not poll the devices a text reads. `checkDeviceTemplates` tells
it which devices a template reads (and whether it reads `now`); it subscribes to
`DeviceStateChanged` for those devices and re-renders only the slots that read
the one that changed. A slot renders at most once per `SLOT_RERENDER_THROTTLE_MS`
(a leading render, then one trailing render at the end of the window). A template
that reads `now` re-renders on the minute (`CLOCK_RERENDER_MS`). The interval timer
(60 s by default) is a safety net, not the freshness mechanism. The dependency
lookup is cached per template text for a few minutes.

### Migration

`osd-manager/2026-11-10-bindings-to-templates` (D987, owned by the addon) rewrites
every slot binding and named template of the old shapes into template text: parser
tokens, per-binding display unit, decimals and value map, the slot `${value}`
template, and the `clock`, `device-state` and `latest-recognition` sources. It is
idempotent, keeps the ledger snapshot for rollback, and a binding whose device cannot be
converted to a known device keeps a `device_<id>` placeholder alias that renders `—`; a slot over the length limit or malformed is disabled (source `none`) and a named template that cannot be converted keeps its name with an empty text, each named in a log line, so one bad row never blocks the other cameras. Decimals are cut with the engine's `trunc(n)` filter like the old formatter, a boolean reads through `onoff`, and the expression never depends on the live value. A clock in a custom timezone becomes the server zone. See the ADR for the
semantic differences.

URL restore on the federated page keeps `?tab` / `?device` / `?slot` so a
deep link opens the same camera and slot editor.

## The work list is an INDEX, not a boot scan

The render loop needs the set of cameras that have at least one binding. That
set used to be derived at boot — list the directory, read every device's binding
block, keep the non-empty ones — one UDS round-trip to the settings store at a
time. Measured on the 2026-08-19 boot: 976 devices × 559 ms under boot load =
**546 s in which `OsdManager.start()` had not returned**, and `start()` is
awaited inside `onInitialize()`, so for nine minutes the `osd-manager` and
`addon-pages-source` capabilities existed nowhere in the cluster
([addon-lifecycle.md](addon-lifecycle.md#initialize-is-on-the-critical-path-of-the-whole-capability-graph)).
The answer it took nine minutes to compute was `boundDevices = 0`.

The set is now written where the bindings are written
(`packages/addon-osd-manager/src/bound-index.ts`, key `boundDeviceIds`), so boot
reads one key. Three properties, none optional:

- `null` means "this hub has never written the index" — seed it from a scan. An
  empty **array** is the authoritative "nothing is bound". Collapsing the two
  turns a cold hub into a silently disabled one.
- The scan survives as a **background reconcile**, because an index nothing
  checks eventually lies. Its corrections log per device.
- A binding read that FAILS never unbinds ([D49](../decisions/adr-0049.md)), and
  a camera missing from a boot-time listing is left alone.

## Recognition authority

Cold start reads the camera-scoped Face and Plate Galleries, not a bounded
recent-track window. Lifecycle events provide a low-latency fast path, while
gallery events are authoritative for assignment, unassignment, deletion,
identity rename and corrected plate text.

Generation ownership prevents stale asynchronous hydration from overwriting a
newer gallery refresh. Tracks that began before a gallery invalidation cannot
reintroduce an identity that was just renamed, unassigned or deleted. This
holds for machine-initiated removals too: the gallery-sample reconcile of
[D207](../decisions/adr-0207-a-gallery-reference-without-a-blob-is-a-deleted-reference.md)
deletes a pixel-less sample through the operator's own delete path, so it
emits the same authoritative gallery events every other removal does.

## Copying camera configuration

`copyDeviceConfiguration` replaces the destination binding map and renders it
immediately. Configured writable source slots map to writable destination slots
by ordinal, because providers do not share slot identifiers. Read-only slots
are ignored and legacy camera-scope conditions are removed during the copy.

The server capability/router and generated clients must ship with the addon;
deploying only the federated page cannot expose a new mutation.
