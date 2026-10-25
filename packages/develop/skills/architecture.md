---
name: architecture
description: Architecture pointers for CamStack plugin authors — process model, capabilities, media, deploy.
---

# Architecture for plugin authors

Deep dives live in the **camstack-server** repository under `docs/architecture/`.
Start with `docs/architecture/overview.md`. Facts that change often are in
generated `docs/reference/*` — do not copy them into skills.

## Kernel and addons

- Kernel owns processes, transport, registries.
- Features are addons. Cross-addon calls only via typed capabilities (`ctx.api`).
- Addons never import each other.

## Process model

- Default: **one addon = one process**.
- Co-locate only via `execution.group`, and only for allowed non-live cases —
  never device providers or frame-rate data planes just to save RAM.
- Lifecycle = respawn a runner. No in-process hot-reload of business logic.

## Capabilities

- Declared by **name** in the addon manifest.
- Behavioural metadata only in `*.cap.ts`.
- After any cap change: `npm run codegen`.
- Registration is one atomic `registerNode` RPC — no shadow registries / wait
  loops.

## Bytes and frames

- Cross-addon bytes: `ctx.peerBytes` (tickets), not base64 cap fields, not
  private HTTP servers.
- Frames do not cross process boundaries at frame-rate; fetch compressed /
  by-handle when needed.

## Logging and events

- Device-related lines carry `tags: { deviceId }` (numeric id).
- Events via `ctx.eventBus` + `EventCategory` are telemetry and may be dropped;
  durable work needs RPC (or event + reconcile).
- Branches that drop work silently must log.

## Deploy reality

Editing source and rebuilding `dist/` does **nothing** on a live node until:

```bash
camstack deploy packages/addon-<name>
```

Framework packages (`types`, `system`, `sdk`, `ui-library`) travel inside
`@camstack/server` — need a server update, not an addon deploy.

## Suggested reading (server repo)

| Topic | Page |
| --- | --- |
| Orientation | `docs/architecture/overview.md` |
| Transport / cross-node | `docs/architecture/transport.md` |
| Capabilities | `docs/architecture/capabilities.md` |
| Addon boot / crashes | `docs/architecture/addon-lifecycle.md` |
| Device model | `docs/architecture/device-model.md` |
| Data planes / decode | `docs/architecture/data-planes.md` |
| Update / release | `docs/architecture/update-and-release.md` |
| Decisions | `docs/decisions/` |

## Examples

```bash
camstack develop find-example provider
camstack develop find-example notifier
camstack develop find-example osd
```

See also public docs: Develop → Examples from core addons.
