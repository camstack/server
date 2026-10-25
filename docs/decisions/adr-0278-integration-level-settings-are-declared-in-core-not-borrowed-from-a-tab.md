---
id: D278
title: Integration-level settings are declared in core, not borrowed from a tab
status: accepted
date: 2026-08-28
supersedes: D268
applies-to:
  - packages/types/src/addon/base-addon.ts
  - packages/types/src/capabilities/addon-settings.cap.ts
  - packages/types/src/interfaces/addon.ts
  - packages/system/src/kernel/transport/child-cap-protocol.ts
  - packages/system/src/kernel/moleculer/child-addon-call-dispatch.ts
  - server/backend/src/core/addon/addon-settings-provider.ts
  - packages/addon-admin-ui/src/lib/settings-forwarding.ts
  - packages/addon-admin-ui/src/components/settings/NodeAddonsSettingsPanel.tsx
  - packages/addon-admin-ui/src/pages/IntegrationDetail.tsx
  - packages/addon-provider-reolink/src/email-push-schema.ts
---

## Context

[D268](./adr-0268-a-provider-forwards-settings-to-a-second-page-never-to-a-second-scope.md)
shipped a mechanism for putting an addon's settings on its integration page, and
declared it as `ConfigSection.tab === 'integration'`.

**Why `tab` was chosen, stated plainly, because hiding it would make this record
worth less.** A new `ConfigSection` key was the first design and was measured,
not guessed: `ConfigSectionWithValuesSchema`
(`packages/types/src/capabilities/addon-settings.cap.ts:18`) is a Zod object,
tRPC parses every cap response through `.output(...)`, and Zod 4 strips unknown
keys — so a new section field reaches no browser until a `*.cap.ts` edit,
`npm run codegen` **and** a published `@camstack/server` have all shipped. `tab`
was already on the wire. The choice bought an addon-level deploy by borrowing a
field, and that trade was the mistake.

**What the borrowing cost, visible within a day of shipping.** `tab` also feeds
the settings tab bar, which is built from the union of `tab` values across every
fetched schema (`NodeAddonsSettingsPanel`, `selfTabbed`). So the addon's own
settings page grew a tab labelled **"integration"** — the mechanism's internal
name rendered as an operator-facing label. The symptom is cosmetic; the cause is
not. `tab` means *"how to GROUP this visually"*, and D268 also made it mean
*"WHERE this lives"*. Two meanings on one field is the implicit-coupling shape
this codebase keeps paying for, and the tab bar was simply the first place the
second meaning leaked.

The codebase had already decided this question and the answer was recorded three
lines from where D268 looked. `ConfigFieldBase` used to carry
`scope?: 'device' | 'global'`; it was removed, and the note left in its place
(`packages/types/src/interfaces/config-ui.ts:249`) says *"a field's scope is
determined by WHICH schema it lives in — not by a field-level marker."* D268
re-added a marker in a different costume.

Two further facts shaped the replacement:

- **The publish-train cost is now explicitly authorised**, so the argument that
  bought `tab` no longer applies.
- **An integration's settings are NOT the addon's settings, in general.**
  `integrations.setSettings` writes an EAV table (`integration_settings`, one
  row per `(integration_id, key)`); `addonSettings.updateGlobalSettings` writes a
  single JSON blob keyed by addon id. Different tables, different shapes. Making
  the integration page write the *integration* store would have been a defensible
  reading of "settings of an integration", and was rejected: the values already
  live in the addon store, one field must keep one home, and a migration would
  have bought a second store key — the exact defect (D266) this line of work
  exists to prevent.

## Decision

**An addon declares WHICH OF ITS GLOBAL SECTIONS ARE ITS INTEGRATION'S
CONFIGURATION, once, in core — `BaseAddon.integrationSettingSections(): readonly
string[]` — and core serves exactly those through
`addonSettings.getIntegrationSettings`. Placement is never expressed by
borrowing a field that already means something else, and `ConfigSection.tab`
returns to meaning only visual grouping.**

The declaration is a **list of section ids**, not a marker on each section: it is
one statement, in one place, next to the schema whose ids it names — which is
what lets core validate it. Five properties follow, and each is in core
precisely so no UI can re-decide it:

1. **One schema, therefore one store key.** `getIntegrationSettings` SELECTS
   sections out of `globalSettingsSchema()` and hydrates them from the same
   `resolveGlobalStore`. A field here is the same field, with the same bare key,
   the addon's own page shows.
2. **No integration-specific writer, deliberately.** The cap ships
   `getIntegrationSettings` and **no** `updateIntegrationSettings`; the writer is
   `updateGlobalSettings`. A second write path is how a surface acquires a second
   store key, so the contract omits one rather than documenting that nobody
   should call it.
3. **`perNode` fields are dropped.** Their key is `<key>@<nodeId>` and an
   integration is not a node; whichever node such a field silently picked would
   be a wrong answer for the operator who opened the page (D266).
4. **An unknown section id throws**, naming the bad id and the known ones.
   Skipping it would turn a rename into a page that quietly empties, which is
   indistinguishable from an addon with nothing to configure.
5. **Declaring nothing yields `null`, not an empty schema** — "no such surface"
   must stay distinguishable from "a surface that failed to load".

The UI keeps only what is genuinely the UI's: `NodeAddonsSettingsPanel` THROWS
on any mount that implies a narrower scope than the payload has — a `deviceId`,
`level: 'device'`, a non-null `nodeId`, or a competing `fieldScope`.

> **Amended 2026-09-05 — the on-screen scope statement is gone.** This record
> originally listed a fourth UI mechanism: a paragraph rendered by the panel
> ("Integration-wide settings — one value shared by every device this
> integration provides…"). The operator asked for it to be removed and it was.
> Nothing else in this record changes: the scope is still enforced by the four
> core properties plus the panel's refusals, which is why the paragraph was
> removable at all — it described a guarantee it never provided.

**The addon settings page keeps showing these sections.** They are declared, not
moved. The addon's own page is the complete view of its configuration, and a page
that silently omitted settings is a worse failure than two entry points to one
value — this repo has already shipped knobs nobody could find. A core test pins
the undeclared AND declared sections as still present on the addon page, so
nobody "fixes" this by hiding them.

**Forwarding stays refused for `mode: 'account'` integrations**, whose Config
modal renders the addon's schema but saves through `integrations.setSettings` —
the different store described above. Rendering both on one page would put two
controls with one label writing two tables.

## Consequences

- **A framework publish is required.** `getIntegrationSettings` is a new cap
  method, so `packages/types`, `packages/system` and `@camstack/server` must ship
  before the surface works. An `admin-ui` + `provider-reolink` deploy alone
  leaves it inert — the panel would call a method the hub's router does not
  expose. This is the cost D268 avoided and it is now paid deliberately.
- **`ConfigSection` gained no field**, so nothing new crosses the wire and the
  Zod-strip problem never arises. The declaration is consumed inside core and
  the wire carries only the already-selected schema.
- **`tab` is free again** and remains available to group sections *within* the
  integration page — the two meanings are now separate.
- **`provider-reolink` declares `globalSettingsSchema()` instead of overriding
  `getGlobalSettings()`.** The override existed because a dynamic
  `recommendedHost` was believed to need one; `listLanHosts()` is synchronous, so
  the base getter does the identical work. An addon that hides its schema behind
  a getter leaves core nothing to select from — declaring the schema is a
  precondition of this mechanism, not an incidental tidy-up.
- **`emailPushAuthPassword` is not made safer or less safe.** It is a
  `type: 'password'` field, which is an input mask, not a transport mask:
  `hydrateSchema` returns the stored secret, deliberately
  (`packages/types/src/interfaces/config-ui.ts:1351` records that the earlier
  always-hydrate-`''` masking was removed because full-form saves clobbered the
  stored secret with the mask). This surface calls the same admin-gated read the
  addon page already calls. **There is no secret field type that masks values in
  transit; one does not exist to be used here**, and building one means first
  solving the write-back problem that caused its removal.

## Enforcement

- `packages/types/src/addon/__tests__/base-addon-integration-settings.spec.ts` —
  11 assertions against the real `BaseAddon`: declared sections in declared
  order, undeclared ones absent HERE but still present on the addon page, values
  compared field-by-field against `getGlobalSettings` for the same key, a write
  through `updateGlobalSettings` landing on the bare key with no `@hub` sibling,
  `perNode` dropped here and retained there, a per-node-only declaration
  yielding `null`, and an unknown id throwing.
- `packages/addon-admin-ui/src/components/settings/__tests__/settings-forwarding.spec.tsx`
  — 10 assertions driving the REAL panel: it calls `getIntegrationSettings` and
  never `getGlobalSettings`; an addon that declared nothing renders nothing; NO
  scope paragraph renders (amended 2026-09-05 — it used to assert the opposite);
  no tab is named after the mechanism; the three re-scoping mounts throw; and a
  save from this surface is compared for equality with a save from the addon
  page (a scoped key fails it).
- `packages/addon-provider-reolink/src/__tests__/integration-forwarding.spec.ts`
  — 8 assertions: the declaration is wired to the core hook, the schema is
  declared rather than the getter overridden, the declared ids exist, the
  sections are the same OBJECTS as the schema's (so a separate "integration
  schema" cannot appear), and **no section carries `tab: 'integration'`** — the
  D268 regression, pinned.
- `packages/addon-admin-ui/src/components/settings/__tests__/settings-surface-scope.spec.ts`
  — the filesystem guard: no hardcoded node id on the panel, no
  "Integration-wide settings" paragraph in ANY of the three files that could
  render one, no section-id allow-list in the admin UI, and no file reading a
  tab id to decide placement.
- The transport keeps its own guard for free: `AddonSettingsMethod` is switched
  exhaustively with a `never` check
  (`packages/system/src/kernel/moleculer/child-addon-call-dispatch.ts:129`), so a
  settings method that reaches the cap but not the forked-addon dispatcher does
  not compile.
- Every assertion above was disarmed individually — implementing line reverted,
  RED confirmed, restored, GREEN confirmed. Counts are in
  (planning repo: sessions/sessions.md). <!-- drift-ok: moved to the private planning repo -->
