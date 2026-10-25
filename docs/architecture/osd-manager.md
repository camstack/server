---
title: OSD Manager
last-verified: 2026-10-04
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
(bindings) and **Templates** (named multi-device parsers). Cameras sit in the
shared `DeviceList` (generic mode): search, capability filter, one accordion
row at a time. Unsupported cameras remain visible and explain that they expose
no writable OSD capability. An expanded row keeps the camera toolbar (render
now, duplicate) and a horizontally scrollable slot tab strip — the active
writable slot's editor is always mounted (no per-slot Edit); a read-only slot
tab shows an explanation instead.

Device picking reuses the shared `DevicePicker` from `@camstack/ui-library`
(same component as Notifications / Alarm). Unit conversion uses
`tryConvertUnit` / `UNIT_TABLE` from `@camstack/types`.

## Sources and rendering

A writable slot can use:

- literal text or a clock;
- a single device-state field (DevicePicker → adaptive field → optional
  display unit / decimals → `${value}` / `${unit}` slot template);
- a **named template** (`source.kind: 'template'`) that evaluates a parser
  with `{alias}` tokens; each binding names a leaf device (optionally via a
  container → child pick), field, format (`value+unit` | `value` | `unit`),
  display unit and decimals;
- the latest identified person;
- the latest recognized plate.

Named templates are first-class (`listTemplates` / `upsertTemplate` /
`deleteTemplate`), stored under the osd-manager settings key — the page's
**Templates** tab. A template is a parser string with `{alias}` tokens; each
binding on a camera slot picks a leaf device (optionally container → child),
the field, format chip (`value+unit` | `value` | `unit` / full), display unit
and decimals. The **alias follows the chosen leaf** (not the container name),
so renaming or re-picking a child updates the token the parser sees. Unit
conversion uses `tryConvertUnit` / `UNIT_TABLE` via the shared `UnitPicker`.
Formatting, value maps, schedules and supported Notification Center
conditions are evaluated before writing. Identical text is not written twice.
The old `conditions.devices` camera scope remains readable for compatibility
but is no longer offered: a binding is already scoped to its camera and slot.

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
