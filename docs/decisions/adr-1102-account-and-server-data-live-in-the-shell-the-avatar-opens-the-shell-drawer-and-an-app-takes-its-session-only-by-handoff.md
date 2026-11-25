---
id: D1102
title: Account and server data live in the shell, the avatar opens its drawer, and an app takes its session only by handoff
status: accepted
date: 2026-11-25
supersedes:
applies-to:
  - packages/types/src/capabilities/app-source.cap.ts
  - packages/types/src/capabilities/apps.cap.ts
  - packages/types/src/app-bridge.ts
  - packages/system/src/builtins/apps-aggregator/**
---

## Context

Amends D1096 (the shell owns the only drawer; an embedded app is chromeless).
D1096 kept the avatar on the right of the viewer toolbar for "account, the server
list and open at launch", and the drawer on a hamburger on the left. That left
account and server data inside the viewer. The viewer carried the certificate,
tokens, sessions and passkeys, and its settings lived beside them. An app
embedded in the shell therefore had no account surface of its own, and the
credentials an app needs for a session were held by the viewer rather than by
the shell that owns the account. The operator decided on 2026-11-25 to move
account and server data into the shell. No concrete incident is recorded here;
the rationale is the ownership split.

## Decision

Account and server data live in the shell, never in an app. Viewer settings
are viewer-specific only where they are the "Viewing" settings.

- The avatar (the user's initial) replaces the hamburger menu. It sits on the
  LEFT of the toolbar, where the hamburger was. Tapping it opens the shell
  drawer, which opens from the left. The right-hand avatar of D1096 is removed.
- The drawer bottom holds the signed-in user, the current server and the server
  switch.
- Certificate, tokens, sessions and passkeys move to a shell Account section at
  `/account`. "This device" also lives in the shell Account. The viewer no longer
  carries any of them.
- Only the "Viewing" settings are viewer-specific. They become the fifth entry of
  the viewer bottom bar.
- An app gets a session only through the hub's one-time handoff (native) or the
  cookie (web). The bridge carries context, never secrets.
- Viewer behaviour must not change except for these moves.

Rejected alternatives:

- Viewer settings as a per-app row in the drawer.
- Viewer settings as a gear in the HomeBar.
- The avatar on the right, keeping the hamburger.

This amends D1096 only where it placed the avatar and account. D1096's other
rules stand: one drawer, capability entries for apps, and chromeless embedded
apps.

## Consequences

Delivered in six phases:

- P1: drawer bottom and the avatar.
- P2: the `/account` shell route. These are moves, not rewrites, and `/settings/*`
  gets redirects.
- P3: the viewer settings entry in the bottom bar.
- P4: bridge context (`hello.context`, locale, `session-ended`,
  `request-sign-out`).
- P5: per-server `lastApp` and launch, plus a guarded switch from an embedded app.
- P6: an import-boundary guard.

Until P2 lands, the viewer still holds the credentials and the `/settings/*`
paths. An embedded app must not receive a session value through the bridge at
any phase; context is the only thing the bridge carries. Any change to the
bridge envelope is a new decision, as D1096 already requires for its version.

## Enforcement

Review only until P6. P6 adds an import-boundary guard that is planned and not
yet written. Until then, a violation (a secret passed over the bridge, or the
viewer importing account code) is caught by review.
