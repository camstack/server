---
id: D268
title: A provider forwards settings to a second PAGE, never to a second SCOPE
status: superseded
date: 2026-08-28
supersedes:
applies-to:
  - packages/addon-admin-ui/src/lib/settings-forwarding.ts
  - packages/addon-admin-ui/src/components/settings/NodeAddonsSettingsPanel.tsx
  - packages/addon-admin-ui/src/pages/IntegrationDetail.tsx
  - packages/addon-provider-reolink/src/email-push-schema.ts
---

> **Superseded by [D269](./adr-0278-integration-level-settings-are-declared-in-core-not-borrowed-from-a-tab.md).**
> The mechanism below is right about scope and wrong about where the declaration
> lives. `section.tab` was chosen to avoid a framework publish train; because
> `tab` also feeds the settings tab bar, the addon's own page rendered a tab
> labelled "integration" — the mechanism's name leaking into an operator-facing
> label. The publish train was then authorised and the declaration moved into
> core (`BaseAddon.integrationSettingSections()`). Everything this record says
> about scope, the single store key, the refused mounts and the panel-owned
> scope statement was KEPT; only the declaration axis changed.

## Context

An operator looking for "the Reolink SMTP port" looks under Reolink. Today the
six `emailPush*` keys are reachable only from surfaces that enumerate *every*
addon on the hub — System → Settings and the Addons card dialog. The request was
for a core mechanism by which a provider can surface some of its addon-level
settings on its own integration page, opt-in, "dipende dalla natura
dell'integrazione" [it depends on the nature of the integration].

The dangerous half is not the plumbing. It is that **a forwarded control is
still one addon-wide value in one store**, and a page that implies otherwise is
worse than no page. This repo has shipped that failure twice, and both were
found by the cluster settings census (`docs/design/2026-08-28-cluster-settings-census.md`):

- `AddonCard.tsx` pinned `nodeId="hub"`, so `terminal.btmPath` edited there
  wrote `btmPath@hub` while the same field on Cluster → agent-a wrote
  `btmPath@agent-a`. Two reachable controls, one label, two store keys,
  and both showed a value — the disagreement was invisible.
- `ProviderSettingsTab.tsx` mounted an addon-wide `level: 'global'` schema
  inside ONE camera's page, where editing `emailPushPort` from camera 102 would
  have reconfigured every Reolink. It turned out to have zero importers and is
  deleted by this change — an orphan that describes a design nobody uses reads
  as verification that the design exists.

Three designs were tried before this one.

**A new `ConfigSection` key (`surfaces?: readonly SettingsSurface[]`) — rejected
on a fact.** `ConfigSectionWithValuesSchema`
(`packages/types/src/capabilities/addon-settings.cap.ts:18`) is a Zod object,
tRPC parses every cap response through it
(`server/backend/src/api/trpc/generated-cap-routers.ts:375`), and Zod 4 strips
unknown keys — verified directly, not assumed. A new key therefore reaches the
browser only after a `*.cap.ts` edit, `npm run codegen`, **and** a
`@camstack/server` publish train. The declaration would have been inert on
exactly the cluster it was written for.

**A shared `INTEGRATION_SURFACE_TAB` constant exported from `@camstack/types` —
rejected for the same class of reason.** `@camstack/types` is a framework
external for addon bundles (`tools/build/vite-lib.preset.ts:38`), so a provider
importing the symbol would resolve it against the hub's *installed* framework
and get `undefined` until a publish shipped.

**The `cap` request axis (`globalSettingsSchema(cap)`, as `tailscale-client` and
`pipeline-analytics` use it) — rejected on the guarantee it cannot give.** It is
already on the wire and needs no framework change, but it lets an addon return a
*different schema* for the integration surface. Nothing structural would stop
that schema from carrying a different key, a second copy, or a per-node field.

## Decision

**A provider forwards settings by tagging sections of its existing global
settings schema with `tab: 'integration'`. The forwarded population is a SUBSET
of the same schema payload the addon's own page renders — never a second schema
— and the surface that renders it is narrowed to the cluster store scope, states
that scope on screen, and refuses any mount that would imply a narrower one.**

Concretely, and each clause is load-bearing:

1. **Subset, not a second schema.** `selectForwardedSchema`
   (`packages/addon-admin-ui/src/lib/settings-forwarding.ts:143`) filters the <!-- drift-ok: selectForwardedSchema was removed by D269; this record describes the superseded design -->
   exact `getGlobalSettings` result, and the panel saves through the exact
   `updateGlobalSettings` path. There is no seam at which a second store key
   could appear: the forwarded control writes the same bare key or nothing.
2. **Narrowing and scoping are one function.** `selectForwardedSchema` is the
   only exported way to obtain the forwarded population and it always ends in
   `filterSchemaByFieldScope(_, 'cluster')`. A provider that forwards a section
   containing a `perNode: true` field gets that field **dropped** — a
   node-scoped value on a page with no node is the `btmPath@hub` defect.
3. **The surface refuses the mounts that would re-scope it.**
   `NodeAddonsSettingsPanel` throws when `surface` is combined with
   `level: 'device'`, a `deviceId`, a non-null `nodeId`, or a competing
   `fieldScope` (`NodeAddonsSettingsPanel.tsx:317`). A device page cannot mount
   this by accident.
4. **The scope statement is rendered by the panel, not the caller**
   (`SURFACE_SCOPE_STATEMENT`, `settings-forwarding.ts:92`). A caller cannot
   forget a line it does not write — `AddonCard` hand-writes its equivalent and
   needs a filesystem guard to keep it.
5. **Forwarding is refused where the page already edits the same schema through
   a different store.** An `account`-mode integration's Config modal renders
   this same schema through `ProviderConfigForm` and saves it with
   `integrations.setSettings`, not `addonSettings.updateGlobalSettings`
   (`IntegrationConfigModal.tsx:215`). Forwarding onto that page would put two
   controls with one label on one screen writing two places — this mechanism
   reproducing the defect it exists to prevent.

`section.tab` is the declaration because it is the axis that already answers
"which surface does this section belong to", it already crosses the wire
(`addon-settings.cap.ts:25`), and it already has a caller-side filter. An
addon-level declaration deploys immediately.

## Consequences

- **The provider's literal is duplicated on purpose.** `INTEGRATION_SURFACE_TAB`
  is declared in `email-push-schema.ts` and restated as
  `SURFACE_SECTION_TAB.integration` in admin-ui. This is the cost of point two
  of the Context; the two are pinned against each other by test, not by
  convention, because a drift here forwards nothing and throws nothing — the
  page just goes quiet.
- **Forwarded sections now carry `tab: 'integration'` everywhere**, so on System
  → Settings and the Addons card they group under an "Integration" heading
  rather than "General". Cosmetic, and arguably informative.
- **A second surface arrives as a new member of `SettingsSurface`** with its own
  scope statement — not as a second parallel flag that can disagree with this
  one.
- **This mechanism cannot express a per-device setting, by construction.** That
  is the point. A setting that differs per camera belongs in
  `deviceSettingsSchema`.
- **`emailPushAuthPassword` is not made safer or less safe by this change.** It
  is a `type: 'password'` field, which is an input mask, not a transport mask:
  `hydrateSchema` returns the stored secret in plaintext, deliberately
  (`packages/types/src/interfaces/config-ui.ts:1351` records that the earlier
  always-hydrate-`''` masking was removed because full-form saves clobbered the
  stored secret with the mask). The forwarded surface calls the same
  admin-gated `getGlobalSettings` the addon page already calls and renders the
  same field type, so exposure is unchanged. **There is no secret field type
  that masks values in transit; one does not exist to be used here.** Building
  one means solving the write-back problem that caused its removal, and is out
  of scope for this record.

## Enforcement

- `packages/addon-admin-ui/src/components/settings/__tests__/settings-forwarding.spec.tsx`
  drives the **real** panel over a Reolink-shaped schema: declared sections
  render, undeclared ones do not, an addon that declares nothing gets nothing, a
  `perNode` field tagged for the surface is dropped, the scope statement
  renders, and the three re-scoping mounts throw. Its central assertion saves
  through both the forwarded surface and the addon page and compares the two
  `updateGlobalSettings` inputs for equality — a scoped key (`emailPushPort@hub`)
  fails it.
- `packages/addon-provider-reolink/src/__tests__/integration-forwarding.spec.ts`
  pins the tab literal on the provider side, pins exactly which keys are
  forwarded, forbids a `perNode` field among them, and asserts the forwarded
  sections are the *same objects* as the schema's — so a future "integration
  schema" cannot be introduced without failing.
- `packages/addon-admin-ui/src/components/settings/__tests__/settings-surface-scope.spec.ts`
  extends the existing filesystem guard to the integration page: no hardcoded
  node id on the panel, and no hand-written scope statement competing with the
  panel's.
- Every assertion above was disarmed individually — implementing line reverted,
  RED confirmed, restored, GREEN confirmed. One test was found **vacuous** by
  that exercise (it awaited the query function being *called* and then asserted
  the absence of labels, which the empty initial DOM satisfies) and was
  rewritten to settle on the panel's empty state first.
