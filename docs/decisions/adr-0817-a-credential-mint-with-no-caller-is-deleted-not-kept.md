---
id: D817
title: A credential mint or validator with no caller is deleted, not kept for later
status: accepted
date: 2026-10-09
supersedes:
applies-to:
  - packages/system/src/auth/auth-manager.ts
  - packages/types/src/capabilities/user-management.cap.ts
  - packages/types/src/interfaces/auth.ts
  - server/backend/src/api/trpc/trpc.context.ts
  - server/backend/src/api/trpc/trpc.middleware.ts
---

## Context

`AuthManager.createServiceToken` minted a 24 h ADMIN JWT and nothing called
it. The tRPC context carried a `type: 'api_key'` JWT branch that nothing
minted, `user-management.createApiKey` created legacy keys that no boundary
accepted, and `validateApiKey` was a `protected` method any session could use
to probe them. Each was an unused path to authority waiting for a caller.

## Decision

Verified by grep before deleting: `createServiceToken`, `generateApiKey`,
`validateApiKey` (manager and cap), `createApiKey`, `ApiKeyManager.create` /
`validateToken`, the `type`/`keyId`/`agentId` JWT claims and the unused
`agentProcedure` are gone. The legacy API-key store keeps list and revoke so
existing rows can be seen and removed; it goes in a later release. A future
credential is added with its caller and its test, never ahead of them.

## Consequences

- A JWT claiming `type: 'api_key'` is an ordinary session-shaped token: no
  `keyId` identity, `isApiKey: false`.

## Enforcement

`auth.service.spec.ts` (the mints are absent), `non-credential-bearer.spec.ts`,
`scripts/method-tier-baseline.json`.
