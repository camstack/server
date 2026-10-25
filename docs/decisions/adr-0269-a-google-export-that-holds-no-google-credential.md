---
id: D269
title: The Google export holds no Google credential — so it never pushes, and a HomeGraph key never becomes a setting
status: accepted
date: 2026-08-28
supersedes:
applies-to:
  - packages/addon-export-google/src/types.ts
  - packages/addon-export-google/src/oauth-integration.ts
  - packages/addon-export-google/src/export-google.addon.ts
  - scripts/check-no-service-account-keys.ts
---

## Context

`packages/addon-export-alexa/src/public-skill.ts` commits a real Login-with-Amazon
client secret to this repository, deliberately, with a docblock explaining why:
a published Alexa Smart Home skill has ONE set of "Send Alexa Events"
credentials, every self-hosted hub shares them, and the secret alone cannot push
anything to an account without that account's OAuth grant. That reasoning is
sound for Amazon's published-skill model.

The obvious move when adding Google was to copy the shape. It is wrong, and not
by a little.

Google's equivalent of proactive push is **Report State**, a call to the
HomeGraph API authenticated with a **service-account key**. That key is an RSA
private key that authenticates as a principal inside the operator's Google Cloud
project; its blast radius is every API that project has enabled, not one
smart-home Action, and there is no "public" variant of it. A committed HomeGraph
key is not a smaller version of the Alexa decision — it is a different decision.

The second half of the problem is where such a key would live if it were not
committed. The natural answer, "an addon setting with `type: 'password'`", does
not do what its name suggests. `packages/types/src/interfaces/config-ui.ts`
records the history at `packages/types/src/interfaces/config-ui.ts:1356`:
password fields deliberately hydrate with their STORED value, because the
earlier masking behaviour clobbered secrets on every unrelated save. The masking
is a `type="password"` input in the browser and nothing else — the plaintext
still crosses the wire on `addonSettings.getGlobalSettings`. The repo already
has two live instances of the resulting leak: `deviceExport.getStatus` returns
the Alexa ingress token in plaintext, and `provider-reolink`'s
`emailPushAuthPassword` comes back in clear. The `device-export` cap's
`ExportSetupField.secret` flag has the same shape — it masks the row in the
panel, it does not mask the response.

So there is no wire-masking secret field in this repo to put a HomeGraph key in.

## Decision

`addon-export-google` holds **no Google-issued credential of any kind**, and no
field of `GoogleExportSettings` may become one.

Concretely: account linking runs on the hub's own OAuth server via the
`oauth-integration` capability, so Google presents a token this hub minted and
the hub verifies it itself; and **Report State is not implemented**, so every
device is synced with `willReportState: false` and Google learns state by
polling QUERY. `requestSync` is unavailable for the same reason, which is why
`exposeDevice` logs that the device appears on Google's *next* sync.

When Report State is eventually built, the HomeGraph key arrives by **file path
or environment variable** — a path is not a secret and can safely live in
settings — is validated at startup with a clear error naming what is missing, is
never logged, never returned by any capability method, and never rendered in the
`device-export` setup block. It does not become a `type: 'password'` setting on
the strength of the word "password".

## Consequences

- State changes made outside the Home app reach Google only when Google polls.
  Google's own certification requires Report State for a *published* Action —
  which a self-hosted hub cannot obtain anyway, so the integration lives in test
  mode and the requirement does not bind.
- `QUERY` carries more weight than in a normal integration: it is the only path
  by which Google ever learns anything changed. Every branch of
  `intents/query.ts` therefore answers with a device entry — a missing key is a
  protocol error to Google, not "unknown".
- Nothing in the `device-export` setup block is marked `secret: true`, because
  there is nothing secret to mark. The three rows are URLs the operator pastes
  into the Google console.
- The operator must supply, entirely on Google's side: a Google Home Developer
  Console cloud-to-cloud integration, the fulfillment URL, and the OAuth
  authorization/token URLs. Nothing comes back to this hub.
- **This record is why the addon is useful without a credential at all**, which
  was not obvious at the outset: the expensive half of a Google integration
  (fulfillment, account linking, device model) needs nothing from Google, and
  only the push half does.

## Enforcement

`scripts/check-no-service-account-keys.ts`, wired into the guard loop in
`.github/workflows/ci.yml`. It fails the build on a Google service-account JSON
envelope (`"type": "service_account"` together with a `private_key`) or on a PEM
private key **with a body** anywhere in the tree, and it prints only the file and
line — never the matched text, because a CI log is one more place a leaked key
would then live.

The body requirement is not incidental: the first run flagged two files that
merely assert `key.startsWith('-----BEGIN PRIVATE KEY-----')` about a
certificate generated at runtime, which is the correct pattern. A guard that
fires on those is a guard someone deletes.

Nothing enforces the "no credential in settings" half automatically — the guard
catches a key that reaches the repository, not one an operator types into a
form. That half is review only, which is exactly why it is written down here.
