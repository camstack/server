---
id: D1046
title: An addon route is addressed per instance, and the path without an instance is the default one
status: accepted
date: 2026-11-11
supersedes:
applies-to:
  - packages/system/src/addon-routes/addon-route-registry.ts
  - packages/types/src/interfaces/addon-routes.ts
  - packages/types/src/addon/build-addon-route-provider.ts
  - server/backend/src/core/addon/addon-route-request.ts
---

## Context

Addon HTTP ingress is `/addon/<addonId>/<path>`: one address per addon. An
integration that can be configured more than once (a second voice-assistant
skill, a second smart-home project) has nowhere to receive the calls of its
second instance, so those addons are single-instance by construction
(planning#415, part of #408).

The addresses already registered with third parties cannot change without
every account being linked again.

## Decision

- **A route declares `perInstance`.** The hub then serves it at
  `/addon/<addonId>/instances/<instanceId>/<path>` and at
  `/addon/<addonId>/<path>`. The handler reads `request.instanceId`.
- **One resolver**, `resolveAddonInstancePath` in the route registry: the
  instance segment names the instance; a path without it names the default
  instance, whose id is the addon id. Nothing else reads an instance out of
  a path.
- **The path without the segment is permanent.** It is the address third
  parties hold for the default instance — an alias forced from outside,
  resolved by the same resolver, not a second code path and not a
  migration window.
- **An instance id in a path is a plain id** (`[A-Za-z0-9._-]`, 1–64). A
  segment that is not one matches nothing.
- **A route that is not per-instance is not served under an instance
  segment** and its handler is told no instance, also across the fork
  bridge: the child keeps the instance only for a route it declared
  `perInstance`.
- The instance crosses the fork bridge as its own field of the `invoke`
  envelope, beside the path the child re-matches; it is not a route param.

## Alternatives rejected

- **A second route family** (`/addon-instance/<id>/…`): two dispatchers to
  keep equal in auth, rate limit and proxying.
- **Forcing a re-link** so every address carries the instance: every linked
  account of every operator, for no gain to them.
- **The instance as a `:instanceId` route param** written by each addon:
  each addon would then decide what the default is.

## Consequences

- The kernel does not check that the instance EXISTS: the records belong to
  the addon. A handler answers 404 for an instance it does not hold.
- Auth scope and the per-route rate limit stay keyed by addon, not by
  instance.
- The data-plane proxy (`ctx.dataPlane` prefixes) is not instance-aware.
- Nothing declares `perInstance` yet; the exporters move in their own steps
  of planning#415.
