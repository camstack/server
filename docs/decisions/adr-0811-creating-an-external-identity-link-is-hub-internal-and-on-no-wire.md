---
id: D811
title: Creating an external-identity link is hub-internal — on no tRPC route, mesh action or ctx.api method
status: accepted
date: 2026-10-09
supersedes:
applies-to:
  - packages/system/src/auth/user-management-internal.ts
  - packages/system/src/builtins/local-auth/local-auth.addon.ts
  - packages/types/src/capabilities/user-management.cap.ts
  - server/backend/src/auth/sso-finish-deps.ts
---

## Context

D782 made `user-management.linkExternalIdentity` "admin on the wire for the
hub's own use" and listed that as open: an admin session (or anything on the
mesh) could plant a link for someone else, which D782 forbids every UI from
doing. Its only legitimate caller is the SSO finish, in the hub process. An
`auth: 'admin'` tier would still mount it on tRPC, the mesh and `ctx.api`.

## Decision

The method leaves the cap. `local-auth` attaches a hub-internal surface
(`UserManagementInternal`) to its in-process provider object under a
process-global symbol; hub code that holds that object reaches it with
`getUserManagementInternal`. A symbol does not survive serialization, so a
remote proxy of the provider has no such surface and the caller fails closed.
The same surface carries the other operations no wire may reach: login
sessions (D812), `setPassword`, admin tokens (D816) and the auth audit.

## Consequences

- No wire can create a link; only the finish's own link step does.
- `local-auth` must stay an in-process hub builtin for these to work; if it
  ever runs isolated, every internal operation fails closed (logins included)
  until the surface gets a transport of its own.

## Enforcement

`external-identities.spec.ts` (not a cap method, not an own key, a serialized
copy carries nothing), `scripts/method-tier-baseline.json` (the method is gone
from the baseline).
