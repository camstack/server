---
id: D314
title: "A location whose provider is unknown WITHHOLDS its config, and the redaction sentinel is resolved on every door it travels back through"
status: accepted
date: 2026-08-30
supersedes:
applies-to:
  - packages/system/src/builtins/storage-orchestrator/location-secrets.ts
  - packages/system/src/builtins/storage-orchestrator/storage-orchestrator.addon.ts
  - packages/addon-admin-ui/src/components/storage/EditLocationModal.tsx
---

## Context

D298 shipped credential redaction for `StorageLocation.config`, driven by each
provider's own `configSchema` (`type: 'password' || secret === true`) rather
than a hardcoded key list. It is the right mechanism and it works. What it did
not have was a test that proved it was ever *reached*, and two directions it
was still wrong in.

**Nothing tested the wiring.** `location-secrets.spec.ts` pins the helpers, and
every one of its assertions stays green if `this.redacted(loc)` is deleted from
`listLocations` or `restoreRedactedSecrets(...)` from `upsertLocation`. Removing
each of those lines in turn, against the helper suite alone, produced no
failure. A helper nobody calls is a leak with a passing suite beside it — the
same shape this repo has been caught by before.

**Redaction failed OPEN when the provider was down.** The secret keys come from
`getProviderInfo().configSchema`, cached at boot and on every
`capability:provider-registered`. A providerId absent from that cache yielded
the empty set, which redacts nothing — and `listLocations` needs no provider at
all, because it reads the store and `statfs`es local paths. So there is a window
on every hub restart (`remote-storage` is a separate runner that registers after
the orchestrator boots), and it is *permanent* for a runner the CrashSupervisor
marked terminally `failed`. In that state the SMB password went out in clear to
every principal the scope matcher admits.

**And the sentinel had a third door nobody had walked.**
`EditLocationModal.handleTest` posts the form's current config — which holds
`__camstack_redacted__` for every credential the operator did not retype — to
`storage.testConfig`, which had no way to resolve it. The provider would try to
authenticate as `__camstack_redacted__` and answer `authentication failed`,
telling an operator that their working password is wrong. That is the same
confused-operator outcome as destroying the credential, minus the outage, and
it would have arrived on the first SMB location.

## Decision

**Redaction fails CLOSED on an unknown provider, and every path that accepts a
config back resolves the sentinel the same way.**

`secretKeysForConfig(config, declared)` takes what the provider declared or
`undefined` when this node has never heard from it. On `undefined` every key
the *framework* does not itself define is treated as secret —
`FRAMEWORK_CONFIG_KEYS` is `basePath`, `readOnly`, `maxUsedGb`,
`minFreePercent`, the four the orchestrator interprets on its own (capacity,
occupancy, drain mode, pressure thresholds) and therefore the only four that
cannot be a provider credential. It over-redacts by design: a host name is
withheld alongside the password, and nothing that was working stops, because
the admin UI cannot render a provider's form without that same absent
`configSchema` either.

Withholding uses the sentinel, never key deletion, so an edit saved in the
degraded state still round-trips every value back intact.

`storage.testConfig` gains an optional `locationId`. Given one, the orchestrator
restores sentinels from that location's stored config before dispatching — and
only when the stored row names the **same** `providerId`, because "resolve this
sentinel from whichever row I name" is a credential-borrowing primitive even
behind `auth: 'admin'`. The "Add location" wizard sends no id; everything it
holds was typed just now.

`listLocations` stays `protected`. The credential was the danger and it is gone;
what remains is a host name and a base path, and the tier is not the loose gate
it looks like — a non-admin principal is already scope-matched against
`storage.listLocations`'s `category:system` `view` entry in `METHOD_ACCESS_MAP`.
Tightening to `admin` would buy concealment from a caller already trusted with
the system category, and would break the read-only `cst_` tokens the deploy
runbook mints. Redact, do not tighten — the same call `device-config-secret-redaction.ts`
made for device passwords.

## Consequences

- **`FRAMEWORK_CONFIG_KEYS` is a closed set with a reason, not a guess list.**
  A key added there must be one this module defines the meaning of. Adding a
  provider-owned key to it re-opens the hole for that key.
- A provider that never registers now shows an operator a card of sentinels.
  That is the intended read: the provider is down, and the values behind it are
  not knowable from here.
- `testConfig` is no longer a pure function of its input. A caller that wants
  the literal it typed tested must omit `locationId`.
- Two redaction markers now exist in this system — `***` from
  `device-config-secret-redaction.ts` (tRPC middleware, non-admins only, admins
  see the real value) and `__camstack_redacted__` here (orchestrator, everyone,
  write-back resolves it). They are not interchangeable, and the device module's
  claim that "one redaction marker means one thing across the system" is no
  longer true. Converging them is a separate decision; doing it carelessly would
  break exactly one of the two round trips.

## Enforcement

- `packages/system/src/builtins/storage-orchestrator/__tests__/location-secrets-wiring.spec.ts`
  — the whole feature through the real `StorageOrchestratorAddon` over a fake
  registry: the operator's read → rename → save → *the share still
  authenticates* sequence asserted **at the provider**, `''` surviving as a
  genuine clear, the Test button resolving the sentinel, the cross-provider
  refusal, and the unregistered-provider row. Each of the eight implementing
  lines was removed in turn and each produced a failure here.
- `location-secrets.spec.ts` keeps pinning the discovery walk, including the
  PEM key parked in a `textarea` that `type: 'password'` alone would miss.
- Nothing checks that a NEW outward path re-applies `this.redacted(...)`. That
  is review only. The three that exist — `listLocations`, `getDefaultLocation`,
  `upsertLocation`'s echo — are each covered above.
