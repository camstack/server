---
id: D918
title: A camera grant operates its accessories, and the motion-trigger toggle is operate, not configure
status: accepted
date: 2026-10-23
supersedes:
applies-to:
  - packages/types/src/capabilities/motion-trigger.cap.ts
  - scripts/check-actuation-not-admin.ts
  - server/backend/src/__tests__/cap-routers/camera-grant-operates-its-accessories.router.spec.ts
---

## Context

On the live hub, 2026-10-23, a non-admin user with access to a battery camera
(3628, behind a home hub) called `motionTrigger.setMotionTrigger` on its siren
child (3630) and its light child (3631) and got `FORBIDDEN: Admin required`.

The operator's rule: a user who has access to a camera has access to all of its
devices. The access model already had the parent → child inheritance for that
rule. A `device` grant carries `includeLinked`. The matcher
(`server/backend/src/api/trpc/scope-access.ts`, `candidateMetas` +
`deviceScopeCovers`) walks the child's PERSISTED ancestors at check time. A child
added later is covered, and a re-parented child stops being covered. The Access
panel writes `includeLinked: true` by default.

What refused the call was the tier, not the grant. D403 moved every actuation
cap to `auth: 'protected'`, `switch.setState` on the same siren included.
`motion-trigger` was not in that set and stayed `auth: 'admin'`, and
`adminProcedure` refuses before the device grant is consulted. So the same user
could switch the siren on and could not change whether it fires on motion.

The existing router harness could not see this. A cap router built on its own
reports the path `setMotionTrigger`, not `motionTrigger.setMotionTrigger`. That
path is not in `METHOD_ACCESS_MAP`, so the scope matcher was skipped. A spec
showed a refused child of another camera passing. The spec now mounts the router
at its real path (`buildMountedCapRouterForTest`).

## Decision

`motion-trigger.setMotionTrigger` is an OPERATE action, `auth: 'protected'`.
Its authority is the same as `switch.setState` on the same child: the caller's
`device` grant at `create`, which reaches the child of a granted camera through
`includeLinked`. `motion-trigger` joins the D403 actuation allowlist.

Configuring the camera's accessories stays `admin`: `accessories.setChildHidden`
and every settings, credential and zone cap.

The inheritance itself is unchanged. It stays resolved at check time from the
persisted parentage and is never copied into the grant. An explicit
`includeLinked: false` keeps meaning "only the devices selected" (D403, the
Access panel toggle). Making a camera grant cover its children unconditionally
would remove that toggle. That is a separate decision, and this record does not
make it.

## Consequences

- An Operate user (or any `device` grant with `create`) of a camera now toggles
  siren-on-motion and light-on-motion on that camera's children, as it already
  switched them.
- A View user still cannot, because `create` is required. A child of a camera
  outside the grant is refused by the matcher with its own reason, never the
  tier's.
- The change is in `@camstack/types` and the generated cap routers. It is live
  only once a `@camstack/server` containing it is applied to the hub.

## Enforcement

- `scripts/check-actuation-not-admin.ts` lists `motion-trigger`. Verified red
  with the method restored to `admin`.
- `scripts/method-tier-baseline.json` records the widened tier.
- `camera-grant-operates-its-accessories.router.spec.ts` fails on the old tier,
  and fails again when the ancestor walk in `candidateMetas` is removed.
