---
id: D827
title: Waste schedules use the vendored HACS Python core (full catalog), not a TypeScript port
status: accepted
date: 2026-10-12
supersedes:
applies-to:
  - packages/addon-waste-collections/**
---

## Context

Municipal waste calendars are already solved in the HACS integration
`hacs_waste_collection_schedule`: hundreds of provider modules (API, ICS,
HTML scrape) behind one `Source.fetch() → Collection` contract. CamStack
already aggregates calendars through `calendar-source` → builtin `calendars`.

Two alternatives were rejected for v1:

1. **Port providers to TypeScript** — ~978 source modules; scrape/API drift
   would fork forever from upstream.
2. **Ship only a Germany/Italy allowlist on top of Python** — once the
   embedded Python + vendored core is paid for, filtering the catalog by
   country adds maintenance without shrinking the runtime surface.

## Decision

`addon-waste-collections` vendors the HACS **core** library
(`waste_collection_schedule`, MIT — no Home Assistant layer), installs its
pip requirements via `camstack.addons[].python.requirements`, and exposes
every `source/*.py` module through a JSON stdin/stdout bridge. The operator
configures rows that become `calendar-source` calendars. The catalog is the
set of vendored modules; updating the vendor updates the catalog.

## Consequences

- The addon depends on the hub's embedded Python; without it it registers an
  empty calendar-source and logs a warning (no crash loop).
- Upstream fixes arrive by re-vendoring, not by rewriting CamStack.
- Provider kwargs stay opaque JSON (`argsJson`) until a richer settings UI
  is designed against `PARAM_TRANSLATIONS`.

## Enforcement

- `src/__tests__/catalog.spec.ts` — every vendored `source/*.py` appears in
  `catalog.json` (no geographic allowlist).
- Nothing else; review only for vendor refresh procedure.
