---
title: addon-google-services — package notes
covers:
  - packages/addon-google-services/**
---

# addon-google-services — package notes

Google is a **`broker` kind** (`google`), same pattern as Home Assistant:
each broker entry is one Google account (OAuth client + Sign in). Feature
caps aggregate every connected broker:

- **`broker`** — Connectivity → Brokers; add / edit / test / Sign in.
  `listProviders` advertises `interactiveConnectPath` so admin-ui opens the
  OAuth popup without hardcoding Google paths.
- **`calendar-source`** — Google Calendar for System → Calendars and
  notification calendar-events (via the hub `calendars` aggregator). Calendar
  ids are stamped `brokerId:googleCalendarId`.
- **`smtp-provider`** — Gmail send via the Gmail API (`users.messages.send` +
  raw MIME). When several accounts are connected, `from` picks the matching
  account; otherwise the first connected broker is used.

Connectivity lists this addon under **Brokers**, **Calendars**, and **Email**.
Calendars / Email settings only point at Brokers (Client ID, Sign in, filter,
and From live on the broker form).

## Operator setup

1. Connectivity → **Brokers** → Add → **Google**.
2. Google Cloud Console: enable **Google Calendar API** and/or **Gmail API**.
3. **Google Auth Platform → Audience** (or OAuth consent screen → Audience).
   External + **Testing** is fine for a personal hub. Under **Test users**,
   add the Google account(s) that will Sign in — otherwise Google returns
   `403: access_denied`. Publishing / verification is optional for a private hub.
4. Create an OAuth client of type **Web application**.
5. Add the authorized redirect URI:
   `<public-hub-origin>/addon/google-services/oauth/callback`
   where `<public-hub-origin>` is Network → **Public endpoint**
   (`local-network.getAddresses().roles.publicEndpoint.resolved`) — never invent
   the host from an env var (D729). Google rejects non-localhost `http://`
   redirects; do not register the LAN Internal address.
6. Paste Client ID + Client secret. **Test connection** validates the OAuth
   *client* with Google (not the account).
7. **Add broker** — admin-ui opens Google sign-in in a popup (`?popup=1`).
   The callback never answers with a text page: it redirects to the admin-ui
   completion page (`/sso-complete#return=oauth&status=…&reason=<code>`, built
   by `oauthLandingUrl` on the hub's public-endpoint role) which hands the
   outcome to the opener (`camstack:broker-oauth`) and closes, or — a PWA, a
   blocked popup — shows the result and returns to Connectivity. Scopes:
   `calendar.readonly` + `gmail.send` (`access_type=offline`, `prompt=consent`).
   If you cancel, use **Sign in** on the broker row.
8. Optional: calendar id filter and Gmail From on the broker form.
9. Use Enable on Calendars / Email to turn a capability off without removing
   the broker.

A hub that still has the pre-broker singleton (flat `clientId` + `oauth` state)
migrates once on boot to `google_001`.

## When Google refuses the refresh token

`invalid_grant` on a refresh sets `needsReauth` on that account's durable
state (`oauthAccounts`). While it is set the broker is NOT connected:
`isConnected` is false, `broker.list` reports `auth-failed` ("Google session
expired — sign in again"), the Sign in button shows, feature caps skip the
account, and `ensureAccessToken` fails fast without asking Google again. The
critical alert ("Google needs a new sign-in", action `navigation: 'server'` —
the sign-in start is an addon route, so admin-ui leaves the SPA through the
broker popup / a full navigation, never a router link) is raised once, on the
transition. A successful OAuth callback clears the flag and resolves the alert.

## Secrets

- Broker settings: `clientSecret` (`.meta({ secret: true })`).
- Durable state: `oauthAccounts.accounts[id].refreshToken` /
  `accessToken` via `secretStatePaths`.

## Traps

- Connect **requires** `brokerId` — start without it returns 400.
- Google omits `refresh_token` on a second consent without revoke — the addon
  refuses and tells the operator to revoke CamStack in Google Account security
  and reconnect.
- Optional `calendarFilter` (comma-separated Google calendar ids) is per
  broker; empty means all readable calendars for that account.
- Gmail From must match the connected account or a verified alias.
- `broker.publish` / `subscribe` / `getState` are refused — Google is REST +
  OAuth, not a message bus; use calendar-source / smtp-provider.
- After deploy, confirm `/addon/google-services/oauth/start` is mounted (401
  without session, 302 to login with `Accept: text/html`). A 404 means routes
  were not remounted — restart the addon.
