---
title: Bosch HomeCom — sign-in, tokens, gateways
covers:
  - packages/addon-provider-bosch/src/homecom/**
  - packages/addon-provider-bosch/src/shared/oauth-callback.ts
---

# Bosch HomeCom — sign-in, tokens, gateways

HomeCom Easy heat pumps are reached through the Bosch PointT cloud. Nothing is local: the addon
holds an OAuth token pair for the operator's SingleKey ID and polls the cloud once a minute.

## Signing in

The same shape as Home Connect (PKCE, no browser automation):

1. **Create login link** (`beginSignIn`) returns the authorize URL, a PKCE verifier and a state.
2. Open the link in a browser and sign in with the SingleKey ID.
3. The browser then tries to open the app's redirect (`com.bosch.tt.dashtt.pointt://app/login?code=…&state=…`),
   fails, and stops. Copy that address — Chrome / Edge: DevTools (F12) > Network with *Preserve log*
   ticked **before** signing in, select the last redirect, copy its `Location` header; Firefox: Network >
   Headers > Location; Safari: Develop > Show Web Inspector > Network.
4. Paste it into the one text box and press **Complete sign-in** (`finishSignIn`). The full address, a
   `Location:` header row, a bare `code=…&state=…` query and the bare code are all accepted. An address
   must carry the `state` of this attempt; a bare code has none to check.
5. The exchange returns the access token, the refresh token and the account email. All three are
   declared secrets (`token`, `refresh`, `username`), so they land in the keychain, never in the
   settings blob. Save the form to connect.

Each failure has its own message: empty paste, no code in it, missing or wrong state (a different
attempt), a denied login, and a code that was already used or has expired (`invalid_grant`).

The access and refresh token fields remain editable: pasting a pair by hand still works.

> **Unverified against a live account.** The client id, redirect scheme, scope and the REST paths
> (`/v2/gateways`, `/v2/gateways/<id>/system`) come from the public community PointT client, not from
> this repository or from a captured session. Confirm the sign-in once on a real account; if the
> exchange is refused, the constants are in `homecom-oauth.ts` and the paths in `homecom-api-client.ts`.

## Rotated tokens are stored

SingleKey rotates the refresh token on every use. The client reports each rotation
(`onTokensRotated`) **before** the new access token is used, and the addon writes the pair through
`integrations.setSettings` (one write, serialised per integration, `token` + `refresh` named as secret
keys). If the stored secrets cannot be read back (the keychain is locked) nothing is written — the
hub refuses an overwrite of a secret the addon could not read — and a line says so, without values.
A restart therefore never presents a spent refresh token.

The hub restarts an addon after a settings write, so a rotation (roughly once per access-token life)
is followed by a restart of this addon. The manager keeps the rotated pair in memory too, so the
settings echo of that write is not seen as a changed connection.

## Gateways

There is no built-in gateway id. At start the manager lists the account's gateways (`/v2/gateways`):

- a stored `gatewayId` is used when the account still has it, and refused with a named error when it
  does not — silently moving to another gateway would control a different house;
- with none stored, the first gateway is used and **stored** (`gatewayId` setting);
- the list is exposed in the integration info (`gateways`).

One integration controls one gateway. For a second heat pump add a second HomeCom account entry
with the other gateway's id.

## What is supported

Heating circuits (climate: setpoint, operation mode) and domestic hot water (water heater: target,
operation mode), adopted from the cloud snapshot. Brand (`bosch` / `buderus`) and region are kept;
both use the same PointT origin.
