---
id: D841
title: The agent UI lists addons and their runners as one joined list
status: accepted
date: 2026-10-13
supersedes:
applies-to:
  - server/backend/src/agent/agent-addon-runtime.ts
  - packages/addon-agent-ui/src/addons-panel.tsx
---

## Context

The agent page showed an "Addons" list and a "Processes" list; the operator
joined them by eye to learn which runner hosts an addon, and a shared runner
(the `ml` group) looked like unrelated rows.

## Decision

`GET /api/agent/addon-runtime` returns one row per addon with its runner,
joined on the process service's own `addonIds` (filled from the runner that was
actually spawned, i.e. `resolveRunnerId`). Neither the backend join nor the UI
derives a grouping. A runner that hosts no known addon is still a row. The page
draws one `DataTable`; versions and Update (D840) come from
`/api/agent/addon-updates`, keyed by package name.

## Consequences

- The separate Processes list is gone; a stray runner's restart lives on its row.
- An addon the process list does not name has no runner (shown as "in the
  agent process"), never a guessed one.
