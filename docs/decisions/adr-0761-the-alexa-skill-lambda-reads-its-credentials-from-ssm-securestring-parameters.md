---
id: D761
title: The Alexa skill Lambda reads its two credential pairs from SSM Parameter Store SecureString parameters, not Secrets Manager
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/addon-export-alexa/lambda-template/aws.js
  - packages/addon-export-alexa/lambda-template/secrets.js
  - packages/addon-export-alexa/lambda-template/broker.js
  - packages/addon-export-alexa/lambda-template/index.js
---

## Context

[D753](adr-0753-the-alexa-skill-secret-lives-only-in-the-skill-lambda-and-hubs-get-event-tokens-from-its-broker.md)
moved the skill's two Amazon client credential pairs (the "Send Alexa Events"
LWA client and the account-linking client) out of the hub and into the skill
Lambda, read from AWS Secrets Manager. Nothing was deployed with that version
yet. Secrets Manager bills per secret per month plus per API call. These are two
small, rarely rotated JSON values read at most once per 5 minutes per container,
and the features that justify Secrets Manager (managed rotation, cross-account
resource policies, replication) are not used. Parameter Store's standard tier
stores SecureStrings for free, encrypted with the AWS-managed `aws/ssm` KMS key.
The operator chose it for cost.

## Decision

The skill Lambda reads each credential pair from an SSM Parameter Store
**SecureString** parameter, standard tier, under the AWS-managed `aws/ssm` key:
`/camstack/alexa/lwa` and `/camstack/alexa/skill`, named by the env vars
`LWA_PARAM` / `SKILL_PARAM`. Each value is the JSON
`{"clientId","clientSecret"}` (`skill` may add `previousClientSecret`). The
Lambda reads them with `GetParameter` and `WithDecryption: true`, caches them
for 5 minutes, and re-reads the LWA pair at once when LWA answers
`invalid_client`. No Secrets Manager code or permission remains. The rest of
D753 (the broker, per-link credentials, DynamoDB, the migration) is unchanged.

## Consequences

- The execution role needs `ssm:GetParameter` on
  `parameter/camstack/alexa/*`. AWS documentation disagrees with itself on
  whether a SecureString under the AWS-managed `aws/ssm` key also needs
  `kms:Decrypt` on the role. The KMS page says no access control can be set on
  that key, and the key policy lets account principals decrypt through SSM. The
  Lambda/Parameter Store page lists `kms:Decrypt` as required for SecureStrings.
  The role therefore also gets `kms:Decrypt` on that key, limited by
  `kms:ViaService = ssm.<region>.amazonaws.com` and
  `kms:EncryptionContext:PARAMETER_ARN` matching `parameter/camstack/alexa/*`.
  That grant can decrypt nothing except these parameters, and only through
  SSM. For the operator's EU deployment it was applied on 2026-10-08 (inline
  policy `camstack-alexa-broker`, region eu-west-1).
- Rotation is now manual: edit the parameter value in the console. That is no
  loss, because Secrets Manager rotation was never configured.
- Standard parameters cap at 4 KB and a default throughput, far above two reads
  per container per 5 minutes.
- A parameter read without decryption returns ciphertext, so the decryption
  flag is pinned by a test.
- The legacy plain env vars (`LWA_CLIENT_ID` and the others) are still read when
  `*_PARAM` is unset, for the cut-over. `LWA_SECRET_ID` / `SKILL_SECRET_ID` are
  gone, with no aliases.

## Enforcement

`packages/addon-export-alexa/src/__tests__/lambda-broker.spec.ts`
("AWS wiring: SSM Parameter Store") drives `aws.js` against a fake
`@aws-sdk/client-ssm`. It pins `GetParameter` with `WithDecryption: true` (the
fake returns ciphertext otherwise), checks that SSM is the only SDK module
loaded, and checks that no parameter value reaches a log line on a normal read,
a rotation re-read, or a malformed parameter. The IAM policy is not checked by
anything. It lives in the README and on the role.
