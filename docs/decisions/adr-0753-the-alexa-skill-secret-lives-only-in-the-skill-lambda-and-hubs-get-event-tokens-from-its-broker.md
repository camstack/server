---
id: D753
title: The Alexa skill's LWA secret lives only in the skill Lambda, and hubs get Event Gateway tokens from its broker
status: accepted
date: 2026-10-07
supersedes:
applies-to:
  - packages/addon-export-alexa/lambda-template/**
  - packages/addon-export-alexa/src/public-skill.ts
  - packages/addon-export-alexa/src/broker-client.ts
  - packages/addon-export-alexa/src/lwa-event-gateway.ts
  - packages/addon-export-alexa/src/handlers/broker-link-callback.ts
  - packages/addon-export-alexa/src/http-server.ts
  - scripts/check-no-client-secrets.ts
---

> **Superseded in part by [D761](adr-0761-the-alexa-skill-lambda-reads-its-credentials-from-ssm-securestring-parameters.md)
> (2026-10-08).** The rule stands: no Amazon client secret lives in a hub or
> in any npm package, and the skill Lambda is the token broker. What changed
> is WHERE the Lambda keeps the two credential pairs. It is SSM Parameter
> Store SecureString parameters (`/camstack/alexa/lwa`,
> `/camstack/alexa/skill`, AWS-managed `aws/ssm` key), not Secrets Manager, so
> the role permission is `ssm:GetParameter` plus a `kms:Decrypt` grant scoped
> to SSM and those parameters. Read every "Secrets Manager" below as
> "Parameter Store".

## Context

To push proactive events (doorbell, motion, battery, ChangeReport,
Add/DeleteReport) a hub needs an LWA access token for the linked Amazon account,
and renewing it needs the skill's "Send Alexa Events" LWA **client secret**. The
Lambda exchanged the AcceptGrant code and handed the hub the refresh token; the
hub then refreshed it itself, with the secret read from `public-skill.ts` — a
constant committed to source, justified in a comment ("the per-account refresh
token is the real gate"). `@camstack/addon-export-alexa` is public on npm: every
one of its 164 published versions carries the secret, and so does git history.

The justification was wrong about what it protects. With the secret, anyone who
holds any user's refresh token (a hub backup, a log, a support bundle) can mint
event tokens for that account forever; anyone can impersonate the skill's
messaging client at LWA (`client_credentials` for skill messaging) and exchange
any intercepted AcceptGrant code; and Amazon may treat a published client secret
as a policy violation of the skill. The account-linking client secret
(`SKILL_CLIENT_SECRET`) was never in the hub — it authenticates Amazon to the
Lambda's `/token` and lived only in the Lambda's env.

Considered and rejected: relaying every event through the Lambda (one Lambda
invocation per motion edge, added latency on the doorbell path, and the Lambda
would need the endpoint payloads); a shared hub↔Lambda secret (one leak = every
hub, the same problem again).

## Decision

**No Amazon client secret lives in a hub or in any npm package.** The skill's
Lambda is the token broker: it reads both credential pairs from AWS Secrets
Manager (`camstack/alexa/lwa`, `camstack/alexa/skill`, 5-minute cache, re-read on
`invalid_client`), exchanges AcceptGrant codes itself, keeps each user's refresh
token in DynamoDB (`camstack-alexa-tokens`, SSE-KMS, TTL), and gives each hub a
**per-link credential** `csb1.<linkId>.<secret>` (only `sha256(secret)` stored;
constant-time compare; revocable by deleting the item; rotatable via
`/broker/rotate` and on every re-link; lapses after 180 idle days). The hub calls
`/broker/token` with it for a short-lived access token and talks to the Event
Gateway directly. A hub linked before this migrates itself: a verified directive
carries `X-CamStack-Broker`, and the hub trades its refresh token at
`/broker/migrate` (the broker proves it by refreshing it with the skill secret)
and deletes its copy. Custom-skill operators run the same Lambda with their own
secrets; the hub settings have no LWA fields.

## Consequences

- Ship order is Lambda first, hub second. A new hub behind an old Lambda links
  but cannot renew (events stop after ~1 h). The new Lambda serves old hubs
  (legacy hand-off on a 404 from `/oauth/broker-link`) until
  `LEGACY_HUB_FALLBACK=0`, and behaves exactly as before while `TOKENS_TABLE` is
  unset — so it can be deployed before the table and secrets exist.
- The leaked secret stays leaked in git history and on npm. It becomes harmless
  only when rotated in the Amazon developer console and the new value is put in
  Secrets Manager. Deprecating old npm versions does not remove their tarballs.
- The Lambda gains state (one DynamoDB table) and two IAM permissions on its
  role (`secretsmanager:GetSecretValue` on `camstack/alexa/*`; `GetItem`/`PutItem`/
  `DeleteItem` on the table).
- A broker 401/410 now means "re-link": the hub drops the link and says so.
- `/broker/migrate` accepts any live refresh token of the skill — exactly the
  power that token already has. It is switched off (`ALLOW_MIGRATION=0`) once
  every hub has moved.

## Enforcement

`scripts/check-no-client-secrets.ts` (CI guard list) fails when a
client-secret-shaped value appears in any git-tracked file of a publishable
package; `scripts/__tests__/check-no-client-secrets.heavy.spec.ts` runs it against the
repository. `src/__tests__/lambda-broker.spec.ts` pins that the LWA secret only
ever goes to `api.amazon.com`, that a broker-linked hub never receives a refresh
token, and that no log line carries a token, credential or secret.
