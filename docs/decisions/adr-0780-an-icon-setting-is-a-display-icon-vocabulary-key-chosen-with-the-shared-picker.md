---
id: D780
title: An icon setting is a display-icon vocabulary key chosen with the shared picker, and a value outside the vocabulary draws the field's default
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/types/src/interfaces/config-ui.ts
  - packages/types/src/device/icon-catalog.ts
  - packages/ui-library/src/composites/config-icon-field.tsx
  - packages/ui-library/src/composites/config-form-field.tsx
  - packages/addon-admin-ui/src/components/login/PrimaryLoginMethods.tsx
  - packages/addon-auth/src/**
---

> **Amended by [D854](adr-0854-one-typed-icon-catalog-every-lucide-icon-both-surfaces-draw.md):** the display-icon vocabulary is now the icon catalog (`ICON_KEYS`, `resolveIconKey`); an icon setting still stores a key chosen with the shared picker and draws the field's default for a value outside it.

## Context

The OIDC provider's icon and magic-link's icon were free-text fields
described as "lucide-react icon name". Nothing checked the text, and the
login page ignored it — every redirect button drew `ShieldCheck`. Meanwhile
device and room icons already had one control, `<IconPicker>`, over one
vocabulary (`DISPLAY_ICON_VOCABULARY`, 157 keys, searchable in Italian and
English), with one glyph table per platform. A free-text field could store a
name no table draws.

## Decision

A settings field that chooses an icon is `type: 'icon'`. Its value is a
display-icon vocabulary key; its `default` is one too. The schema-driven form
renders it with `<IconPicker>` and `resolveDisplayIcon` — at top level and
inside an `editable-array` row, the same control. Clearing writes the default
back. Whoever draws or forwards the value resolves it against the vocabulary
(`resolveDisplayIconKey(value, default)`, or `isDisplayIconKey`), so a stored
value from before the picker — `mail`, a misspelling — draws the default
instead of nothing. The login page draws a redirect method's icon through the
same glyph table.

Secrets in the same forms keep D634: the OIDC `clientSecret` is now a
`password` item — masked in the form, withheld from a non-admin read, and
carried whole to an admin so an untouched save writes the stored value back.

## Consequences

- Magic-link's default icon moves from `mail` (not in the vocabulary) to
  `mailbox`; OIDC keeps `shield-check`.
- `ConfigIconField` is compile-time only on the wire (`z.custom<ConfigField>`).
  An admin-ui older than this renders the field through its default branch, so
  admin-ui ships with (or before) the addons that use it; the addons only call
  `isDisplayIconKey`, which the published `@camstack/types` already has.
- A new icon setting anywhere must use `type: 'icon'`; a free-text icon field
  is a regression of this record.

## Enforcement

`config-form-icon-field.test.tsx` (picker rendered, key written, clear →
default, out-of-vocabulary → default glyph, inside an editable-array row),
`primary-login-methods.spec.tsx` (the button draws the key, falls back to
shield-check), the D780 cases in `auth-oidc.addon.spec.ts` and
`auth-magic-link.addon.spec.ts`, `config-form-array-secret.test.tsx` and
`oidc-client-secret-redaction.spec.ts` (the secret is masked, round-trips as
stored for an admin, and never reaches a non-admin). Review only for new icon
fields.
