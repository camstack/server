---
id: D950
title: A broker is created, edited and signed in through one dialog, and a kind declares its own sign-in
status: accepted
date: 2026-10-27
applies-to:
  - packages/addon-admin-ui/src/components/brokers/**
  - packages/addon-admin-ui/src/components/integrations/BrokerStep.tsx
  - packages/addon-admin-ui/src/lib/broker-sign-in.ts
  - packages/types/src/capabilities/broker.cap.ts
  - packages/addon-import-alexa/src/config.ts
  - packages/addon-import-alexa/src/alexa-login-routes.ts
---

## Context

The admin UI created and edited a broker in four places that each did the work
themselves. The integration wizard's `BrokerStep` had its own "use existing /
create new" toggle and its own create call; Connectivity's `BrokerManager` had
an Add dialog and an Edit dialog; the Matter dialog took "the first broker of
kind `matter`" and said "create it from settings" when there was none. Alexa
needed an interactive Amazon sign-in, so `BrokerStep` branched on the literal
`'alexa'`, rendered a third mode (`AlexaLoginStep`, 538 lines with its own
copy of the sign-in protocol and a hard-coded list of Amazon domains) and
relabelled "Create new" as "Paste cookie". The Add dialog of Connectivity
showed the same kind's whole manual form: domain, cookie blob, refresh token,
poll interval, none of which an operator should type before signing in.

The operator's ask: when an integration needs a broker and none exists, offer to
create one in a parallel dialog that reuses the same structure, return to the
integration's dialog with it chosen, and keep ONE mechanism for how integrations
and brokers meet.

## Decision

**One dialog creates and edits every broker, and one picker selects one.**

- `BrokerEditorDialog` (create when no broker is given, edit otherwise) is the
  only create / edit / sign-in surface. The wizard, Connectivity's list and any
  other caller mount it. `BrokerPicker` (a list of the brokers of one kind plus
  "Create new…") opens it stacked over the caller; on success the caller gets
  `onChange(newId)` with the new broker chosen, on cancel nothing changes, and
  the caller's own state is never unmounted. `BrokerStep` and the Matter dialog
  are a picker and a confirm button.
- **A kind declares its interactive sign-in; the dialog never names a kind.**
  `broker.listProviders` kinds carry an optional
  `signIn: { basePath }` (a hub-relative route set of the owning addon):
  `POST start` (body: the form's non-credential settings) → `{ sessionId,
  loginUrl }`, `GET status` → `{ phase, loginUrl, error }`, `POST commit`
  (`{ sessionId, name, brokerId? }`) → `{ brokerId }`, `POST cancel`. The
  account's email, password and one-time code are typed on the provider's own
  page behind `loginUrl`, never in CamStack. `BrokerSignInPanel` drives the
  contract; Alexa's existing proxy-login routes are its first implementation.
- **The form is laid out from the schema, by one rule**
  (`arrangeBrokerSchema`): fields the operator must supply come first; a field
  with a `default` or `defaultByCountry`, or one a sign-in fills
  (`filledBySignIn`, honoured only when the kind has a sign-in), moves into a
  collapsed "Advanced" section. A discriminator and fields gated on it
  (`showWhen`) are never separated. `defaultByCountry` (from the browser locale)
  and a name suggested from the kind's label ("Alexa Import", then "… 2")
  prefill what is derivable.
- A kind that signs in is signed in first: the primary action is "Sign in", and
  the manual Save is the secondary path. A test
  (`no-broker-kind-literals.spec.ts`) fails if any shared broker component names
  a kind.

Rejected:

- **A `signIn` step schema inside `getSettingsSchema`.** The settings schema is
  rendered by the generic `FormBuilder`; a multi-step, server-held session
  (start, poll, commit) is not a field, and encoding it as one would have made
  the form builder a flow engine.
- **Reusing `interactiveConnectPath` (the OAuth popup).** It needs an existing
  broker id and a popup that postMessages back; the Amazon flow creates the
  broker at commit time and has no popup. Both stay, as two declared
  capabilities of a kind, not two code paths in the dialog.
- **A broker picker inside the schema-driven config UI (a `broker-select`
  field).** The Alexa notification target keeps its addon-fed select; offering
  "Create new…" there needs that field type and is left as a follow-up rather
  than a third path.

## Consequences

`AlexaLoginStep` and `BrokerStep`'s Alexa mode are deleted; the Amazon domain
list lives once, in the addon (`AMAZON_DOMAINS`), which also serves it as the
region select. A new kind with an interactive sign-in declares `signIn` and
implements four routes; it needs no admin-ui change. `signIn` is an additive
field on `listProviders` (a framework change: `@camstack/types` must reach the
hub with the addon). A re-link of an existing broker uses the same panel with
`brokerId`. "Restore under its original id" is not offered for a kind that
signs in, since the sign-in mints the broker's id.

## Enforcement

`packages/addon-admin-ui/src/components/brokers/__tests__/no-broker-kind-literals.spec.ts`
(no kind literal in the shared components), `broker-editor-flow.spec.tsx`
(every kind's create path, the sign-in path, the stacked return and cancel),
`broker-schema-arrange.spec.ts` (the layout rule), and review for the rest.
