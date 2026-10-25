---
id: D919
title: An accelerator is what the bus shows, re-probed every minute, and a device that left is absent
status: accepted
date: 2026-10-23
applies-to:
  - packages/system/src/builtins/platform-probe/coral-accelerators.ts
  - packages/system/src/builtins/platform-probe/accelerator-reprobe.ts
  - packages/addon-pipeline-orchestrator/src/inference-device-model.ts
---

## Context

On 2026-10-22 the Coral USB moved from the hub to agent-b. The hub kept
reporting `edgetpu:usb` `available:true`: `classifyCoralAccelerator` assumed one
USB Coral whenever the libedgetpu delegate was installed, and the delegate stays
installed after a stick leaves. The container's `/sys/bus/usb/devices` was
readable and listed no `1a6e:*` / `18d1:*` id — the bus had already answered.
It was harmless only because the stored setting was `enabled:false`; with D912
(a Coral is on by default) a reset would have placed sessions on a ghost device.

Three more gaps made it worse: the platform probe ran once per process, so a
stick plugged in or pulled out was seen only after a restart; a stored device
the probe no longer returned was shown as a bare `available:false`, exactly like
a device that is present but unusable; and the node topology's `engines`
(installed runtimes) read like a device list.

## Decision

The USB bus decides when it can be read. The "delegate installed ⇒ one USB
Coral" fallback applies only when `/sys/bus/usb/devices` is missing, unreadable
or empty (a macOS desktop, a restricted container); a readable bus with no Coral
id means no USB Coral. The probe logs which evidence decided (`usb-ids`, `pci`,
`delegate-fallback`, `none`).

**Amendment (2026-10-23): a listed USB Coral counts only when its device node
opens.** `/sys` is the HOST's view: after agent-b's LXC and Docker lost
their `/dev/bus/usb` mapping, the container's `/sys/bus/usb/devices` still
listed the stick (`8-1`, `18d1:9302`) and the node kept reporting
`edgetpu:usb`. A Coral id on the bus is now usable only when its usbfs node
`/dev/bus/usb/<busnum>/<devnum>` (from the sysfs entry, three-digit padded) is
in this process's view and passes an `R_OK|W_OK` access check (no open, no
ioctl). A listed stick whose node is missing or refused is reported as USB
`unavailable` with reason `device-not-accessible` (never a usable unit, and
never `edgetpu:usb`), `decidedBy: 'usb-ids'`. The probe gives the node paths
(`inaccessibleUsbNodes`), and every probe line carries `tags: { nodeId }`. The
answer changing is logged once (`Coral Edge TPU probe changed`), with the
paths. The delegate fallback is unchanged: it applies only when the bus is
unobservable.

The accelerator part of the probe (USB ids and PCIe apex units — `/sys` and
`/dev` reads, no model load) is re-run every 60 s and on demand
(`platformProbe.rescanAccelerators`, admin, routed by `nodeId`). A changed set
rebuilds the device list `getCapabilities` serves, every appeared or
disappeared device is logged with its node, and the orchestrator re-elects on
its next device read through the existing set-change path.

A stored device the probe ANSWERED without is `presence: 'absent'` — its
settings kept, never eligible whatever its stored `enabled`, and forgettable
(`pipelineOrchestrator.forgetInferenceDevice`, refused for a present device or
an unanswered probe). An unanswered probe is `unknown`, never absent (D315).

## Consequences

- A Mac desktop still reads its staged dylib as one USB unit: its bus is not
  observable, so the fallback is the only evidence there is.
- A Coral that is present but unusable stays `unavailable` (D393), distinct from
  `absent`.
- Topology `engines` keeps meaning installed runtimes; the admin UI labels it so
  and points at the live device list.
- The Load balancing page shows each node's devices in one `DataTable` with
  their state, share, sessions and cap; the read-only accelerator share slider
  and the Node load card's accelerator list are gone from that page.

## Enforcement

`coral-accelerators.spec.ts` (a readable bus with no Coral id and the delegate
installed is no Coral; an unreadable or empty bus falls back; a re-enumerated
`18d1:9302` stick is found by its id), `accelerator-reprobe.spec.ts` (a stick
pulled out disappears from the served device list and comes back),
`absent-inference-device.spec.ts` (the election follows the probe; absent is
shown, forgettable, and refused when present or unanswered),
`node-device-table-model.spec.ts` (the UI state vocabulary).
