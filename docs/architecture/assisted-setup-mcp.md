---
title: Assisted setup and debug tools of the public MCP
last-verified: 2026-11-03
applies-to:
  - packages/cli/src/mcp/setup-register.ts
  - packages/cli/src/mcp/debug-report.ts
covers:
  - packages/cli/src/mcp/setup-*.ts
  - packages/cli/src/mcp/debug-*.ts
  - packages/cli/src/mcp/client-logs.ts
---

# Assisted setup and debug tools of the public MCP

`camstack mcp` (D974) carries a read tool and, where the area is writable, a gated
apply tool per setup area. Reads sit on the `ops` toolset, applies on `configure`.
Every apply is two steps (D836): call without `confirm_token` for the diff and a
one-shot token bound to the exact arguments, call again with both to write. A
credential that is not admin-scoped is refused before any read or write.

A read that failed is `null` (or `lines: null`) with its reason in `unavailable`,
never `0` or an empty list (D393): an occupancy nobody reported, a recording config
the recorder did not answer, broker stats of a stream that is gone.

| Read (ops) | Apply (configure) | Capabilities used |
| --- | --- | --- |
| `setup_locations` | `configure_setup_locations` (mode of existing locations; refuses a class left with no writer) | `storage.listLocations`, `listLocationDeclarations`, `listDrainProgress`, `upsertLocation` |
| `setup_recording` | `configure_setup_recording` (strict `RecordingConfigSchema`) | `recordingArchive.getDeviceConfig` / `setDeviceConfig`, `pipelineOrchestrator.getCameraStatuses`, `deviceManager.listAll` |
| `setup_streams` | `configure_setup_streams` (slot assign / clear; each change restarts that camera's detection) | `streamBroker.listAllCameraStreams`, `listAllProfileSlots`, `getBrokerStats`, `assignProfile`, `unassignProfile` |
| `setup_benchmark` | `support_benchmark_run` (existing) | `pipelineOrchestrator.getNodeBenchmarkStatus`, `listNodeBenchmarkResults`, `getNodeInferenceDevices`, `platformProbe.getHardware` |
| `setup_pipeline` | `configure_setup_pipeline` (refused when the plan changed: `planHash`) | `pipelineOrchestrator.getPipelineAssignments`, `planAutoTune`, `applyAutoTune` |

No capability lists the disks of a node that no location points at, so a location
proposal only works from volumes locations already sit on, and says so.

## `debug_report` and `client_logs`

`debug_report({ deviceId?, issue?: 'stream'|'detections'|'ui', since? })` is one
read-only bundle: server and addon versions on every node; for a camera its streams
(slots and derived streams with fps / bitrate / IDR / subscribers), the churn in the
window found in logs tagged with the `deviceId` (profile-slot changes, detection
restarts, derived-feeder respawns, per derived stream), recent tracks with media
presence per kind and the thumbnail URL the viewer requests, and the viewer's own
lines. A missing thumbnail or keyFrame is flagged only for a closed track.
Secrets are scrubbed by the shared output scrub.

`client_logs` reads the viewer's shipped log by tag — see "The viewer app's own
log" in [logging.md](logging.md).
