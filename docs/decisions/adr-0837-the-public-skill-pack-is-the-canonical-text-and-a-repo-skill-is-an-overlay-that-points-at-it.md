---
id: D837
title: The public skill pack is the canonical text of a skill and a repo skill is an overlay that points at it
status: accepted
date: 2026-10-13
supersedes:
applies-to:
  - packages/develop/skills/**
  - .claude/skills/camstack-addon/SKILL.md
  - .claude/skills/camstack-capability/SKILL.md
  - .claude/skills/camstack-secrets/SKILL.md
  - .claude/skills/camstack-docs/SKILL.md
  - scripts/check-skill-pack-sync.ts
---

## Context

The pack (`packages/develop/skills/`, shipped with `@camstack/develop` and served
by `@camstack/mcp-develop`) began as a sanitized copy of the repo skills. Two
copies of one procedure drift, and they did: on 2026-10-09 the repo
`camstack-addon` was 358 lines against the pack's 126, and the repo
`add-capability` told authors to deploy `packages/types` after a capability
change when the hub reads the definitions from `@camstack/system`. Whichever copy
an agent loaded was partly wrong.

The 2026-10-09 skills plan chose the opposite direction: the repo is canonical
and the pack is GENERATED from `<!-- public -->` markers. That was not built,
and the markers would have fenced a small slice of text that is, in fact,
almost all public: the procedures describe a repository that is becoming
public, and nothing in them needs a private host.

## Decision

For `camstack-addon`, `camstack-capability` and `camstack-secrets` the pack
file is the canonical text. The repo skill under `.claude/skills/<id>/` keeps
its frontmatter (the trigger description the harnesses match on), a pointer to
the pack file, and only what is true of this repository (its workflow and
done-gate, the shipping chain skills it links). It does not repeat a pack
section. `camstack-docs` is the one exception in content: the repo procedure
(ADR ladder, `docs:check`, skill pointers) is repo-specific, so it stays whole
beside the pack's generic text, under headings that do not repeat the pack's.

A fact true for every author goes in the pack; a fact true only here goes in the
overlay. The pack never links outside itself.

## Consequences

- An edit to a public procedure is made once, in `packages/develop/skills/`,
  and ships with the next `@camstack/develop` publish.
- Skills that are inherently repo-internal (`camstack-workflow`,
  `camstack-server-change`, `camstack-diagnose`, `camstack-publish-ci`,
  `camstack-hub-image-deploy`, the UI skills) stay in `.claude/skills/` and are
  not in the pack.
- An agent reading only the overlay is told to read the pack file first; the
  overlay is deliberately not self-sufficient.

## Enforcement

`scripts/check-skill-pack-sync.ts` (Checks workflow): every pack skill with a
repo skill must be pointed at by it, share no section heading with it, carry the
skill id as its frontmatter name, link nowhere outside the pack, and be listed
in the pack README. Spec: `scripts/__tests__/check-skill-pack-sync.spec.ts`.
