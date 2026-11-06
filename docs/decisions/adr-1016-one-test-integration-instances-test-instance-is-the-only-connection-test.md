---
id: D1016
title: One test - integration-instances.testInstance is the only way to test a connection or credentials
status: proposed
date: 2026-11-06
supersedes: D0100 (the `connection-test` cap), D886 (the test clause of the adoption wizard)
applies-to:
  - packages/types/src/capabilities/integration-instances.cap.ts
  - packages/types/src/capabilities/connection-test.cap.ts
  - server/backend/src/api/core/cap-providers.ts
  - scripts/check-one-test-method.ts
---

## Context

D1013 clause 4 says "one test: `testInstance`, with `canTest` per kind". `testInstance` already exists
(optional method on `integration-instances`, input `{ id | null, values, kind? }`, so a stored instance and
an unsaved draft are the same call) and `InstancesTable` / `InstanceEditorDialog` already use it. Four
more ways to the same question still exist, with four result shapes:

- `connection-test` cap (`testSettings` + `describeTest`, result `validated | rejected | inconclusive`),
  implemented by 11 addons: bosch x3, dreame, dreo, homematic, petkit, rademacher, rtsp, tuya, velux, wyze.
  Five of them (homematic, rtsp, tuya, velux, wyze) are not instance providers yet, so the legacy
  `integrations.testConnection` router (`runConnectionTest` in `cap-providers.ts`, which first tries
  `testInstance`, then `connection-test`, then a `brokerId` branch) and `ProviderConfigForm` are their only caller.
- `mqtt-broker.testConnection` (stored broker by id) and `mesh-network.testConnection` / tailscale `testConnection({ authKey })`.
- Per family tests of things that are not instance kinds yet: `storage.testLocation` and
  `storage-provider.testLocation` (draft or stored location), `llm.testProfile` (stored profile, a real generation),
  `training-provider.validateCredentials` (draft credentials), loki `testConnection(config)`.
- Not connection tests (kept): `notification-output.testTarget` (delivers a real message), `notification-rules.testRule`
  (dry-run of a rule), `user-management` / `auth-provider.validateCredentials` (the sign-in check of a person),
  `scripts` "run" actions.

## Decision

`integration-instances.testInstance` is the only method that tests the connection or credentials of a
configured thing. It is routed to the owning addon by the existing instances-provider binding; the addon
implements one hook per kind (`canTest` per kind says whether it probes the remote). The input keeps
`{ id | null, values, kind? }`: `id` set = a stored instance (its secrets resolved by the owner), `id` null =
an unsaved draft. The result keeps the tri-state of `TestConnectionResult` (`validated | rejected |
inconclusive | unsupported`, `success` true only for `validated`): a test that could not run is `inconclusive`
or `unsupported`, never `rejected`. No other cap carries a `test*` or credential-probing method for a configured
thing; a family joins by becoming an instance kind (steps 5 and 6 of the epic), and its own test method is deleted in
that step.

## Consequences

Step 4 is staged, not one commit. (a) Convert the five legacy integration addons to instance providers, then
delete `connection-test`, `integrations.testConnection`, `runConnectionTest` and `ProviderConfigForm`'s test button.
(b) Delete `mqtt-broker.testConnection` (broker already answers through `testInstance`). (c) `storage.testLocation`,
`llm.testProfile`, mesh/tailscale and `training-provider.validateCredentials` fold in when their kinds exist.

## Enforcement

`scripts/check-one-test-method.ts` (planned): refuses a `test*` / `validate*Credentials` method in a `*.cap.ts`
other than `testInstance`, with an allow-list for `testTarget`, `testRule`, and the user sign-in checks, each with its reason.
