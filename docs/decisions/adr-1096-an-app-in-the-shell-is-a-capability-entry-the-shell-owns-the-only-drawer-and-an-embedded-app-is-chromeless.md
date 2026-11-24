---
id: D1096
title: An app in the shell is a capability entry; the shell owns the only drawer, and an embedded app is chromeless and publishes its nav as data
status: accepted
date: 2026-11-24
supersedes:
applies-to:
  - packages/types/src/capabilities/app-source.cap.ts
  - packages/types/src/capabilities/apps.cap.ts
  - packages/types/src/app-bridge.ts
  - packages/system/src/builtins/apps-aggregator/**
---

## Context

Amends D1094 and cites D801 (browser handoff), D425 (`frame-ancestors 'self'`),
D373 (mount prefix), D315 (absent only from an answered query) and D393 (a
failed count is `null`, never `0`).

The viewer's app switcher spelled its apps in the shell: Admin, Nodes, the
viewer itself. An embedded app drew its own sidebar inside the shell's frame, so
a phone showed two navigations, and a new app meant editing the shell. D1094
accepted the Nodes app posting its unlock ticket to an agent UI in cleartext on
the LAN; that accepted-risk paragraph is dormant while Nodes is out of the
switcher.

## Decision

An app in the shell is a capability entry, never a name in the shell.

- An addon declares apps through `app-source` (collection); the hub singleton
  `apps` aggregates them. No app id is ever spelled in the shell.
- The viewer shell owns ONE drawer, opened by a hamburger on the LEFT of the
  viewer toolbar. The avatar on the right stays for account, the server list and
  "open at launch".
- The drawer is the same overlay on phone and desktop web: user and server, a
  shared search field, the full APPS list with the active one ticked, the NAV of
  the active app, Settings (only when the active app declares them), Sign out.
- The Viewer's own tabs (cameras, events, grids) stay in its bottom bar or rail.
  They are part of the native viewer app and are not published in the drawer: the
  Viewer's nav is empty.
- Search is shared. The field covers every offered app's nav (label and
  keywords) plus the device and integration domains; tapping a result of another
  app switches to it.
- Labels are i18n keys with an English fallback (`AppLabel`); the shell
  translates through per-app bundles.
- An embedded app goes chromeless only after the shell's `hello` bridge message,
  so an old viewer never shows an app without navigation. Admin's chromeless
  deploy is held until the viewer OTA that sends `hello` has shipped. The bridge
  is a versioned `postMessage` envelope (`app-bridge`, `v: 1`); an unknown or
  malformed message parses to `null` and is ignored.
- `apps.listApps` filters by the caller's role (`adminOnly`, `roles`, per-item
  `adminOnly`); a provider that fails is skipped and logged with its reason.
  `apps.getNavBadges` follows after the shell lands (not v1). A badge count that
  could not be measured is `null`, never `0` (D393). An app is reported absent
  only from a `listApps` that answered (D315).
- The aggregator passes `reach` (`lan-only`, `node`) and a nav item's
  `requiresCapability` through untouched: the shell interprets them (phase 4).
  A provider that fails is served from its last good snapshot; the boot-race
  retry with a re-emitted ready event that `addon-pages` has is not built here
  (the shell refetches on open), and is added when the shell shows a gap.
  The same app reported by several nodes is listed once, keyed on addon id and
  app id, the hub-local provider first.
- Node UIs stay out of the switcher (#678) until agent-ui provides per-node
  entries through the cap. The admin handoff destination of D1094 stays; a
  non-admin embedded destination needs its own decision.
- Standalone Admin keeps its sidebar, built from the same data as its manifest.

## Consequences

A new app is a provider, with no shell release. Admin's sidebar and the drawer
must not drift: a parity spec ties the Admin manifest to `buildNavSections`.
The shell depends on the bridge version; a bump of `v` is a new decision.

## Enforcement

Planned: guard `scripts/check-no-hardcoded-app-ids.ts` <!-- drift-ok: planned, phase 4 --> (phase 4) and the parity
spec admin manifest to `buildNavSections` (phase 3). Phase 1 ships schema specs
(`app-shell.spec.ts`: entries, declarations, bridge parse) and the aggregator spec
(`aggregate-apps.spec.ts`: role filter, failing provider skipped and logged,
providers merged and stamped).
