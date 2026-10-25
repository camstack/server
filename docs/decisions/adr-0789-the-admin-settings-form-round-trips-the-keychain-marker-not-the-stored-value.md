---
id: D789
title: The admin settings form round-trips a secret's keychain view, never its stored value
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/types/src/interfaces/config-ui.ts
  - packages/ui-library/src/composites/config-secret-field.tsx
  - packages/ui-library/src/composites/config-form-field.tsx
  - packages/addon-admin-ui/src/App.tsx
  - packages/system/src/builtins/device-manager/device-form-secrets.ts
---

## Context

D780 made the OIDC client secret a `password` item and pinned "the admin form
carries the STORED secret, so an untouched save writes the same secret back".
That contract existed because the earlier mask (`hydrateSchema` filled a
password with `''`) was submitted back by whole-form saves and destroyed the
cloudflare token. It kept the plaintext round-tripping through every admin's
browser: the form payload, the HAR file, the screen share, the cached response.

With the keychain (D787) the blob holds a marker, so there is no value to
round-trip — and the save path already treats an unchanged marker, `''` and
`null` as KEEP.

## Decision

`hydrateSchema` hands every keychain-stored field (by type, D783/D787) its
VIEW — `{ $secret, v: 1, set: true }`, `{ $secret: null, …, inline: true }`
for a pre-keychain plaintext value, or `null` — and never a value or a
default; editable-array rows get the same per secret item. The form renders
it as one password input with an eye and sends back exactly one of: the view
unchanged (KEEP), a typed non-empty string (CHANGE), or
`{ "$secretClear": true }` (CLEAR). Reveal is an explicit, audited admin call
(`keychain-admin.reveal`).

**Amended 2026-10-08 (operator feedback):** "set · Change · Clear · Reveal"
had too many controls. The field is now a single `password` input. Untouched,
it is empty behind a masked placeholder and sends nothing, so the view stays
the value. The eye on an untouched stored secret reveals it into the input as
text (a revealed value left as it was still sends the view); pressing it again
masks it; a refused reveal is shown as a tooltip on the eye. Typing sends the
new value. Emptying a box the operator revealed or typed into is the only
CLEAR, because they emptied a value they could see; an untouched field cannot
clear. With no host reveal, or a pre-keychain inline view (no ref), the
untouched eye is disabled.

**Amended 2026-10-08 (device forms):** the migration moved every device
password into the keychain, but a driver hydrates its form from the config
`loadConfig` resolved for it, so admins still received the plaintext. The
device-manager aggregate now reads the stored blob raw and hands every field
whose key holds a marker the marker's view (`viewStoredSecrets`). Its save
route (`applyDriverFormPatch`) keeps the view out of the driver's patch (KEEP)
and sends a clear to the driver as `''` while the door removes the stored
value. A device secret still inline keeps the driver's plaintext, and its eye
only toggles visibility.

This amends D780: its goal ("the mask never reaches the save") holds more
strongly, because the plaintext never reaches the browser either. D780's two
specs now assert that the view round-trips and the value never does.

## Consequences

- A pre-keychain INLINE value is shown as a view only in the addon's own
  settings forms (`BaseAddon` passes `inlineSecretsAsViews`), whose save path
  reads the view as KEEP. A camera driver's device settings, which apply the
  patch to the driver's config, keep the inline value they were given; a
  stored marker becomes a view there too, through the device-manager
  aggregate (top-level keys only — a nested or per-row device secret keeps the
  driver's hydration). (Refined the same day, before release: an unconditional
  view would have handed a driver an object where its schema expects a
  string.)
- A form that is not hydrated from a keychain-aware store (a create dialog
  seeding `''`) still renders a plain password input; the control is chosen
  once, at mount, from what the form was given.
- A probe or action that reads a secret from `paramsFromForm` receives the
  view, not the value; its owner must resolve the ref it names.
- A JSON textarea that holds a declared secret stays inline (D787) and is
  rendered as before.

## Enforcement

- `config-form-array-secret.test.tsx` and `config-secret-field.test.tsx`
  (ui-library): the view round-trips, reveal goes only through the host, and a
  clear happens only when a revealed or typed value is emptied.
- `KeychainRevealHost.spec.tsx` (admin-ui): reveal by ref, and a refused
  reveal shown on the eye.
- `device-form-secrets.spec.ts` (system): a device aggregate carries no
  plaintext; an untouched save keeps the secret, a typed one lands in the
  keychain, and a clear removes it.
- `oidc-client-secret-redaction.spec.ts` and
  `addon-settings-array-redaction.spec.ts` (server): the real schemas hydrate
  views; no keychain-stored value reaches an admin form.
- `base-addon-keychain.spec.ts` (types): a saved secret reads back as "set".
