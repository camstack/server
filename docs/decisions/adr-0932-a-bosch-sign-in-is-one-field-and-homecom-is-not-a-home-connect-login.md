---
id: D932
title: A Bosch sign-in is one field, and a HomeCom login is not a Home Connect login
status: accepted
date: 2026-10-24
supersedes:
applies-to:
  - packages/types/src/interfaces/config-ui.ts
  - packages/ui-library/src/composites/account-sign-in-field.tsx
  - packages/addon-provider-bosch/src/homecom/**
  - packages/addon-provider-bosch/src/home-connect/**
  - packages/addon-provider-bosch/src/shc/**
  - packages/addon-provider-bosch/src/shared/sign-in-attempt.ts
---

## Context

HomeCom and Home Connect each showed about ten settings fields for one sign-in:
a button, a login link, a paste box, the PKCE state, the verifier, a Finish
button, and the tokens. The verifier had to travel through the form, so a
saved integration could persist it. Bosch only accepts its own app redirect
(`com.bosch.tt.dashtt.pointt://…` or `hcauth://…`), so one paste stays. The
rest is bookkeeping.

A single Bosch account broker was the other option: sign in once, and each
integration picks that account. It only works if one sign-in yields tokens
both APIs accept. They do not.

| | HomeCom | Home Connect |
| --- | --- | --- |
| Identity provider | SingleKey ID (`https://singlekey-id.com/auth/connect/authorize`) | Home Connect OAuth (`https://api.home-connect.com/security/oauth/authorize`) |
| Client id | `762162C0-FA2D-4540-AE66-6489F189FADC` | `9B75AC9EC512F36C84256AC47D813E2C1DD0D6520DF774B020E1E6E2EB29B1F3` |
| Redirect | `com.bosch.tt.dashtt.pointt://app/login` | `hcauth://auth/prod` |
| Token endpoint | `https://singlekey-id.com/auth/connect/token` | `https://api.home-connect.com/security/oauth/token` |
| Scopes | `openid email profile offline_access` plus `pointt.gateway.*`, `bacon`, `hcc.tariff.read` | `Control DeleteAppliance IdentifyAppliance Images Monitor ReadAccount ReadOrigApi Settings WriteAppliance WriteOrigApi` |
| Refresh | `refresh_token` at the SingleKey token endpoint; no lifetime is recorded on the client | `refresh_token` at the Home Connect token endpoint; no lifetime is recorded on the client |
| Account label | email from the id token | JWT `sub`, not an email |

A SingleKey access token is a Bearer for `https://pointt-api.bosch-thermotechnology.com`.
A Home Connect access token is a Bearer for the Home Connect account and
appliance APIs. The browser IdP behind Home Connect may also be SingleKey;
the tokens are still issued by different clients, for different audiences,
and one is refused by the other API. There is no shared refresh lifetime to
inherit, because neither client records one.

## Decision

Sign-in is one `account-sign-in` field. The addon returns an authorize URL
and an attempt id. The PKCE verifier and the OAuth state stay in an
in-memory attempt store (10 minutes, consumed on use) and are never sent to
the form. Pasting a redirect or a code completes the sign-in. Tokens are
`password` fields with keychain markers (D783) and are not shown. A collapsed
Advanced group keeps a manual token paste. Sign-out writes `SECRET_CLEAR`;
an empty string does not clear a keychain secret.

HomeCom lists the account's gateways after sign-in. One gateway fills
gateway id, brand and region (brand and region default to `bosch` and `eu`
when the listing omits them). Several gateways are a choice. A list that
fails does not fail the sign-in.

Home Connect uses the same field. Appliances are discovered as before.

SHC finds the controller with mDNS (`_http._tcp.local`, names starting with
`Bosch SHC`). A typed host wins over a discovered one. Registration generates
the client certificate, private key and token and stores them as secrets.
The form shows whether a client is registered, not the PEM.

There is no Bosch account broker. HomeCom and Home Connect each keep their
own sign-in, because one token cannot serve both APIs.

Stored keys stay `token`, `refresh`, `username`, `gatewayId`, `brand`,
`region`, `sslCertificate`, `sslKey`, `host`, `appliances` and
`applianceSecrets`. `accountLabel` and `gatewayCount` are new and optional.
No migration (D900). An integration saved before this change is read from
those same keys; a secret username is shown as "your account" until the
next sign-in writes `accountLabel`.

## Consequences

- A second HomeCom gateway is a second integration. The choice writes
  `gatewayId`, `brand` and `region` on the one being edited.
- The attempt store is process memory. A runner restart during the paste
  window is an expired attempt, and the operator starts again.
- Advanced is a sibling group, not nested under the sign-in field, so the
  keychain walker still sees the password keys.
- A broker added later would need a token that both APIs accept. These two
  clients do not issue that token.

## Enforcement

- `homecom-sign-in.spec.ts`: the published result has no verifier; a paste
  completes; a missing attempt, an expired attempt, a mismatched state and
  a denial use the existing reasons; one gateway is filled in; several are
  a choice; sign-out is `SECRET_CLEAR`.
- `home-connect-account-status.spec.ts`: the two client ids, token URLs,
  redirects and scopes differ.
- `shc-controller-discovery.spec.ts` and `shc-config.spec.ts`: a Bosch SHC
  answer is kept, the typed host wins, and the generated certificate and
  key are secret outputs with no visible PEM field.
- `account-sign-in-field.test.tsx`: signed out, pasting, and signed in.
