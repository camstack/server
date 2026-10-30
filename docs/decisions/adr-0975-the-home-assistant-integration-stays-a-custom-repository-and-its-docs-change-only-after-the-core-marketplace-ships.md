---
id: D975
title: The Home Assistant integration stays a custom repository, and its docs change only after the core Marketplace has shipped and a migration was tested
status: accepted
date: 2026-10-30
supersedes:
covers:
  - packages/cli/src/mcp/configure-exports.ts
---

## Context

The CamStack Home Assistant integration (repository `camstack/homeassistant-component`) is installed today as a HACS custom repository. Operator docs and the `configure_ha_guide` MCP text describe that route.

Home Assistant is absorbing HACS. The HACS custom integration is superseded by a core "Marketplace" integration (home-assistant/core PR #183502, merged to `dev` 2026-10-01, announced on frenck.dev 2026-10-26). It ships in Home Assistant 2026.11, which was not released on 2026-10-30. HACS is not retired as a catalog: the catalog (`hacs/default`), `hacs.json` and the review are unchanged, and updates still come from GitHub releases. Existing HACS installs are migrated in place on first start and custom repositories carry over, after a one-time GitHub connection and a one-time community-content warning. Home Assistant older than 2026.11 keeps HACS.

Sources (all fetched 2026-10-30):

- https://frenck.dev/hacs-is-now-the-home-assistant-marketplace/ (2026-10-26)
- https://github.com/home-assistant/core/pull/183502
- https://contributors.home-assistant.io/marketplace/ and its `guides/` and `reference/` pages (undated)
- https://community.home-assistant.io/t/ha-is-bringing-hacs-into-core-as-marketplace/1027631 (2026-10-06, secondary)

No official release notes or developer blog post for 2026.11 were found, and nothing was found on whether custom repositories stay supported long term. The component repository already fits the layout (`hacs.json`, `custom_components/camstack`, local `brand/` folder, manifest `version` equal to the tag, `issue_tracker`, a release per push to main) and is not in `hacs/default`.

Alternatives considered: rewrite the docs now for the Marketplace (rejected, it is in no stable release and nobody has tested our migration); do nothing until a user complains (rejected, the two paths will coexist and the docs must say so); submit to `hacs/default` now (rejected as a default, see below).

## Decision

1. Distribution stays a custom repository. Both routes, HACS on Home Assistant older than 2026.11 and the Marketplace on 2026.11 and later, are documented while they coexist.
2. The public docs page, the `configure_ha_guide` text and the component README change only after 2026.11 is generally available and one real HACS-to-Marketplace migration of our custom repository has been tested. Proposed wording is kept in the research notes of the planning issue (camstack/planning#279).
3. The component repository changes land in ONE release at that time, because each main push is a user-visible release: drop `ignore: brands` from the hacs job only if the action passes without it; add manifest `categories` only if hassfest accepts it; consider batching releases.
4. Submitting to `hacs/default` (discoverability, install without a GitHub connection) is a separate operator decision, not part of this record. Review takes months and the pull request must come from a personal account.

## Consequences

- Until the migration is tested, the docs name HACS only and may be wrong for a user on 2026.11. That is accepted over documenting an untested flow.
- Users of a custom repository on 2026.11 need a one-time GitHub connection and must accept the community-content warning; catalog installs would avoid both.
- Every main push in the component repository stays a visible release to catalog users, so batching matters if the integration enters the default catalog.
- This record has to be revisited once 2026.11 ships: the docs change, the component release, and a decision on `hacs/default`.

## Enforcement

Nothing, review only. `configure-exports.ts` carries the HACS wording this record defers changing.
