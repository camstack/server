# CamStack Alexa Lambda — skill endpoint + token broker

One Lambda serves one Alexa Smart Home skill and every CamStack hub linked to
it. It routes each request to the right hub by the `hubUrl` claim the hub bakes
into its OAuth tokens, and — since D753 — it is the **only** place the skill's
Login With Amazon (LWA) client secret lives. Hubs never hold it: they receive
short-lived Event Gateway tokens from this Lambda's **token broker**.

The same code runs the built-in CamStack skill and any operator's own
("custom") skill. Each deployment uses its own secrets.

## What it does

| Invocation | Action |
| --- | --- |
| `GET  <FUNCTION_URL>/authorize` | The hub-address step of account linking (below): a form in the CamStack page style (en/it), then — after checking the hub — a redirect to the hub's OAuth `/authorize`. |
| `POST <FUNCTION_URL>/token` | Checks the account-linking client id/secret, decodes the `hubUrl` claim, proxies the token request to the hub. |
| Smart Home directive | Forwards to `${hubUrl}/addon/export-alexa/directive`, adding `X-CamStack-Broker: <broker origin>` when the broker is on. |
| `Alexa.Authorization/AcceptGrant` | Exchanges the grant code at `api.amazon.com` **here**, stores the grant in DynamoDB, gives the hub a per-link broker credential (`POST /addon/export-alexa/oauth/broker-link`). |
| `POST <FUNCTION_URL>/broker/token` | `Bearer <credential>` → `{ accessToken, expiresAt }` (refreshed here when < 5 min left). |
| `POST <FUNCTION_URL>/broker/migrate` | `{ refreshToken }` from a hub linked before D753 → a broker link. |
| `POST <FUNCTION_URL>/broker/rotate` | `Bearer <credential>` → `{ brokerCredential }`; the old one stops working. |
| `POST <FUNCTION_URL>/broker/revoke` | `Bearer <credential>` → deletes the link (and the refresh token). |

Errors Alexa receives follow the Smart Home contract: every `Alexa.ErrorResponse`
carries the directive's `correlationToken` and `endpoint`; a hub that cannot be
reached (network error, or a tunnel's 502–504 / 52x page) is
`BRIDGE_UNREACHABLE`; a hub reply that is not an Alexa event becomes
`INTERNAL_ERROR`; AcceptGrant failures are `Alexa.Authorization` /
`ACCEPT_GRANT_FAILED`. The `/authorize` page accepts only an `https://` hub URL
and shows its error on the page.

### The hub-address step (`/authorize`, `authorize-page.js`)

Alexa opens this URL in the user's browser; the Lambda cannot know the hub, so
the operator types its public HTTPS address (CamStack shows it under
Connectivity → Alexa → "Hub address to enter in the Alexa app"). The page is the
CamStack page family — `page-style.js` is generated from the hub's page shell
(`npx tsx scripts/gen-alexa-lambda-page-style.ts`; a spec fails when it drifts) —
and runs no script. The address is **checked before the browser leaves**:

| Reason code shown on the page | Meaning |
| --- | --- |
| `invalid_url` / `not_https` | not a web address / not `https://` |
| `local_address` | `localhost`, a private or tailnet IP, `.local` … — the Lambda runs in the cloud |
| `unreachable` | no answer to `GET /api/oauth2/integrations` (6 s) |
| `tls_error` | answered, but the certificate is not trusted by the Lambda's CA store |
| `not_camstack` | answered, but not with a CamStack discovery document |
| `integration_missing` / `hub_starting` | the hub does not serve `export-alexa` / is still registering it |

A good hub gets a 302 to `<hub>/api/oauth2/authorize?…&integration=export-alexa`.
From there the hub answers: consent on its own page; a refused request lands on
the hub's `/sso-complete` page with a reason code. **Changing the destination
hub** is the same step again: unlink on the old hub (Alexa export → Account link
→ Unlink now), disable/enable the skill in the Alexa app, and enter the new
address when asked. Tokens carry their `hubUrl` claim, so an existing link keeps
its old hub until it is re-linked.

### The two credential pairs

| Pair | SSM parameter (SecureString) | Authenticates | Who else holds it |
| --- | --- | --- | --- |
| **LWA "Send Alexa Events"** client (skill console → Permissions → Alexa Skill Messaging) | `/camstack/alexa/lwa` | this Lambda → `api.amazon.com` (code exchange, refresh) | nobody |
| **Account-linking** client (skill console → Account Linking) | `/camstack/alexa/skill` | Amazon → this Lambda's `/token` | Amazon |

Each parameter is a **SecureString** (standard tier, AWS-managed key
`alias/aws/ssm`) whose value is a JSON string:

```json
{ "clientId": "…", "clientSecret": "…" }
```

`/camstack/alexa/skill` may also carry `"previousClientSecret"` — accepted on
`/token` while you rotate it (change the value in the skill console, then remove
the previous one).

### The broker credential

`csb1.<linkId>.<secret>` — 128-bit id + 256-bit secret, minted per link at
AcceptGrant. The table stores only `sha256(secret)`; comparison is constant
time; an unknown link and a wrong secret get the same 401. It opens exactly one
link, is revoked by deleting the item, rotated by `/broker/rotate` or by any
re-link, and lapses after 180 days without a refresh (DynamoDB TTL).

## Files

`index.js` (handler), `broker.js`, `secrets.js`, `token-store.js`, `util.js`,
`http.js`, `aws.js`. No `node_modules`: AWS SDK v3 ships with the nodejs22.x
runtime. Build:

```bash
cd lambda-template && rm -f ../camstack-alexa-lambda.zip && zip -j ../camstack-alexa-lambda.zip *.js   # includes authorize-page.js and the generated page-style.js
```

## Deployment

It ships in the published `@camstack/addon-export-alexa` npm package (`npm pack`
it and take `package/lambda-template/`). Deploy it in the AWS region that serves
your skill's locale: NA → `us-east-1`, EU/IN → `eu-west-1`, FE/AU → `us-west-2`.

1. **Lambda**: Node.js 22.x, arm64, handler `index.handler`, timeout 8 s or
   more, 128–256 MB. Upload the zip.
2. **Function URL**: auth type `NONE` (Amazon's account linking and the hubs
   call it). Note the URL.
3. **Trigger**: **Alexa** → **Alexa Smart Home**, with your skill id
   (`amzn1.ask.skill.…`). Create the skill first to get it.
4. **SSM Parameter Store** (free standard tier): in the Lambda's region,
   Systems Manager → Parameter Store → **Create parameter**, twice:
   - Name `/camstack/alexa/lwa`, then `/camstack/alexa/skill`
   - Tier **Standard**, Type **SecureString**
   - KMS key source **My current account**, KMS key ID `alias/aws/ssm`
   - Value: the JSON above.

   Enter the values in the console, or with `aws ssm put-parameter --type
   SecureString --value file://…` from a file you delete afterwards — never as
   a literal command-line argument. The Lambda reads them with `GetParameter`
   and `WithDecryption: true`, caches them for 5 minutes, and re-reads the LWA
   pair at once when LWA answers `invalid_client`.
5. **DynamoDB**:

   ```bash
   aws dynamodb create-table --table-name camstack-alexa-tokens \
     --attribute-definitions AttributeName=linkId,AttributeType=S \
     --key-schema AttributeName=linkId,KeyType=HASH \
     --billing-mode PAY_PER_REQUEST \
     --sse-specification Enabled=true,SSEType=KMS \
     --deletion-protection-enabled
   aws dynamodb wait table-exists --table-name camstack-alexa-tokens
   aws dynamodb update-time-to-live --table-name camstack-alexa-tokens \
     --time-to-live-specification Enabled=true,AttributeName=ttl
   ```

6. **IAM** — add to the Lambda's execution role (replace region/account):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "ReadSkillParameters",
         "Effect": "Allow",
         "Action": "ssm:GetParameter",
         "Resource": "arn:aws:ssm:REGION:ACCOUNT:parameter/camstack/alexa/*"
       },
       {
         "Sid": "DecryptSkillParametersViaSsm",
         "Effect": "Allow",
         "Action": "kms:Decrypt",
         "Resource": "arn:aws:kms:REGION:ACCOUNT:key/AWS_SSM_KEY_ID",
         "Condition": {
           "StringEquals": { "kms:ViaService": "ssm.REGION.amazonaws.com" },
           "StringLike": {
             "kms:EncryptionContext:PARAMETER_ARN": "arn:aws:ssm:REGION:ACCOUNT:parameter/camstack/alexa/*"
           }
         }
       },
       {
         "Sid": "BrokerLinks",
         "Effect": "Allow",
         "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"],
         "Resource": "arn:aws:dynamodb:REGION:ACCOUNT:table/camstack-alexa-tokens"
       }
     ]
   }
   ```

   `AWS_SSM_KEY_ID` is the id of the AWS-managed `alias/aws/ssm` key (KMS
   console → AWS managed keys, or `aws kms describe-key --key-id
   alias/aws/ssm`). AWS's guidance on whether the AWS-managed key needs a
   `kms:Decrypt` grant is inconsistent — its key policy already lets account
   principals decrypt through SSM — so the statement is included, and scoped so
   it can only decrypt these two parameters, and only through SSM. A
   customer-managed key would need the same statement on that key instead. The
   default `aws/dynamodb` key needs no extra permission.

7. **Environment variables** (none is a secret):

| Name | Value |
| --- | --- |
| `LWA_PARAM` | `/camstack/alexa/lwa` |
| `SKILL_PARAM` | `/camstack/alexa/skill` |
| `TOKENS_TABLE` | `camstack-alexa-tokens`. Unset = broker off: AcceptGrant hands the tokens to the hub as before D753. |
| `LAMBDA_REDIRECT_URI` | Function URL + `/token`. AcceptGrant's `redirect_uri`; its origin is the broker URL advertised to hubs. |
| `BROKER_PUBLIC_URL` | Optional override of that origin (https only). |
| `LEGACY_HUB_FALLBACK` | `0` = a hub without `/oauth/broker-link` (pre-D753 addon) fails AcceptGrant instead of receiving the refresh token. Default on, for the cut-over. |
| `DEBUG_DIRECTIVES` | `1` = one `directive_trace` log line per Smart Home directive: namespace / name / endpointId / payloadVersion / payload keys asked, and the answered event (ErrorResponse type and message, StateReport property names and value shapes). Never the bearer token or SDP bodies. Diagnostic; default off. |
| `ALLOW_MIGRATION` | `0` = refuse `/broker/migrate`. Default on until every hub has migrated. |
| `HUB_INGRESS_TOKEN` | Optional defense-in-depth header (`X-CamStack-Ingress`), copied from the addon's **Ingress token** setting. |

Legacy, read only when the matching `*_PARAM` is unset: `LWA_CLIENT_ID`,
`LWA_CLIENT_SECRET`, `SKILL_CLIENT_ID`, `SKILL_CLIENT_SECRET`. Remove them once
the parameters exist and `*_PARAM` is set.

## Skill manifest

| Section | Field | Value |
| --- | --- | --- |
| Smart Home | Default endpoint | the Lambda ARN |
| Account Linking | Authorization grant type | Auth Code Grant |
| | Authorization URI | `<FUNCTION_URL>/authorize` |
| | Access Token URI | `<FUNCTION_URL>/token` |
| | Client ID / Secret | the `/camstack/alexa/skill` values |
| | Authentication scheme | Credentials in request body (**not** HTTP Basic — the Lambda reads them from the body) |
| | Scope, Domain list | empty |
| Permissions | Send Alexa Events | on; its Alexa Client Id/Secret go into `/camstack/alexa/lwa` |

## Cut-over and compatibility

| Lambda | Hub addon | Result |
| --- | --- | --- |
| new, broker on | new | Broker links. Hub holds no secret. |
| new, broker on | old (pre-D753) | AcceptGrant falls back to the legacy hand-off (hub 404 on `/oauth/broker-link`) unless `LEGACY_HUB_FALLBACK=0`. |
| new, broker off (`TOKENS_TABLE` unset) | any | Exactly the pre-D753 behaviour. |
| old | new | Links, but the hub cannot renew the grant (no secret): events stop after ~1 h until the Lambda is upgraded. **Upgrade the Lambda first.** |

A hub linked before D753 migrates itself: the first directive after the Lambda
advertises `X-CamStack-Broker` lets it trade its refresh token for a broker
link (`/broker/migrate`, which proves the token by refreshing it with the
skill's secret) and delete its copy.

## Logs

CloudWatch. `timedFetch_timing` (one per outbound call: host, path, status,
timings), `accept_grant: linked via broker`, `broker: migrated a pre-broker
grant`, `broker: credential rotated`, `broker: link revoked by its hub`,
`broker: grant revoked by Amazon; link removed`, `broker: request failed`. No
log line carries a token, code, credential or secret.

## Tests

`packages/addon-export-alexa/src/__tests__/lambda-broker.spec.ts` — the whole
Lambda against fake LWA, hub, SSM Parameter Store and DynamoDB (`npx vitest run`
in the addon).
