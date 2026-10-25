---
id: D853
title: A storage-layout change ships without migration code — the product targets the new layout, the operator's hub is converted once offline while stopped, and the release train holds that hub until then
status: proposed
date: 2026-10-14
supersedes:
applies-to:
  - scripts/ops/**
---

## Context

Splitting `camstack.db` into settings, events and history (D851, D852) and
replacing the statistics tables (D850) moves gigabytes of rows that exist on
exactly one installation with history: the operator's hub. Agents hold no store
(D332), the dev hub can be wiped, and a fresh install starts in the new layout.

The first proposal moved collections at runtime: a per-collection paged copy
through the data door, a flip of the engine hint, rollback by flipping back. That
is migration code in the product — a boot path, a dual-write window and a
rollback flag that every future reader must understand and that only one machine
will ever execute. The keychain move (D787) already showed the alternative
works: an operator-run one-off script, not shipped in any package.

## Decision

**The product contains no code that converts an old storage layout — no boot
migration, no paged runtime copy, no dual-write, no rollback flag. The code
targets the new layout only. The one installation with old data is converted
ONCE by an ops script under `scripts/ops/`, run against the live directory named
by `docker inspect` (D328) while the container is STOPPED, after a full copy of
that directory. From the first commit that depends on the new layout until that
conversion, the operator's hub and its agents receive no update from this
repository.** Rollback is restoring the copied directory and the previous
image.

## Consequences

- The release that needs the new layout and the conversion are one operator
  window; a maintenance stop of the hub is part of the plan, sized by a
  rehearsal on a copy of a verified snapshot.
- During the hold, no unrelated fix reaches production from main.
- The engine refuses a declaration whose table sits in another file (D851), so a
  build that reaches an unconverted hub by mistake fails loudly instead of
  serving empty tables beside the real ones.
- The script is bundled at the release's commit and reuses the engine's own DDL
  builder and declarations; it is never hand-maintained against a moving schema.

## Enforcement

Review only for "no migration code". The hold is a procedure: the operator turns
the hub's addon auto-install channel off and no deploy targets that hub. The
engine's misplaced-table refusal is the mechanical backstop. The script's spec
builds its fixture with the real engine and asserts a marker row in every moved
table. Not yet built.
