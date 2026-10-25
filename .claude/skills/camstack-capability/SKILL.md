---
name: camstack-capability
description: Add or change a CamStack capability (`*.cap.ts`) end to end — decide whether one is needed at all, pick its cardinality (singleton, collection, device-native, wrapper, internal, node-hosted), codegen and the two hand-edits it cannot do, registerProvider and the manifest, provider selection through bindings, CAP_INPUT_DEFAULTS, a capability-driven UI, typed routing errors, and what must be published for it to reach a running hub. Use for "new cap", "add a method", "add a field to a cap", "two addons implement the same cap", "No procedure found on path", "provider not available".
---

# Capability (repository overlay)

The canonical PUBLIC text of this skill is `packages/develop/skills/camstack-capability.md` (shipped with `@camstack/develop`; `camstack develop skill camstack-capability`). **Read it first** — it holds the procedure, the traps and the done-gate, and this file does not repeat it. Below is only what is true of THIS repository. `scripts/check-skill-pack-sync.ts` keeps the two from drifting.

## Repo notes

- The shipping chain after a cap change (publish `@camstack/system` + `@camstack/server`, `applyServerUpdate`, restarts) is `camstack-server-change`; CI mechanics are `camstack-publish-ci`.
- The pre-commit hook runs `check-method-tiers` and `check-export-coverage` when a `*.cap.ts` is staged.
- Router specs live in `server/backend/src/__tests__/cap-routers/`; the inventory regenerates into `docs/reference/capabilities.md` and `docs/reference/api.md`.
