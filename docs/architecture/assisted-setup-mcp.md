---
title: Assisted setup and troubleshooting with the public MCP (user guide)
last-verified: 2026-11-04
applies-to:
  - packages/cli/src/mcp/setup-register.ts
  - packages/cli/src/mcp/debug-report.ts
  - packages/cli/src/mcp/report-issue.ts
  - packages/cli/src/mcp/report-scrub.ts
  - packages/cli/src/mcp/report-environment.ts
  - packages/cli/src/mcp/report-recipes.ts
covers:
  - packages/cli/src/mcp/setup-*.ts
  - packages/cli/src/mcp/debug-*.ts
  - packages/cli/src/mcp/client-logs.ts
  - packages/cli/src/mcp/report-*.ts
---

# Assisted setup and troubleshooting with the public MCP

A user guide for the tools of `camstack mcp` (D974) that help an assistant set a
hub up, find out why something misbehaves, and report it. The operator-language
version is on the public docs site ("Assisted setup and troubleshooting with the
MCP"). Toolsets: `setup` needs no login, `ops` reads a hub, `configure` and
`support` write or draft, and every write is two steps (D836).

## How a write works

Every tool that changes something, or files something, is called twice. The first
call carries no `confirm_token` and changes nothing: it returns the diff (or the
whole draft) and a one-shot token bound to the exact arguments. The second call,
with the SAME arguments and the token, acts. A different argument, an expired
token (5 minutes) or a reused token is refused and a fresh first call is needed.
The server must run with `--allow-mutations`. A credential that is not admin-scoped
is refused before any read or write.

A read that failed is `null` (or `lines: null`) with its reason in `unavailable`,
never `0` or an empty list (D393).

## The tools

### Getting started (`setup`, no login)

| Tool | What it does | Ask the assistant |
| --- | --- | --- |
| `setup_about` | CLI and server versions, supported hosts | "Which CamStack version is current?" |
| `setup_install_guide` | Interview, then the official template for docker-compose / docker / unraid / proxmox-lxc / macos-desktop | "Help me install CamStack on Unraid." |
| `setup_discover_hubs` | Hubs on the local network | "Is there a CamStack hub here?" |
| `setup_connect` | Does the hub answer, is its CA pinned, is there a session | "Connect to my hub." |
| `setup_add_node` | Guide to add an agent; the operator types the six pairing digits on both screens, the tool never confirms one | "Add my Mac mini as a node." |
| `setup_login`, `setup_login_wait` | Sign in by browser approval, no password | "Log me in." |
| `setup_wizard` | First-run checklist, eight steps, each done / missing / unknown / suggested | "What is left to set up?" |

### Reading and applying a setup area (`ops` reads, `configure` applies)

| Read | Apply | What it covers |
| --- | --- | --- |
| `setup_locations` | `configure_setup_locations` | Storage locations by class, mode, occupancy, drain. Refuses a change that leaves a class with no writer. |
| `setup_recording` | `configure_setup_recording` | Per-camera recording config, derived mode and retention, a proposal for cameras that record nothing. |
| `setup_streams` | `configure_setup_streams` | Native and derived streams, high/low slots, live fps / bitrate / IDR. A slot change restarts that camera's detection. |
| `setup_benchmark` | `support_benchmark_run` | Benchmark status, accelerators, devices without a measured latency. The run loads the node. |
| `setup_pipeline` | `configure_setup_pipeline` | Detection placements and the auto-tune plan; the apply is refused when the plan changed (`planHash`). |

Examples: "Check where my recordings go and propose a layout", "Why does camera 12
record nothing?", "Put the main stream on the high slot of camera 12". The
assistant reads first, shows the proposal, and only applies after you said yes.

Capabilities used: `storage.listLocations`, `listLocationDeclarations`,
`listDrainProgress`, `upsertLocation`; `recordingArchive.getDeviceConfig` /
`setDeviceConfig`; `pipelineOrchestrator.getCameraStatuses`;
`streamBroker.listAllCameraStreams`, `listAllProfileSlots`, `getBrokerStats`,
`assignProfile`, `unassignProfile`; `pipelineOrchestrator.getNodeBenchmarkStatus`,
`listNodeBenchmarkResults`, `getNodeInferenceDevices`, `getPipelineAssignments`,
`planAutoTune`, `applyAutoTune`; `platformProbe.getHardware`; `deviceManager.listAll`.
No capability lists the disks of a node that no location points at, so a location
proposal only works from volumes locations already sit on, and says so.

### Finding out what is wrong

`debug_report({ deviceId?, issue?: 'stream'|'detections'|'ui', since? })` is one
read-only bundle: server and addon versions on every node; for a camera its streams
(slots and derived streams with fps / bitrate / IDR / subscribers), the churn in the
window found in logs tagged with the `deviceId` (profile-slot changes, detection
restarts, derived-feeder respawns, per derived stream), recent tracks with media
presence per kind and the thumbnail URL the viewer requests, and the viewer's own
lines. A missing thumbnail or keyFrame is flagged only for a closed track. Ask:
"Camera 12 stutters in the live view, what do you see?"

`client_logs({ since?, deviceId?, scope?, level?, user?, platform?, appVersion?, sessionId?, limit? })`
reads the viewer app's own log by tag; see "The viewer app's own log" in
[logging.md](logging.md). Ask: "What did the phone app log when I opened the
playback of camera 12?"

### Reporting it: `report_issue`

`report_issue({ kind, title, description, deviceId?, since? })` drafts a GitHub
issue for `camstack/server` and files it only after you read the whole text.

`kind` is one of `streams`, `media-thumbnails`, `ui`, `notifications`,
`remote-access`, `pipeline-detection`, `recording-storage`, `integration`, `other`.
It picks the logs (`report-recipes.ts`, data a spec asserts):

| kind | Logs read |
| --- | --- |
| `streams` | `debug_report` stream state, stream-broker warnings (this device), viewer `live` scope |
| `media-thumbnails` | viewer `events:media` scope, pipeline-analytics warnings (this device), track media summary |
| `ui` | viewer warnings, admin-ui and local-auth warnings, device view |
| `notifications` | notifiers and smtp warnings, the `matched NO rule` lines |
| `remote-access` | tunnel, cloudflare/static TURN, tailscale, remote-access orchestrator, webrtc warnings; viewer `live` |
| `pipeline-detection` | `debug_report` detections, orchestrator / detection-pipeline / runner warnings |
| `recording-storage` | recorder, storage orchestrator, filesystem and remote-storage warnings |
| `integration` | HomeKit, Alexa, Google, Matter, Home Assistant warnings |
| `other` | hub errors, viewer errors |

Each section holds at most 20 lines of 240 characters, repeats folded with a count.

**The review flow.**

1. First call: nothing is filed. The answer is the FULL markdown (title, what
   happens, environment, logs), the redaction counts ("redacted: 12 IPs, 3 tokens
   …") and a `confirm_token` bound to the arguments AND to the sha256 of that exact
   text. The tool description tells the assistant to show the markdown to you in
   full and wait for an explicit yes.
2. You edit: the assistant calls again with the new title or description. That is a
   new draft and a new token; a token never files text it was not issued for, and
   the execute step files the text the dry run showed, not a rebuild.
3. Second call with the token: runs YOUR `gh issue create -R camstack/server
   --title … --body-file <0600 temp file>` (the file is removed afterwards). It
   never uses a token of ours. Without `gh` or a sign-in, or when `gh` fails, the
   answer is a prefilled `https://github.com/camstack/server/issues/new?title=…&body=…`
   link, cut at a line boundary to 6,500 characters with a note; nothing is filed.

**What is sent.** The Environment is built only from an allow list
(`report-environment.ts`), never by dumping configuration: a position label per
node (`node#1`, never its id or name), whether it is the hub, platform and arch, the
server version, the node count; for a fixed list of critical addons (Cloudflare
tunnel, TURN, Tailscale, remote-access orchestrator, notifiers, HomeKit / Alexa /
Google / Matter / Home Assistant, recorder and storage, pipeline and orchestrator,
stream broker, webrtc) the installed version and a state (`installed` <
`configured` < `enabled` < `running`, plus the runner's own word); the viewer app
version when a viewer line carried it; a device as `device#<id>` and its type word.
`configured` is only "this addon holds a saved value": the values are dropped in
the read. A version or word that does not match a strict shape is shown as `unknown`.

**What is not sent.** Every string, including the logs, passes the scrubber
(`report-scrub.ts`), which counts what it removes: bearer / JWT / `csa_` / API-key
shapes, `secret://` markers, `password` / `token` / `key` / `user` values (query
and JSON), URLs (only the path shape stays, ids become `:id`), RTSP credentials,
emails, MACs, every IPv4 and IPv6, hostnames, `/Users/<x>` and `/home/<x>`, and
every device, camera and node name known to the hub (replaced with `device#<id>`
or `node#<n>`). The counts are part of the draft. Nothing is posted anywhere else:
no comment, no second issue.

Specs: `report-scrub.spec.ts` (every shape, counts), `report-issue.spec.ts`
(allow-listed environment, per-kind recipe, gate, `gh` fake, link fallback).
