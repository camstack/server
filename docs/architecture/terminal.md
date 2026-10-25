---
title: Terminal sessions and cameras
last-verified: 2026-09-15
applies-to:
  - packages/types/src/capabilities/terminal-session.cap.ts
  - packages/addon-admin-ui/src/pages/system/Terminal.tsx
covers:
  - packages/addon-terminal/**
---

# Terminal sessions and cameras

Terminal has two views over the same allowlisted profile:

- **Administration → Terminal** opens an interactive PTY on a selected node.
- A **Terminal camera** renders that profile as video for Viewer, grids,
  snapshots and recording.

A profile is a runnable **template**, not a camera. Camera identity is an
explicit, operator-created **instance**: a durable row carrying its own node
placement, profile, name and spawn overrides, whose stable id is
`terminal-camera-instance-<uuid>`. Nothing is declared because a node advertises
a profile, so two Glances instances on one node are two separate cameras.

Cameras from the earlier automatic node × profile declaration are surfaced as
**legacy migration candidates** (`listLegacyCameras`). Only a legacy `monitor`
camera still holding its original `terminal-camera-<nodeId>` id is adoptable,
and adopting it keeps that id so existing bindings and layouts survive.
Deleting or disabling an instance writes a durable tombstone, so a failed device
removal can never make that camera reappear or become adoptable again.

## Profiles and settings

BTM, Top and Glances are built-in profiles. Each has per-node enablement,
executable override and exact argument-array settings. Custom profiles add a
fixed executable, arguments, cwd and `NAME=value` environment entries. Those are
the per-node **template** values.

An instance may override its template's executable, arguments, cwd and
environment for its own camera, and may carry a **per-instance settings bag**
for profiles that export a schema (`TerminalProfileInfo.settingsSchema`). Only
Glances exports one today: nine panel switches that materialise into a single
`--disable-plugin` argument at spawn (`profile-settings.ts`). A settings bag
never becomes a free-form command — the instance still names a profile, and the
profile still owns the binary unless the instance sets an explicit override.

The optional interactive shell is a separate, disabled-by-default profile.

A session request no longer carries only `profileId`. `openSession` also accepts
`executable`, `args`, `cwd` and `environment`, which replace the profile's own
spawn parameters (`terminal-session-manager.ts`). The hub relay uses that to
start an instance's camera with its stored overrides; the Admin UI's interactive
open still sends `profileId` alone — but the **contract** accepts overrides from
any caller, so the profile allowlist no longer bounds what argv is executed.

Those settings are declared once, in the addon's `globalSettingsSchema()`, and
are rendered in two places from that one declaration: the generic
/system/settings form, and **inline on Administration → Terminal**, scoped to
the node that page's own NodePicker has selected. Nothing about a profile is
re-declared in the Admin UI — a second declaration would be a second authority
for what a profile is, and the two would drift.

The schema groups the built-ins one section per profile (`terminal-btm`,
`terminal-top`, `terminal-glances`, `terminal-shell`) so the enable switch sits
beside the binary and arguments it governs. That grouping is presentation only.
Every persisted key stays flat (`glancesArgs`, not `glances.args`) because the
per-node store keys physically on `<key>@<nodeId>`: renaming one discards every
node's stored value with no migration path.

Glances ships with **no default arguments**. Measured on the hub at the terminal
camera's own grid, it costs ~1% of one core in steady state and 0.19
core-seconds to start; the entire tuning range (`-t`, `--disable-plugin`,
`--disable-process`) spans 0.4%-0.9% of one core, so the best available saving
is ~0.4% of a single core out of twenty — while every option that saves anything
removes a panel the camera exists to display. `-t` is also counter-productive
here: the camera renders at 2 FPS and Glances already repaints every 2s, so a
slower refresh only shows staler numbers. The full table is in the comment above
`DEFAULT_GLANCES_ARGS`. The per-instance panel switches are the operator-facing
form of the same trade-off: all nine default on, and turning one off appends
`--disable-plugin <name>` for that one camera, never for the node.

Every `terminal-session` method is `auth: 'admin'` and is pinned at that tier in
the repo's method-tier baseline, so a relaxation is a diff a reviewer sees
rather than an omitted line. The tier is not the containment, though: an
admin-tier capability that spawns a process is still remote code execution as
the server user on that node. Since `openSession` takes executable and argv
overrides, the profile allowlist no longer bounds that — the admin tier is the
bound.

Glances uses the normal addon dependency system:

1. `packages/addon-terminal/package.json` declares its requirements file.
2. The kernel installs it idempotently into CamStack embedded Python.
3. The addon resolves that interpreter with `ctx.deps.ensurePython()`.
4. The profile runs `<embedded-python> -m glances`.

System Python is never modified.

## Camera declaration and streaming

The hub owns reconciliation through `DeclaredDevices` and the fixed
**Terminal** integration. Every **enabled instance** declares one
`TerminalCameraDevice` with one `stream-catalog` source; a node advertising a
profile declares nothing. Instance rows live in the Terminal addon's own global
settings on the hub, and an instance mutation that reaches a non-hub runner is
refused rather than writing a second authority.

The hub relay opens the profile through the node-pinned `terminal-session`
capability, pulls ordered terminal output, applies it to a headless xterm
screen, renders JPEG frames and serves loopback MJPEG. Stream Broker consumes
that source and publishes low-latency H.264.

Declarations come from persisted instances, so an unreachable node can never
withdraw a camera. A node whose `listProfiles` fails keeps its cached profile
list and its instances' cameras are marked offline via `setNodeOnline(false)`;
one unavailable node does not block reconciliation for healthy nodes. A camera
is offline in the same way when its node no longer offers its profile at all.

## Interactive transport

Session lifecycle, input, resize and ordered output are capability calls pinned
to the selected node. `pullOutput` uses a bounded cursor log and can return an
authoritative screen snapshot when a consumer falls behind. This is deliberate:
the event bus may drop telemetry, while one dropped terminal byte corrupts VT
state until a repaint.

The original investigation and trade-offs remain in
[`../design/2026-07-26-terminal-session-design.md`](../design/2026-07-26-terminal-session-design.md).
