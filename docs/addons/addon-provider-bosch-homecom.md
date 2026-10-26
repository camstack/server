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

The authorize query is the HomeCom Easy public client: `client_id`
`762162C0-FA2D-4540-AE66-6489F189FADC`, redirect `com.bosch.tt.dashtt.pointt://app/login`,
`response_type=code`, `prompt=login`, PKCE S256, `style_id=tt_bsch`, and the scope
`openid email profile offline_access` plus `pointt.gateway.claiming`, `pointt.gateway.removal`,
`pointt.gateway.list`, `pointt.gateway.users`, `pointt.gateway.resource.dashapp`,
`pointt.castt.flow.token-exchange`, `bacon`, `hcc.tariff.read`. On 2026-10-26 a request with that
scope was answered by SingleKey with the login page. The code exchange still needs the operator's
account. Reads and writes go to the PointT resource API
(`GET`/`PUT /pointt-api/api/v1/gateways/<id>/resource/…`), the same resources the MIT-licensed
`homecom_alt` library uses today. A write body is `{ "value": … }`. The path names live in
`homecom-pointt.ts`; this addon does not copy that library.

## Rotated tokens are stored

SingleKey rotates the refresh token on every use. The client reports each rotation
(`onTokensRotated`) **before** the new access token is used. A data call that is answered `401`
refreshes once (the SingleKey `refresh_token` grant) and retries that call. A second `401`, or a
refresh the token endpoint refuses, is `HomeComAuthError` and the manager asks the operator to sign
in again. The addon writes the pair through
`integrations.setSettings` (one write, serialised per integration, `token` + `refresh` named as secret
keys). If the stored secrets cannot be read back (the keychain is locked) nothing is written — the
hub refuses an overwrite of a secret the addon could not read — and a line says so, without values.
A restart therefore never presents a spent refresh token.

The hub restarts an addon after a settings write, so a rotation (roughly once per access-token life)
is followed by a restart of this addon. The manager keeps the rotated pair in memory too, so the
settings echo of that write is not seen as a changed connection.

## Gateways

There is no built-in gateway id. At start the manager lists the account's gateways
(`GET /pointt-api/api/v1/gateways/`). Each row's `deviceType` selects the resource tree:
`k40` and `k30` (boiler / heat pump), `icom` (heat pump) and `rrc2` (thermostat) read
`/heatingCircuits` and `/dhwCircuits`; `wddw2` is domestic hot water only; `rac` is one air
conditioner under `/airConditioning`. Any other type, including `commodule`, is refused by name
(`HomeCom does not serve device type "…"`).

- a stored `gatewayId` is used when the account still has it, and refused with a named error when it
  does not — silently moving to another gateway would control a different house;
- with none stored, the first gateway is used and **stored** (`gatewayId` setting);
- the list is exposed in the integration info (`gateways`).

One integration controls one gateway. For a second heat pump add a second HomeCom account entry
with the other gateway's id.

The connection test does not refresh tokens (a refresh would rotate the stored one with nowhere to
write it). It lists the gateways and reads `/resource/gateway/DateTime`, or
`/resource/gateway/versionFirmware` when the clock is absent, and names which one answered.

## What is supported

Heating circuits publish `climate-control` (setpoint, operation mode, room temperature). Domestic
hot water publishes `water-heater` (target, operation mode, current temperature). An air conditioner
also publishes fan speed and louver swing on that same climate cap. A resource the device does not
have is logged and left empty; heat-source, ventilation, pool, energy and zone readings are not
published on a cap, and that drop is logged once. Brand (`bosch` / `buderus`) and region are kept;
both use the same PointT origin.
