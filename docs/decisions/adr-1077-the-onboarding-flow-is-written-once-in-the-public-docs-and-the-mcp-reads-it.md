---
id: D1077
title: The onboarding flow is written once, in the public docs, and the MCP reads it
status: proposed
date: 2026-11-21
supersedes:
applies-to:
  - packages/cli/src/onboarding/**
  - packages/cli/src/mcp/setup-wizard.ts
  - packages/cli/src/mcp/setup-core-addons.ts
  - packages/cli/src/mcp/setup-feasibility.ts
  - packages/cli/src/mcp/setup-location-create.ts
  - packages/cli/src/host-check/sizing.ts
  - scripts/check-onboarding-manifest.ts
  - scripts/onboarding-manifest-check.ts
---

## Context

Setting up Dominevo was described three times: the public docs, the tool
texts of `dominevo mcp`, and the wizard's own step list. They disagreed. The
docs had three orderings of the first steps; the wizard began after install and
skipped storage, core addons, streams, recording and the benchmark; tool text
said NVIDIA was unsupported months after the `nvidia` images shipped; the docs
named sidebar entries the UI does not have. `setup-install-rules.ts` said why in
a comment: the docs repository is private, so its rules were copied into the
CLI by hand, "re-read the page when it changes". Nobody re-read it.

Generating the docs from the CLI (as the MCP tool reference already is) was
considered and rejected: the flow is prose, written by whoever edits the page,
and a wording fix would then need a CLI release.

## Decision

The ordered steps, the actions of each step in both renderings (the MCP call
and the manual instruction), the core-addon list and the sizing constants are
frontmatter of three public docs pages. The docs build turns them into
`/onboarding/v1/manifest.json`. The CLI answers `setup_wizard`,
`setup_core_addons` and `setup_feasibility` from that manifest: fetched live
from the docs site, with a copy bundled in the package for offline use, the
higher `revision` winning. The CLI owns only what must be code: how a step is
judged against a host or a hub.

`setup_wizard` stays the one entrypoint, and answers before a hub exists: with
no session the next step is the feasibility check of the machine, then the
install. A step whose read failed, or that needs a hub that is not there, is
`unknown` with the reason — never `missing`.

How many cameras a machine carries is answered twice, and the two are never
mixed. Before the install the answer is PROVISIONAL: it comes from the sizing
constants of the docs and the hardware class, it invents no figure for a class
nobody measured (the answer there is a hub plus agents, with the limit
stated), and it is labelled an estimate. Once the node benchmark (D791) ran,
the wizard shows the MEASURED capacity instead — the smaller of what the node
decodes and what it detects, naming which one is the limit — and re-judges
whether agents are needed from it.

A machine outside the measured tables gets a prefilled link to a
`hardware-report` issue (`.github/ISSUE_TEMPLATE/hardware_report.yml`): the
host-check facts and, once it ran, the benchmark figures. The person submits
it themselves. It carries no hostname, address, node id or secret.

## Consequences

- A step exists only if the docs have it AND the CLI can judge it. A live step
  the CLI does not know is reported `unknown`, never guessed.
- The manifest can only select tools the running process registered, and
  argument keys those tools declare. It carries no secret.
- A breaking change of the manifest shape is a new URL; old CLIs keep reading
  the old one.
- `packages/cli/src/onboarding/manifest.snapshot.json` is generated. It is
  refreshed with `npm run onboarding:sync`, never edited.
- The docs are published BEFORE the CLI that bundles a newer revision; the
  guard's `--live` mode refuses the opposite order.
- A storage location is created by `configure_setup_location_create` through
  the same door as the admin UI (`integrationInstances.testInstance`, then
  `createInstance`), after refusing a second root of one type on one node
  (D388, D389).
- The MCP makes one more outbound read, to the docs site. `--no-docs-fetch`
  turns it off.

## Enforcement

- `packages/cli/src/__tests__/onboarding-manifest.spec.ts`: the bundled steps
  are exactly the evaluator registry; every tool and argument the manifest
  names is served; every action an evaluator points at exists.
- `scripts/check-onboarding-manifest.ts`: every admin-UI route and sidebar
  label the manifest names exists; every core addon id ships in the package the
  manifest says; the snapshot equals the docs checkout's manifest when one is
  present (CI has none, so that half runs where both repositories are checked
  out). `--live` compares against the docs site and is run by hand after a
  docs publish.
- In the docs repository, its `check-onboarding` script (`npm run check:onboarding`) runs in the build:
  every action has both renderings, every tool it names is in the generated
  tool list, the committed manifest is current.
