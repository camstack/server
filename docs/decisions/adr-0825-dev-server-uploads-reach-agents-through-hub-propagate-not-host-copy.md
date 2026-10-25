---
id: D825
title: Dev-channel server uploads reach agents through hub propagate, not host copy
status: accepted
date: 2026-10-10
supersedes:
applies-to:
  - server/backend/src/api/server-upload.ts
  - server/backend/src/api/server-upload-propagate.ts
  - server/backend/src/agent/apply-stage-dev-uploads.ts
  - packages/cli/src/commands/deploy-server.ts
  - packages/node-root/src/root-update-service.ts
---

## Context

`camstack deploy-server` packs a `<base>-dev.<epoch>` closure and uploads it to
`POST /api/server-upload`, which writes only the hub's
`server-root/dev-uploads/<version>/`. Agents stage that version exclusively from
local uploads (`dev-uploads-missing` otherwise). Phase 1 left agents without an
API path, so operators copied tarballs via `docker exec` / SSH — unclean, host-
specific, and easy to land beside the process's real `server-root`.

Addon deploy already solved the same shape: hub stages bytes, agent pulls a
one-shot hub-http ticket (`$agent.deploy`).

## Decision

Dev-channel fan-out uses the same pattern as addon deploy:

1. Hub keeps `POST /api/server-upload` (store local uploads).
2. `POST /api/server-upload/propagate` packs an already-stored version dir,
   stages a hub-http ticket, and calls `$agent.stageDevUploads` on one agent.
3. The agent writes `server-root/dev-uploads/<version>/` atomically; it does
   not promote. Promotion remains `serverManagement.applyServerUpdate` with
   `nodeId`.
4. `camstack deploy-server --all` / `-n <nodeId>` drives propagate then apply.
   Default without flags stays hub-only.

Host/volume copy of `dev-uploads` is emergency-only, not the procedure.

## Consequences

- A running hub and agent that predate this change cannot serve propagate until
  they run a closure that includes the route and `$agent.stageDevUploads`.
  The first land of that build on agents may still need a one-shot host copy
  of `dev-uploads`; afterwards `--all` / `-n` is enough.
- Closure packs are larger than addon tarballs; timeouts match
  `AGENT_DEPLOY_CONTROL_TIMEOUT_MS`.
- Skills and refuse messages point at `--all` / `-n`, not SSH.

## Enforcement

- Specs on pack/unpack, propagate route, and `applyStageDevUploads`.
- Review / skill text in `camstack-hub-image-deploy` §0b.
