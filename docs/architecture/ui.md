---
title: Admin UI
applies-to:
  - packages/addon-admin-ui/src/lib/capability-presence.ts
  - packages/addon-admin-ui/src/lib/mount.ts
  - packages/addon-admin-ui/src/lib/settings-field-scope.ts
  - packages/addon-admin-ui/src/lib/step-url-selection.ts
  - packages/addon-admin-ui/src/components/pipeline/step-inspector/StepMatrixFrame.tsx
  - packages/ui-library/src/composites/step-inspector/step-detail-dock.tsx
  - packages/addon-admin-ui/src/lib/viewer-embed.ts
  - packages/addon-admin-ui/src/lib/node-url-selection.ts
  - packages/addon-admin-ui/src/pages/system/Cluster.tsx
  - packages/ui-library/src/composites/node-picker.tsx
  - packages/addon-admin-ui/src/lib/__tests__/mount.spec.ts
  - packages/addon-admin-ui/src/hooks/useNodeUrlSelection.ts
  - packages/addon-admin-ui/src/components/device/tabs/device-export-tab.ts
  - packages/addon-admin-ui/src/components/device/hero/HeroRegistry.tsx
  - packages/addon-admin-ui/src/components/device/hero/__tests__/HeroRegistry.spec.tsx
  - packages/addon-admin-ui/src/components/detection-intelligence/media-provenance.ts
  - packages/addon-admin-ui/src/components/detection-intelligence/track-subject.ts
  - packages/addon-admin-ui/src/components/recordings/storage-fill.ts
  - packages/addon-admin-ui/src/components/users/UserAccessModal.tsx
  - packages/addon-admin-ui/src/components/users/user-role-model.ts
  - packages/addon-admin-ui/src/components/users/RolePreview.tsx
  - packages/addon-admin-ui/src/components/settings/__tests__/settings-surface-scope.spec.ts
  - packages/ui-library/src/lib/hub-mount.ts
  - packages/ui-library/src/hooks/use-cluster-nodes.ts
  - packages/ui-library/src/index.ts
  - packages/ui-library/src/composites/cap-settings/RecordingSettings.tsx
  - packages/ui-library/src/composites/device-controls/control-registry.tsx
  - packages/ui-library/src/composites/device-item/__tests__/action-registry.test.tsx
  - packages/ui-library/src/composites/state-values-stream.tsx
  - packages/ui-library/src/composites/webrtc-diagnostics/session-verdict.ts
  - packages/ui-library/src/composites/webrtc-diagnostics/ice-candidates.ts
  - packages/ui-library/src/composites/peer-connection-config.ts
  - packages/addon-admin-ui/src/pages/system/NetworkDiagnostics.tsx
  - packages/system/src/builtins/device-manager/device-aggregation-merge.ts
  - packages/system/src/builtins/device-manager/device-aggregation.ts
  - packages/types/src/device/device-control-resolution.ts
  - packages/types/src/interfaces/config-ui.ts
  - packages/types/src/interfaces/recording-config.ts
  - packages/types/src/schemas/access-roles.ts
  - packages/addon-pipeline/src/recorder/band-engine.ts
  - packages/addon-pipeline-orchestrator/src/camera-switch-service.ts
  - packages/addon-pipeline-orchestrator/src/display-palette-provider.ts
  - packages/addon-provider-reolink/src/email-push-schema.ts
  - server/backend/src/api/core/auth.router.ts
  - server/backend/src/api/static/frame-policy.ts
  - server/backend/src/api/static/spa-mount.ts
  - scripts/check-absent-claim-is-answered.ts
  - scripts/check-cap-status-type-imports.ts
  - scripts/check-hub-paths-through-mount.ts
  - scripts/check-switch-successor-surfaces.ts
  - scripts/check-topology-is-a-diagram-not-a-lookup.ts
covers:
  - packages/addon-admin-ui/src/**
  - packages/ui-library/src/**
last-verified: 2026-10-26
---

# Admin UI

React + Vite + Tailwind, shipped as an addon (`packages/addon-admin-ui`). Shared
composites and hooks live in `packages/ui-library` and are consumed by the Admin
UI, the Agent UI (`packages/addon-agent-ui`) and every addon that ships its own
page (`packages/addon-pipeline-orchestrator`, `packages/addon-model-studio`,
`packages/addon-benchmark`, `packages/addon-auth`,
`packages/addon-post-analysis`).

## The library is host-provided

`@camstack/ui-library` is host-provided, not bundled into addons
([D15](../decisions/adr-0015.md)): two copies would mean two Reacts.

## An addon page's strings: JSON bundles, one helper, the host's language

Every user-visible string of an addon page or widget lives in
`packages/addon-<x>/src/i18n/en.json` + `it.json` (nested keys, the namespace is
the addon id) — never a literal in the `.tsx`. The components read them through
ONE helper, `createAddonI18n(ns, { en, it })` from `@camstack/ui-library`, which
returns a typed `useT()` (keys are checked against `en.json` by the compiler), a
`Trans` for sentences with inline elements, and `translate()` for code outside
React.

- **Why not i18next:** an addon page is a Module Federation remote and i18next
  is not a shared singleton (`addon-admin-ui/vite.config.ts`). The helper lives
  in the host-shared ui-library, so every remote sees one registry.
- **How the language reaches a remote:** the admin sets `<html lang>` from its
  own i18next language (`addon-admin-ui/src/i18n/index.ts`); the helper reads it
  and re-renders on change. A host-less page (the agent dashboard) falls back to
  `navigator.language`, then `en`. A key missing in the active language falls
  back to English.
- **The seam for hub-served bundles:** bundles enter the registry only through
  `registerAddonBundle(ns, lang, tree)`. A future `translations` capability
  (`getBundle({ lang, ns })`) calls that and no call site changes.
- **Plurals** are `key_one` / `key_other` addressed as `key` with `{ count }`;
  sentences are never built from several `t()` calls.
- **Out of scope here:** schema `label:` / `description:` in settings
  definitions and server error messages (separate mechanisms).
- **Guards:** `scripts/__tests__/addon-i18n-parity.spec.ts` (en/it keys,
  placeholders, tags, plural forms, literal keys used) and the census
  `npx tsx scripts/i18n/find-untranslated-admin.ts --addons`.

## Building UI: the rules live in `docs/ui/`

This page is the ARCHITECTURE of the admin UI: how it is mounted, how data
reaches it, where a settings schema lands, and why each surface is shaped the
way it is. The rules for BUILDING a surface — which component, which token,
which page pattern, what not to do — are in [`docs/ui/`](../ui/README.md), and
the workflow that applies them is the `camstack-ui` skill
(`.claude/skills/camstack-ui/SKILL.md`).

| You need | Read |
| --- | --- |
| The rules every UI change follows (library first, viewports, overflow, safe area, copy) | [conventions.md](../ui/conventions.md) |
| What exists: components, tokens, the web ↔ viewer token map | [common-components.md](../ui/common-components.md) |
| Admin-ui / addon-page patterns: addon-page CSS, tables, integration pages, System tabs, tall dialogs | [admin-patterns.md](../ui/admin-patterns.md) |
| The viewer (React Native) kit and its rules | [viewer.md](../ui/viewer.md) |
| "I need X" → the component that does it | [need-x-use-y.md](../ui/need-x-use-y.md) |
| Drift that exists today, and what replaces it | [anti-patterns.md](../ui/anti-patterns.md) |

## The admin UI under a path prefix

The admin UI is not always at the hub's root. The Home Assistant component
frames it through a same-origin relay — `https://<ha>/api/camstack/p/<grant>/…`
→ `https://<hub>:4443/…` — so the browser never has to trust the hub's local
certificate. The relay forwards the path WITHOUT the prefix and names it in
`X-Forwarded-Prefix`; the hub answers a shell that says where it is mounted
([D373](../decisions/adr-0373.md)):

| Layer | Where | What it does |
| --- | --- | --- |
| relay → hub | `X-Forwarded-Prefix: /api/camstack/p/<grant>` on every request | no header = today's behaviour |
| hub | `server/backend/src/api/static/spa-mount.ts` | injects `<base href="<prefix>/">` + `<meta name="camstack-mount">` first in `<head>`; validates the prefix (`/[A-Za-z0-9_\-./]*`, no `..`, no `//`) and ignores anything else; `no-store` + `Vary: X-Forwarded-Prefix` |
| page | `packages/ui-library/src/lib/hub-mount.ts`, re-exported as `packages/addon-admin-ui/src/lib/mount.ts` | the ONE reader: `hubPath()`, `hubOrigin()`, `hubUrl()`, `hubWsUrl()`, `routerBasename()` |
| build | `vite base: './'`, relative `href`s in `index.html` and the manifest | assets resolve through `<base>`; chunks through `import.meta.url` |

Rules that follow, each of which a root-mounted dev session cannot see broken:

- **Never spell a hub route as a literal.** `fetch('/api/x')`,
  `` `/api/addon-assets/${id}` ``, `'/addon/terminal/io'` all ignore `<base>` —
  a root-absolute path is exactly what a base URL does not rewrite — and under
  the relay they land on HA's own `/api`. Write `hubPath('/api/x')`.
- **An addon icon URL comes from the manifest, never from an id.** Ask
  `useAddonIconUrl(addonId)` (`contexts/addon-icons-context.tsx`): it answers
  only for an addon whose manifest declares `icon`, and `null` means draw the
  glyph with no request. Building `/api/addon-assets/<id>/assets/icon.svg` by
  hand — or prefixing `provider-` to an id — is how `core-blocks`,
  `camera-grid`, `terminal` and `pipeline-analytics` devices 404'd.
- **`hubOrigin()` is the server base, never `window.location.origin`.** The
  page origin is the RELAY's. The SDK (`serverUrl`), the stream players and
  the health probe append `/trpc`, `/api/webrtc`, `/health`, `/adaptive-probe`
  to whatever base they are given, so the base must carry the prefix — and a
  resolved base KEEPS its path (`resolveProbeOrigin`).
- **A server-stamped URL is hub-root-relative.** `bundleUrl` from the widget /
  page aggregators, a `next` from the login bounce, a viewer `redirect` path:
  the reader re-mounts it (`hubPath` passes an already-mounted or absolute
  value through unchanged).
- **The shell's own static root is a hub path too.** `/brand/*`, `/icons/*`,
  `/favicon.svg`, `/manifest.webmanifest` look inert and are the ones that
  hid: with every route prefix already wrapped, a prefixed browser run still
  put six `/brand/logo-horizontal-dark.svg` requests on the HA origin. A
  relative `brand/…` is not the fix — at the root mount it resolves against
  `/devices/5/`. Use `hubPath`.
- **A router pattern is not a URL.** `<Route path="/addon/:pagePath">` and a
  `page.path === '/addon/…'` compare keep their literal and say so:
  `// hub-path-ok: <reason>`.

`scripts/check-hub-paths-through-mount.ts` (CI) is the guard. `mount.spec.ts`
pins that at the root nothing changed, byte for byte.

What is NOT covered: the backend part travels with `@camstack/server`, so a
`camstack deploy packages/addon-admin-ui` alone ships a relative build that
works at the root but is not injected until a server carrying `spa-mount.ts`
is published and applied; server-side redirects other than the login bounce
(`/api/oauth2/authorize`, `/viewer` → `/viewer/camstack/`) still send
root-absolute `Location`s; and the viewer app under `/viewer/camstack/` has
its own base and is unchanged.

### Who may frame the hub, and how the viewer is framed

Every HTML document the hub serves carries `Content-Security-Policy:
frame-ancestors 'self'` (`server/backend/src/api/static/frame-policy.ts`, one
`onSend` hook on the one Fastify instance —
[D425](../decisions/adr-0425-the-hub-is-framed-only-by-its-own-origin-and-a-foreign-host-reaches-it-through-a-same-origin-relay.md)).
Same-origin is the only shape the hub is framed in, and it is enough for every
real embed, because a foreign host relays the hub under its own origin:

| Who frames what | Origin the browser sees | Why it is allowed |
| --- | --- | --- |
| admin UI → viewer, at `/live` | the hub's | same document origin |
| HA sidebar panel → admin UI | Home Assistant's, via `/api/camstack/p/<grant>/` | the relay forwards the header; `'self'` is evaluated against the relay's origin |
| HA grid / events card → the viewer's embed | Home Assistant's, same relay | same |
| desktop shell, native WebView, share link | top-level | no ancestor, policy does not apply |

A direct cross-origin frame — the hub's URL pasted into a Home Assistant
"Webpage" dashboard — is refused by that policy. It never worked: the session
cookie is `SameSite=Lax` and does not travel into a cross-site frame, so the
page loaded and then failed on every cookie-gated request. The one way to make
it work is `SameSite=None`, which was rejected.

**The admin UI frames the viewer at the ROOT mount only.** `/live` (not
`/viewer`, which is the hub's own redirect and is excluded from the SPA
fallback) renders an `<iframe src={hubPath('/viewer/camstack/')}>` with
`allow="autoplay; fullscreen; microphone; picture-in-picture"`; the cookie the
auth context re-establishes on boot signs the viewer in through its own
`auth.exchangeSession`. Under a mount prefix `lib/viewer-embed.ts` refuses to
frame and the page says why: the viewer is an Expo export whose base path is
baked in at build time (`expo-router` strips a fixed `/viewer/camstack` off the
pathname, the shell references `/viewer/camstack/_expo/…` root-absolute, and
the session bootstrap uses the serving ORIGIN as `serverUrl`), so through the
relay it is a page of 404s on Home Assistant's origin. Making the viewer
mount-aware — its own `hub-mount.ts`, a relative shell, `serverUrl` from the
mount — is viewer-repository work; when it lands, `planViewerEmbed` is the one
branch to flip.

**Home Assistant, concretely (component 0.5.12+, HACS):**

1. *Admin UI* — the integration's sidebar panel, on by default (Settings →
   Devices & services → CamStack → Configure → "Show sidebar panel"). It is
   relayed; there is nothing to paste. A dashboard link to it is a `button`
   card with `tap_action: {action: navigate, navigation_path: /camstack}`.
2. *Viewer* — the hub's own address, opened in a NEW TAB (top-level, so the
   cookie jar and the certificate exception behave as in the desktop shell):
   a `button` card with
   `tap_action: {action: url, url_path: https://<hub>:4443/viewer/camstack/}`.
   A live wall or an events reel INSIDE a dashboard is the `camstack-grid-card`
   / `camstack-events-card` the component registers, which frame the viewer's
   embed through the relay under a device-scoped share token.

None of the Home Assistant behaviour above was driven in a Home Assistant
instance during this change; it is read from the component's source
(`proxy.py`, `frontend/__init__.py`, `camstack-panel.js`) and from the CSP
specification's definition of `'self'`.

## The hub serves the viewer and admin bundles from a lazy resolution ([D876](../decisions/adr-0876-the-hub-serves-the-viewer-and-admin-ui-from-a-lazy-single-flight-resolution-that-follows-the-provider.md))

`/viewer/*` and the admin SPA catch-all ask `createLazyUiServing`
(`server/backend/src/ui-serving/lazy-ui-serving.ts`) for the served directory on
every request. Nothing served yet: one single-flight attempt (at most one per 2 s),
503 only if it finds no hub-scoped provider. Served: a changed provider identity or
a missing index re-resolves, so an addon update moves the directory. There is no
boot-window poll to outlast; a provider may register at any time.

## Data flow

Capability data reaches the UI through generated tRPC hooks. Prefer event-driven
over polling: the Cluster page reads topology from the `cluster.topology-snapshot`
event and treats the initial query purely as a bootstrap (`staleTime: Infinity`,
never refetched once the first event lands).

`CapStatusTypeMap` (generated) gives client-side narrowing per capability. Import
capability schemas as `import type` — `scripts/check-cap-status-type-imports.ts`
fails the build on a value import, because that would pull a Zod schema into the
client bundle.

### An unanswered query is not an empty answer

A panel gated on a component being installed has THREE things to say and a
`boolean` holds two. `(query.data ?? []).some(…)` drops the third: the
unanswered query becomes the empty answer and the surface states, in words, that
something is *not installed* while it is installed and running. That shipped, and
an operator spent ten seconds being told a healthy addon was missing
([D315](../decisions/adr-0315-not-yet-known-never-looks-like-not-installed-and-a-presence-gate-asks-the-registry.md)).

So: ask through `useCapabilityPresence`. The one implementation lives in
`packages/ui-library/src/hooks/use-capability-presence.ts` — it moved there when
a LIBRARY widget needed the same gate (`host/clips-browser`, mounted by the
framework from a cap's own `deviceConfig.ui`), and re-implementing it on that
side would have been the second answer D315 is about;
`packages/addon-admin-ui/src/lib/capability-presence.ts` is a re-export kept
because every admin-UI caller and test already spells that path. It answers
`pending | present | absent | unknown` and makes each one a render you have to
write. And ask the **capability registry** — `capabilities.getCapability`, one
capability by name, 0.15 s — not `nodes.topology`, which answers "draw me the
cluster" and costs accordingly.

### How a UI reads the cluster: two hooks, and neither polls

`nodes.topology` is the cluster DIAGRAM — every node, every addon, every runner
subprocess with its live cpu/rss, plus the durable offline rows. Its handler
walks the fleet. Measured on the production hub on 2026-08-31 with each leg
isolated against its own endpoint: the hub `$process.list` **plus** its forked
`ps` is **92 ms**, one `$agent.status` is **0.2 s**, and **one settings-store
round trip is 15 s** — the store stalls and releases everything in flight
together, so the call cost exactly two of those ticks, **30.5 s**
([D317](../decisions/adr-0317-a-durable-capture-belongs-to-the-periodic-pass-and-the-cluster-diagram-is-not-a-lookup-table.md)).

Both readers live in `packages/ui-library/src/hooks/use-cluster-nodes.ts` and
have the same shape — **bootstrap once, then live off the pushed
`cluster.topology-snapshot`**, which the hub emits every 30 s and, debounced
200 ms, on every agent/addon lifecycle edge. A subscriber that mounts mid-stream
gets its first value from the bootstrap query; that is what the query is for.

| you need | hook |
| --- | --- |
| per-node processes, per-addon health, the balancer graph | `useClusterTopology` |
| a node list, a node's name, whether a node is up, a node's addon caps | `useClusterNodes` |
| ONE node's addons with versions | `nodes.getNodeAddons` — one node, no fan-out, 34 ms |

`scripts/check-topology-is-a-diagram-not-a-lookup.ts` keeps every other call
site out of it, refuses `refetchOnMount` / `staleTime` at a call site, and
refuses a finite `staleTime` in the hook itself.
`scripts/check-absent-claim-is-answered.ts` is the guard.

## Where a settings schema is allowed to appear, and the key that decides it

Every configuration surface in the admin UI is the same payload — a
`ConfigUISchema` (`packages/types/src/interfaces/config-ui.ts`): `{ tabs?,
sections[] }`, each section `{ id, title, tab?, location?, order?, columns?,
fields[] }`. What changes between surfaces is **who is asked for it** and
**which keys the renderer reads**. Nothing about placement is inferred from the
addon's name, its category, or what its fields happen to contain.

### The three levels

| Level | Who asks | What the addon implements | Where it lands |
| --- | --- | --- | --- |
| Addon settings page | `addonSettings.getGlobalSettings({addonId})` | `globalSettingsSchema()` on `BaseAddon` | the addon's own card under Integrations / Addons — and any page that mounts `NodeAddonsSettingsPanel` for it (Terminal, Cluster → Settings, Local access, an integration's page). The host re-declares nothing; the schema still comes from the addon. |
| Device **Settings** panel | `deviceManager.getDeviceSettingsAggregate({deviceId})` | `getDeviceSettingsContribution(deviceId)`, or a derived `deviceConfig` cap | the device page's **Config** tab, in the sub-tab named by `section.tab` |
| Device **top-level tab** | the same aggregate | the same contribution, plus `location: 'top-tab'` | its own tab in the device header strip, sibling of Overview / Config |

The addon-settings page and the device page do NOT share a schema. An addon can
contribute to both; they are two separate methods with two separate payloads.

### Which key controls which

- **`section.tab`** — the SUB-tab inside whichever surface renders the section.
  Defaults to `'general'`. On the device page it is the inner tab bar of the
  Config tab. A tab id nobody declares is still rendered: `mergeAggregates`
  (`packages/system/src/builtins/device-manager/device-aggregation-merge.ts`)
  auto-derives a declaration from `WELL_KNOWN_TAB_MAP`, falling back to the raw
  id as the label — a missing declaration surfaces as an ugly label rather than
  a missing tab.
- **`section.location`** — `'settings'` (default), `'top-tab'` or
  `'hero'`. `'top-tab'` is the ONLY declarative way to become a
  top-level device tab: `DeviceDetail` scans the aggregate for
  `location === 'top-tab'` sections and turns each distinct `tab` id into a
  header tab. `'hero'` shows the section's widget ONCE directly under the
  device's hero card, in the same slot, on every tab
  (`components/device/hero/DeviceHeroWidgets.tsx`, [D915](../decisions/adr-0915-consumables-are-one-collapsible-section-under-the-device-hero.md));
  a container also shows its primary child's hero widgets, rendered against
  the child. Such a widget brings its own collapse: the Consumables panel opens
  itself while an item needs attention and remembers the viewer's toggle per
  device. `toWireShape` must forward the location — it is an explicit copy,
  and dropping it there strips the marker before the client ever sees it.
- **`section.order`** — sort within the tab, lower first. **`tabs[].order`** —
  sort within the tab bar, lower to the left.
- **`section.columns`** — 1–4 column grid for the section's fields.
- **`tabs[]` (`ConfigTabDeclaration`)** — `{ id, label, icon, order? }`. Only
  needed to give a NON-well-known tab a human label and icon. Well-known ids
  take their label/icon from `WELL_KNOWN_TABS` and ignore what you declare.

For a cap-derived UI the same placement is expressed on the cap instead:
`deviceConfig.ui.topTab` is what `device-aggregation.ts` turns into
`location: 'top-tab'`, and `deviceConfig.ui.placement: 'hero'` into
`location: 'hero'` (the `consumables` cap). It is the cap-side spelling
of the same key, not a second mechanism.

### Every surface renders ONE store scope, and says which

Placement decides which page a field appears on. It decides nothing about where
the value is STORED, and conflating the two is the defect this area keeps
producing. `perNode: true` (`ConfigFieldBase.perNode`) is the only thing that
scopes a key to `<key>@<nodeId>`; without it the value is one blob for the whole
cluster and the `nodeId` the UI passes is discarded by
`BaseAddon.updateGlobalSettings`. A surface therefore has exactly one honest
population, and `NodeAddonsSettingsPanel` takes it as `fieldScope`:

- `perNode` for a page drawn under a node's name (Cluster → node → Settings);
- `cluster` for a page with no node behind it (the Addons card, System →
  Settings).

Rendering both is how the same label came to write two different keys from two
places, with both showing a value
([D266](../decisions/adr-0271-a-settings-surface-renders-one-store-scope-and-says-which.md)).
`filterSchemaByFieldScope` (`packages/addon-admin-ui/src/lib/settings-field-scope.ts`)
does the narrowing; `settings-surface-scope.spec.ts` is the guard.

### Integration-level settings

An addon may declare that some of its global sections ARE the configuration of
its **integration**, so an operator hunting "the Reolink SMTP port" finds it
under System → Integrations → Reolink instead of only in the cluster-wide list
of every addon. It is opt-in and the declaration lives in core:

```ts
protected override integrationSettingSections(): readonly string[] {
  return ['email-push', 'email-push-auth']   // ids from globalSettingsSchema()
}
```

`BaseAddon.getIntegrationSettings()` then serves exactly those sections, and
`addonSettings.getIntegrationSettings` carries them to the UI. Declaring nothing
returns `null` and no surface is offered.
`packages/addon-provider-reolink/src/email-push-schema.ts` is the reference
consumer, and the only one.

### One form per integration instance

An addon whose instances differ in kind (Reolink: the default integration versus an
NVR / Home Hub) overrides `BaseAddon.integrationSettingsSchema(instance)` and returns
the schema for that instance, or `null` for its global schema. `instance` is an
`IntegrationInstanceRef` (`integrationId`, `null` in the create wizard, plus `mode`
and an optional `candidateStableId`). `addonSettings.getIntegrationFormSchema` serves
it, and falls back to `getGlobalSettings` for an addon without the hook; the wizard,
the edit page and the config modal all read through it. Values still come from
`integrations.getSettings`. Extending `getGlobalSettings` with an instance argument was
rejected: it would have touched the four hops that serve the cluster-wide settings tab.

This is a second **page**, never a second **scope**
([D269](../decisions/adr-0278-integration-level-settings-are-declared-in-core-not-borrowed-from-a-tab.md),
superseding D268). The properties that make it safe are all in core, so no UI
can re-decide them: the payload is a SUBSET of `globalSettingsSchema()` hydrated
from the same store (hence the same bare key); there is deliberately **no**
`updateIntegrationSettings`, so the writer is `updateGlobalSettings`; `perNode`
fields are dropped, because an integration is not a node; an unknown section id
throws rather than silently emptying the page. The panel throws on any mount
implying a narrower scope (a `deviceId`, a node id, a competing `fieldScope`),
so a device page cannot host one.

The panel used to render an on-screen paragraph naming that scope
("Integration-wide settings — …"). It was removed on operator request
(2026-09-05): the refusals above already MAKE the scope true, and a sentence
restating what the code enforces is the leftover this repo treats as worse than
nothing. `settings-surface-scope.spec.ts` pins its absence in all three files
that could bring it back.

The sections keep appearing on the addon's own page too — they are declared, not
moved. That page is the complete view of an addon's configuration, and one that
silently omitted settings would be the worse failure.

**Placement is never expressed by borrowing `section.tab`.** D268 did exactly
that, and because `tab` also feeds the settings tab bar the addon's own page
grew a tab labelled "integration". `tab` means "how to group this visually" and
may not also mean "where this lives"; it remains available to group sections
*within* the integration page.

### Derived vs hand-written — pick by what owns the values

- **Derived (`deviceConfig` cap).** The cap declares its settings schema and
  the framework generates the whole panel. If a cap has `deviceConfig`, you MUST
  NOT hand-write `getDeviceSettingsContribution` /
  `getDeviceLiveContribution` / `applyDeviceSettingsPatch` for it
  ([D14](../decisions/adr-0014.md)) — `deviceConfig` and `exposesDeviceSettings`
  are mutually exclusive on a cap for exactly this reason.
- **Hand-written contribution (`exposesDeviceSettings: true`).** For a cap whose
  per-device surface is not a flat settings record — the exporters are the
  canonical case. `device-export` is `exposesDeviceSettings: true` with no
  `deviceConfig.ui`, so `export-hap`, `export-alexa` and the Home Assistant
  export each build their own section in `getDeviceSettingsContribution`.

### The device page merges TWO sources, and only one of them carries tabs

`deviceManager.getDeviceAggregate` returns `{ settings, live }`. `settings`
comes from every bound provider whose cap declares `exposesDeviceSettings`;
`live` is the read-only runtime half and is forced readonly before merging. The
driver's own schema (`deviceManager.getSettingsSchema`) is a THIRD payload with
its own tab set (`general`, `network`, `streaming`, …) and no `export` tab —
do not expect a section to appear there because it appears in the aggregate.

Sections are concatenated (first writer wins on an id collision), then the
aggregator **tags each editable field** with `writerCapName` + `writerAddonId`
so a save can be routed back to the provider that produced it. Two consequences
that have each cost a bug:

1. **`tagField` deliberately skips structural field types** — `separator`,
   `info` and `button` have no writer, so they carry NO cap metadata. Any client
   rule that identifies a section by probing its fields for a `writerCapName`
   therefore misclassifies a section made only of structural fields. That is
   exactly how the Home Assistant export's "Not configured" placeholder ended up
   under **Config → Export** while Alexa and HomeKit — which have editable
   fields beside their own `info` header — were hoisted into the top-level
   **Export** tab. Placement is read from what the section DECLARES
   (`section.tab`), with the writer tag only as a fallback; see
   `packages/addon-admin-ui/src/components/device/tabs/device-export-tab.ts`,
   whose `isDeviceExportSection` is the single predicate used by all three call
   sites (tab discovery, tab body, and exclusion from Config) so they cannot
   disagree.
2. **Fields are flattened by `key` across every contributing section.** The
   device form is one controller over the merged payload, so a bare `enabled`
   from three different exporters is ONE field and the last writer wins — the
   operator sees another exporter's value in this one's toggle. Namespace every
   key with its owner and its subject: `hap:<deviceId>:enabled`,
   `alexa:<deviceId>:enabled`, `haExport:<deviceId>:<brokerId>`. This is
   restated in `packages/addon-provider-homeassistant/AGENTS.md` because that is
   where it was learned.

**A slow contributor costs the page its budget ONCE, and the panel says what it
is showing.** The fan-out is bounded per provider
(`CONTRIBUTION_BUDGET_MS`, `packages/system/src/builtins/device-manager/contribution-cache.ts`)
and paired with that provider's last answer, because a budget alone makes its
section disappear and come back between polls — and a settings section that
flickers is worse than a slow one. `getDeviceAggregate` was measured at 10 595 ms
on a battery camera against 331 ms on a mains one while the page re-polls every
2 500 ms, so the rules are the ones a poll forces: a read never joins a refresh
already in flight
([D224](../decisions/adr-0224-the-freshness-of-a-camera-fact-lives-in-its-provider.md));
an explicit `null` is an
ANSWER and replaces what was cached, so a provider that has disowned the device
stops being drawn; a failure falls back to the last answer, and a failure with
nothing behind it is ABSENT. Served-stale and absent each log a line naming the
provider — "which contributor is slow" and "is this panel current" had no answer
at all before.

**A tab that has existed once belongs to the operator until they leave it.** The
schema is rebuilt on the same 2.5 s poll, so a slow contributor drops its tab for
a beat; `TabbedSettingsForm` used to read that as "the operator is on a tab that
does not exist" and move them to the first one, which is the page jumping to
shorter content the instant the save banner appeared. It now holds a requested id
it has seen before in this mount and lets the panel go quiet for the beat. The
fallback survives for the case it was written for: an id that has NEVER been in
this schema (a stale URL, a renamed tab) still resolves to the first tab, because
that id is not blinking — it is wrong.

## Settings texts and errors are translated by the hub ([D863](../decisions/adr-0863-settings-texts-and-user-facing-errors-are-translated-by-the-hub-from-catalogs-the-english-text-always-travels-beside-the-key.md))

A schema reaches the admin UI with English `label` / `description` / `title`.
When a field also carries `labelKey` / `descriptionKey` (sections: `titleKey` /
`descriptionKey`) of the form `"<namespace>:<key>"`, the hub swaps the text for
the catalog entry in the request language **before the answer leaves**
(`localizeSchemaOutput`, the outermost middleware of `protectedProcedure`),
and only on the methods listed in
`server/backend/src/api/trpc/localized-schema-paths.ts`. English, an unknown
key, a field without keys and a method not on that list all keep the English
text, so a half-migrated addon is valid and no client changes.

- **Request language**: profile language (none exists yet) > the app's `lang`
  (the SDK's `getLanguage` option: the admin UI passes its i18n language)
  (`x-camstack-lang` header, `lang` query / connection param) > `Accept-Language`
  > `en`; on the context as `ctx.lang` (`server/backend/src/i18n/request-lang.ts`).
- **Catalogs**: flat `key -> text` JSON. Core namespace `server` =
  `packages/system/src/i18n/{en,it}.json` (errors and core labels). An addon
  package ships `<package>/i18n/{en,it}.json` (add `"i18n"` to `files`); its
  namespace is the package short name (`provider-reolink`, `pipeline`,
  `notifiers`, `remote-storage`, ...). Loaded when the addon is registered; a
  file that is not a flat string map is logged and ignored.
- **Errors**: `throw userError('device.not-found', { id }, 'Device 7 not found')`
  (any `Error` site) or `trpcUserError('NOT_FOUND', code, params, english)` (a
  `TRPCError` site). `message` stays the English text; the formatter
  (`cap-route-error-formatter.ts`) replaces it with `server:<code>` in the
  request language and adds `data.i18n = { code, params }`. A legacy error or an
  unknown code is untouched.

### How to migrate an addon's labels and errors (the bulk pass)

One addon at a time:

1. `npx tsx scripts/i18n/census-server-i18n.ts` - pick the package; note its
   numbers.
2. Schema labels: `npx tsx scripts/i18n/add-label-keys.ts --ns <package short
   name> --pkg packages/<package> <files relative to the package...>`. It adds
   the `*Key` properties next to every literal `label` / `description` / `title`
   and writes the English texts to `<pkg>/i18n/en.json`. Dynamic texts
   (template with `${}`) are reported and stay English.
3. Translate every key it prints into `<pkg>/i18n/it.json` (same keys, same
   `{placeholders}`; vocabulary of `packages/addon-admin-ui/src/i18n/it.json`:
   telecamera, dispositivo, registrazione, nome utente). Add `"i18n"` to the
   package's `files` if it is not there.
4. If the schema is served by a cap method not yet in
   `localized-schema-paths.ts`, add it there.
5. Errors: replace `new Error('...')` / `new TRPCError({ message })` that a
   person reads with `userError` / `trpcUserError`, a dotted lower-case code
   (`area.what-happened`), params for every interpolated value, the original
   text as the English fallback; add the code to both `packages/system/src/i18n`
   catalogs. Do not change the English text - callers may match on it.
6. `npx biome format --write <touched files>` (never `check --write`),
   `npx vitest run scripts/i18n` (key parity, references, codes), re-run the
   census: the untranslated number of that package drops, nothing else moves.

## A device hero is decided in THREE places, and two of them are guarded

Adding a control surface for a device type is not one edit, and the failure
mode when it is half done is silent — the device renders "Controls coming
soon" over work that already exists. `DeviceType.AlarmPanel` sat like that for
weeks; `Script` and `Automation` sat like that from the day their caps shipped.

| Layer | File | What it decides |
| --- | --- | --- |
| decision | `packages/types/src/device/device-control-resolution.ts` | `DeviceType` → `DeviceControlKind`. **Single source.** |
| binding | `packages/ui-library/src/composites/device-controls/control-registry.tsx` | kind → `{ InlineControl, HeroCard }`. Exhaustive — a missing kind is a build error. |
| routing | `packages/addon-admin-ui/src/components/device/hero/HeroRegistry.tsx` | `DeviceType` → hero component. `ControlHero` resolves the card from the kind. |

Only the middle one is enforced by the compiler. The other two are enforced by
tests, and both fire the moment a kind stops being `dummy`:

- `packages/addon-admin-ui/src/components/device/hero/__tests__/HeroRegistry.spec.tsx`
  compares the decision map against the routing map and fails with
  `stranded: ['<kind>']`;
- `packages/ui-library/src/composites/device-item/__tests__/action-registry.test.tsx`
  — it lives with the registry, in the LIBRARY, not in the admin UI — asserts the
  *placeholder* list, so a promotion to a real inline control has to be
  acknowledged.

A test failing here after a kind change is the guard working, not a regression.

**Do not claim state the provider never writes.** The HA provider — the only
thing that creates Script and Automation devices — never writes `lastError` or
`lastRunSuccess` on a script, and never writes `isRunning` on an automation;
those fields are carried from the previous slice forever. So the cards render
the error line only when a message exists (a permanent "Last error: —" reads as
"checked, nothing wrong"), and the automation trigger applies no optimistic
`isRunning` patch, because nothing would ever clear it. A `lastRunAt` of **0
means never run** and must never render as 1 Jan 1970.

## A link to the device's OWN page is ONE hook, drawn in two places

The `device-admin-link` cap answers "where is this device's own management
page", and the answer appears twice: as a 12px glyph at the end of the device
row (`AdminLinkQuickAction`, ui-library) and as a bordered pill in the device
detail header (`components/device/DeviceAdminLinkButton.tsx`), between the
camera function switches and the kebab — ahead of the kebab because it OPENS
something rather than hiding choices. Both read the same
`useDeviceAdminLink`; two surfaces deriving the gate separately would sooner or
later disagree about one device, and the operator would be right to believe
whichever one said there was a page.

Four states draw NOTHING, and not one of them renders a disabled button (D62):
the provider never registered the cap, the provider answered `null`, the query
has not answered, or the caller was refused. A page hosted ON the device is
hidden while that device is offline; a page belonging to an INTEGRATION is kept,
which is exactly when the Home Assistant page for a sensor that just dropped is
worth having — that is what `target` on the payload is for. And the anchor
carries `rel="noopener"`, or the opened page keeps a live `window.opener` handle
back into the admin UI.

## Which integration a device belongs to is ONE rule

A device row carries two ids. `integrationId` names the integration that
CREATED it. `addonId` names the addon that SERVES it. They can differ: a
composed device (D659) is created by the "Blocks" integration (addonId
`core-blocks`) and served by `composer`. Every surface that matched a device to
an integration by `addonId` filed "Porch (composto)" under no integration.
That covered the Devices filter and badge, the Integrations count and nested
list, the Integration page's list, the device header, GlobalSearch and the
orphan box.

The rule is `resolveDeviceIntegration` / `deviceIntegrationResolver`
(`packages/ui-library/src/composites/device-list/device-integration.ts`):

- `integrationId`, when present, is matched against `integrations.list` by
  `id`, whatever the `addonId` says.
- `addonId` is used only for legacy rows that carry no `integrationId`.

It answers `resolved | orphan | unlinked | unknown`. `unknown` means the
integrations query has not answered. It is never `orphan` (D315).

`<DeviceList>` takes the resolver as `integrationOf`. Its chip ids and
`forceIntegrationId` are integration ids, never addonIds. An integration filter
over `unknown` rows shows "Loading integrations…", not "no devices match". The
device-detail breadcrumb says "Loading integration…" and draws no integration
logo until that query answers; it never borrows the serving addon's identity.
The row badge is `deviceIntegrationIcon`. Do not add a second
`d.addonId === integration.addonId` anywhere. The "Restart addon" action is the
one place that correctly keeps `addonId`, because it restarts the SERVING addon.

## A device is customized in ONE tab, and the tab stores nothing ([D676](../decisions/adr-0676-the-customization-ui-stores-nothing-and-shows-only-what-the-backend-serves.md))

`?tab=customize` (admin-only, every device type) is the device's view of what it
TAKES from other devices. Order, top to bottom: an identity block (name, room,
type, role, hidden, icon, and — where something draws them — label, unit and
precision), the customization's status (not shown when there is none), one
card per declared `customize` target the device type can take and does not
already serve (scalar, keyed array, pulse, span — battery, running-state,
consumables, doorbell, motion; `apply: 'add'` only, [D944](../decisions/adr-0944-customize-attaches-a-fixed-set-of-extensions-and-everything-else-is-a-built-device.md)),
then the **Linked devices** table. A card is absent when the device provides
that capability natively. Motion stays on a camera through the camera-sensors
authority; its source modes (in-addition, confirm, replace) are that
extension's behaviour. A row is current value, "No override" or the entry, and
"+ Add override" (from a device, formula, and convert unit when the field's
unit has another unit in its dimension). Convert unit and a formula bound to
this device's own value are the old numeric self-transforms; there is no
separate card. Formula and convert unit open a dialog; there is no step wizard
and no free text input. Removing the last card entry deletes the block
(after confirm). A free composition (`addonId === 'composer'`, no `helper`)
uses that same card editor here. A helper opens as its template instead.
`/build/compositions/new` starts with a choice: a blank composition (type,
role, name, room) or a **helper**. A helper is a template, not an expression:
Readings or Binary sensors, one line of what exclusion does, then the reducer
(mean / median / min / max / sum, or any / all), name and room, then members
from the common `SourceSelector` in multi-select, limited to that template's
device type and catalog field. After create the operator lands on the device
page. `/build/compositions/<id>` opens a stored helper as that same template
(`composition.helper`); a free expression (no `helper` key) stays on the card
editor. The helper's device page shows the output reading and "N of M members
reporting" from `group-status`, and names the members left out. A save the
server refuses (`mixed-quantity` and the other named codes) is shown with
that reason. Hrefs come only from `lib/customization-routes.ts`.

- **Extension dialogs share one source selector (D944 §5).** Battery, motion,
  doorbell, running, consumables and formula bindings pick a device and value
  through `SourceSelector`
  (`components/device/customize/source-selector/SourceSelector.tsx`): the left
  column is the ui-library `DevicePicker` (scrolls inside the column,
  `parentDeviceId` for “in &lt;parent&gt;”, incompatible devices collapsed);
  the right column offers a value radio only when the declaration needs a field
  (a scalar such as battery percentage or watts). An event extension (motion
  span, doorbell pulse) binds the device's declared on/off
  (`SOURCE_CAP_ACTIVE_FIELD`: binary/switch `on`, motion `detected`, …) and
  shows that field read-only with its current value — never reachability,
  never another capability's internal flag — then the behaviour parameters. Assignment linked-devices may still use
  `CustomizeDevicePickerDialog` or `AssignmentFieldPicker` (device then field
  via `sourceFor`). The notification smart picker (D636) stays a selection
  editor only — no live value or field step. Candidate reads stay bounded: one
  slim `listAll` and one `listDeviceIdsByCaps` per source cap, never
  `getBindings` per candidate (D648).
- **Extension cards save at once, through the authority that already owns them**
  — the device's ONE composition (`planCustomizationSave`: create / update with
  `expectedUpdatedAt` / delete), `pipelineOrchestrator.setCameraSensors`, or
  `deviceExtension.setSlot`. Identity and the display override do not: name,
  room, role, hidden, icon, label, unit and precision wait for the one Save
  the quick-detail modal already uses (`QuickDetailSaveProvider`). Overview's
  Device info is read-only facts (id, stable id, provider, integration, parent,
  capabilities, hardware); it has no per-field save, and the Overview Display
  section is gone. An extension-card write is held until
  its refetch lands and a concurrent one is refused by name
  (`customize.saveInFlight`). A refusal is shown on the card by name; removing a
  row asks first, and says so when it empties the customization.
- **A card is rendered only when its declaration applies**, never
  disabled. `assignment-availability.ts` reads the catalog target (`apply`,
  `nativeItems`, `applyAuthority`) — there is no per-cap branch — and its
  availability is one answered state: `pending` ("Checking…", never absence),
  `unknown` (the reason), `absent` (no card), `present` (D315).
- **A row's live value is four-state** (`assignments/live-value.ts`): `pending`,
  `unknown` (the read failed, the reason in the title), `absent` (the slice
  answered and does not carry the field) and `value`. The first answer is a
  `deviceState.getCapSlice` read; later changes are the pushed slice. A battery
  slice with `binary: true` shows the badge's Normal / Low labels, the same
  strings as `BatteryBadge`, never a stand-in percentage.
- **Behaviour parameters come from the catalog** ([D944](../decisions/adr-0944-customize-attaches-a-fixed-set-of-extensions-and-everything-else-is-a-built-device.md)).
  The editor does not keep a second default: a threshold's comparison, value
  and dwell, a linear scale's offset and clamp, a pulse's edges and debounce,
  and a span's modes and timeout are the declaration, projected into
  `CAP_CUSTOMIZE_CATALOG`. A new pulse can name several sources. A span shows
  each source's mode, with one line of what that mode means, on the row from
  the first source.
- **Motion is the span card** (D673): the first row is the camera's own
  motion — "always included", "only when confirmed" or "replaced", from the
  status's `cameraMotion`, with its LIVE raw level from `cameraLevel` (the
  camera's `motion` slice is the effective value now, D696) — then one row per
  sensor. Each sensor row carries its mode (In addition / Confirm / Replace)
  and one line of what that mode means, including the first sensor. Modes are
  offered only against an orchestrator that carries `cameraMotion`; nothing is
  editable until the stored list was READ. `notForwarded` and `notEnforced`
  are warnings: a camera that cannot enforce a mode says so instead of looking
  suppressed.
- **Linked devices** is a `<DeviceList mode="generic">` (the same table, search
  and type filter as the collection pages); "Controls with the camera" is read-only
  text (there is no per-device backend switch), "Tracked events" writes
  `trackedDeviceIds`. A device the owner links by structure is listed and cannot
  be removed. A camera links only what the operator picked (D356).
- **Every picker suggests the device's room, and assigns nothing on its own**
  ([D749](../decisions/adr-0749-a-room-suggests-a-container-by-the-child-it-stands-for.md)).
  A card that can add shows "N suggested · <room>" in its header, which opens
  its picker; the picker starts with a "Suggested · <room>" group whose Add (or
  Use, in the device → field picker) is the picker's own pick, "Add all" when
  several fit. The suggestions are `sameLocationSuggestions` (ui-library, the
  same rule as the `device-multiselect` field) intersected with the card's own
  candidates: a container is never suggested, only the child it stands for
  (its stored pick, else the automatic one), named after it; its other
  children stay in the list. `assignments/room-suggestions.ts`.
- Type is read-only in the identity block. Name, room, role, hidden and the
  display override are edited there and written by that one Save.
  Numeric publish-as-unit and a script over the device's own value are override
  entries on that field's row, not a second card.
- **The tab is drawn at the device page's density, from the library.** Every
  card is `CustomizeCard` (`SECTION_CARD` + `SECTION_HEADER` +
  `TEXT_SECTION_LABEL`, the Overview's section chrome); a row is `LIST_ROW` with
  `text-xs` and a `sm` `IconButton` for ✕; selects, inputs and checkboxes are
  the library's `Select` / `Input` / `Checkbox`. The tab had drifted to `text-sm`
  rows, 44 px ✕ buttons and `h-11` native selects — about twice the height of
  the Bindings table beside it (operator report, 2026-10-07).
- No explanation paragraph and no decision id reaches the operator in this
  namespace: `customize-i18n.spec.ts` guards en/it parity and the second.
- The preview is `evaluateCompositionField`, the composer's own function; `rose` /
  `count` are the composer's to evaluate.

## Training Frames (`/addon/training`): correcting a frame

Curation lives on the Training addon MF page (`packages/addon-training/src/page/`),
**Frames** tab — not a Library tab and not `pages/Retrain.tsx` (removed;
`/retrain` redirects here). Architecture of jobs / providers / live selection:
[cloud-training.md](./cloud-training.md). Library and the viewer only enqueue
(mark a track or send a recording still).

Frame editor state is one pure reducer,
`page/frames/lib/retrain-editor.ts`, so what reaches `saveRetrainAnnotations`
is decided in tested code, not in the overlay component.

- **Corpus grid + overlay.** KPI, collections, work-state / camera / class
  filters and a paginated thumbnail grid; click opens
  `CorpusAnnotateOverlay` → `RetrainWorkbench`, which addresses a frame by
  the frame alone — its `deviceId`, its `trackId` when it has one — so a
  recording still with no track is annotated like a track copy, and assist
  resolves the detector of the open frame's camera
  ([D793](../decisions/adr-0793-a-recording-still-is-a-trackless-retrain-frame-and-a-collection-is-a-set-over-the-corpus.md)).
- **Annotation kinds.** `subject` (teach a class) vs `model_error` (false
  positive — **no** “NOT person” label; YOLO learns background by omission).
  Complete + zero subjects = hard negative. Full rules:
  [cloud-training.md § Corpus](./cloud-training.md).
- **Send frame to training.** The camera's recording timeline (ui-library
  `RecordingTimeline`) carries `SendFrameToTrainingButton`: freezes the
  playhead when the dialog opens, offers `TrainingCollectionPicker`, calls
  `addRetrainFrameFromRecording`; each named refusal has a sentence
  (`trainingRefusalText`).
- **Export.** Frames-tab export narrows the annotated archive by the current
  filters (collections / work state). There is **no** freeze / dataset-version
  UI (D824).
- **Assist panel** (`RetrainAssistPanel.tsx`): larger detector / AI vision /
  both; drafts only; cloud profiles confirm destination
  ([D795](../decisions/adr-0795-a-retrain-frame-leaves-the-house-for-ai-vision-only-on-a-confirmed-run.md)).
- **Drafts.** Server annotations (confirmed) plus pipeline boxes as drafts;
  machine proposals stay dashed until accepted
  ([D790](../decisions/adr-0790-a-machine-proposed-retrain-box-is-a-draft-until-the-operator-confirms-it.md)).
  A `model_error` is always dashed `--color-danger`.
- **Re-seed / edit / zoom / undo / keyboard.** Same contracts as before under
  `page/frames/lib/retrain-{boxes,zoom,history,shortcuts}.ts` and the
  `use-retrain-*` hooks: re-seed on frame or stored-annotation change only;
  E = model error, C = complete, A = accept draft.

## One fleet strip: `NodePicker`, with props for the Nodes page

`NodePicker` (`packages/ui-library/src/composites/node-picker.tsx`) is the
cluster node pill bar for Addons, Terminal, the AI profile editor, the Build
block editor, both storage location dialogs, `addon-benchmark`,
`addon-model-studio`, and the Nodes page (`pages/system/Cluster.tsx`). Offline
nodes stay listed; they are **disabled by default** (query targets must name a
reachable node). Nodes passes `allowOffline` so a dead agent stays selectable,
and `alwaysShow` so a single-node cluster still gets the strip as a layout
anchor. The page mounts `NodeCard` under the picker — the picker itself renders
nothing below the pills.

| | Default (`NodePicker`) | Nodes (`Cluster.tsx`) |
| --- | --- | --- |
| an OFFLINE node | disabled | `allowOffline` — selectable |
| what a pill shows | short name (+ offline title) | same |
| what sits below | nothing (caller decides) | the node's `NodeCard` |
| single-node cluster | hidden | `alwaysShow` |

Where the selection lives is shared:
`lib/node-url-selection.ts` — the `?node=` spelling, the hub-first /
online-before-offline ordering, and the verdict for an id that names nothing.
`hooks/useNodeUrlSelection.ts` is the router binding (`replace: true`, other
params preserved). See also
[D305](../decisions/adr-0305-a-notification-action-names-the-page-that-can-act-and-the-target-parses-what-it-is-given.md)
for why a notification tap must land on a page that parses `?node=`.

**A `?node=` that names nothing falls back AND says so.** Both pages render
`StaleNodeNotice`. The fallback itself is right — an empty page for an id nobody
can select away from is worse — but a silent one is not, now that a
`*-update-available` notification links straight into these pages with a node
embedded and those rows live for days. Neither page claims "stale" before the
topology has arrived: with no fleet, unknown is the truth, not "gone".

**Uninstall on the Addons page acts on the node it is scoped to.** A card's
Uninstall sends `nodeId` for an agent (no `nodeId` for the hub), and
"Everywhere (N)" re-reads `addons.listInstallations` at click time and names
every holder in the confirm before `uninstallPackage({ everywhere: true })`.
Both report each node's outcome in an alert — a refusal or a failure on one
node is never folded into a success (`AddonUninstallControls`, D766). The card
list is the HUB's packages, so an agent copy the hub does not install was
invisible; `NodeOnlyPackagesPanel` lists those (for the selected agent, or every
agent from the hub view) and renders nothing until the installations query has
answered.

**`?capability=<cap>` offers what is NOT installed yet (D860).** Every "add an
addon for X" button links `addonCatalogHref(cap)`. The page shows two groups:
"Installed" (the filter applied to `addons.list`) and "Available to install"
(`CapabilityCatalog`: `addons.searchAvailable({ capability })`, the npm packages
whose published manifest declares the cap, with the page's Install action). The
search reads each package's `/latest` `camstack.addons[].capabilities` — a
package whose lookup failed has `capabilities: null` and is not offered. A query
that has not answered is "searching", a failed one "could not search", and only
an answered empty one says nothing declares the cap. A cap with no installable
provider gets no install button (`scripts/check-addon-install-links.ts`).

The Addons page also stopped building its own node list. It polled
`nodes.topology` every 10 s while the picker beside it rendered
`useClusterNodes` — two lists on one page, and a selection resolved against the
one the operator was not looking at.

## Events and Debug pages: field-learned facts

**The Events page lists TRACKS, and the name is the only thing that says
otherwise.** `EventsSection` → `useKeyEventsFeed` → `pipelineAnalytics.getKeyEvents`,
which queries `trackStore.queryHistorical` and returns **one row per completed
track**, mapped to that track's best event (`rankKeyEvents`). A row's `id` is a
representative `bestEventId`; selection and delete are keyed
`${deviceId}:${trackId}` because `trackId` is a per-device counter. So a subject
appears once, not once per detection — do not "fix" it into a track list, it
already is one. The one exception is `SemanticEventSearch`, which REPLACES the
feed with `searchObjectEvents` hits and is event-level on purpose (a text search
over object events). `KeyEventRow` extends the generated `KeyEvent` rather than
restating it, so a field added to the cap reaches the grid.

**There is ONE track card and ONE track detail panel, and they take a
STRUCTURAL subject.** `EventCard` and `EventDetailPanel` were typed on
`KeyEventRow` — the events feed's own row — so only the feed could open them.
Events → Debug therefore grew a parallel text-only list of the same subjects,
and the two screens diverged into "the one with pictures" and "the one with
grey lines"; an operator asking *why is this track wrong* had to go and find the
same track on the other screen to look at it. Both components now take
`TrackSubject`
(`packages/addon-admin-ui/src/components/detection-intelligence/track-subject.ts`)
— the intersection of what they actually read — which `KeyEventRow` satisfies
structurally, so the feed needed no adapter and the Debug tab needed no card.

Two rules that keep this from decaying back:

- **A field is added to `TrackSubject` when a component starts reading it,
  never speculatively.** A structural type claiming more than its consumers read
  is a contract nobody checks.
- **A surface that wants extra chrome extends the card with a PROP**
  (`provenance`, `footer`); it does not fork it. Debug's findings strip is a
  `footer`, and that is the whole of its card-level difference from the feed.

**A stand-in best shot is badged as one, and the close says why**
([D276](../decisions/adr-0276-a-stand-in-tile-is-provisional-and-a-close-says-why.md)).
The vocabulary is one module —
`packages/addon-admin-ui/src/components/detection-intelligence/media-provenance.ts`
— holding two rules that are silent when broken:

- **`native` and "we were never told" render NOTHING.** A row written before the
  provenance column ranks `native` *because* it cannot be classified, so a badge
  there turns "we cannot tell" into an accusation across the entire pre-column
  history. `provenanceBadge` returns `null` for both.
- **The raw token line is kept beside the sentence.** `previewMissReason` is the
  string an operator greps the hub log for; paraphrasing it away makes the screen
  and the log impossible to correlate.

Where each half may appear is decided by which schema carries it, not by taste.
`previewMissReason` is on `TrackSchema` and NOT on `KeyEventSchema`, so the
events **grid** cannot show it and the **detail panel** — which already fetches
the whole track for the trajectory — can, at no extra read. The tile
`provenance` is store-internal and on no cap output at all, which is why it
reaches a screen only through the Debug tab's `debug.analyze` custom action.

**The Debug tab's two `addons.custom` actions are its defining property, and
adding to them is not a release train.** `debug.listTracks` / `debug.analyze`
ship with one `camstack deploy` of `pipeline-analytics`; a cap method would need
codegen, a `@camstack/system` publish and a release. Everything the 2026-08-28
rework added — the subject fields the shared card needs, the tile provenance,
the miss reason — went onto those two actions, and the bulk actions write the
`setTrackFlags` cap method that already existed. A change to this tab that seems
to need a NEW cap method is the signal to stop and reconsider, not to add one.

**"Closing" a debug is un-marking it, and the word is `Analyzed`.** The action
is `setTrackFlags({ debug: false })`: the row leaves the list, the debug export
stops carrying it, nothing new is stored, and re-marking is one click. The
viewer's track detail has shipped an `Analyzed` toggle doing exactly this write
(`camstack/src/components/events/track/TrackFlagButtons.tsx`), so the two clients
name one action the same way. A "dismissed but still marked" triage state was
rejected: it needs a store nobody has, and it would leave the export shipping the
tracks the operator has finished with — the thing the action exists to stop. The
viewer additionally remembers `reviewed` client-side because its feed is MIXED
and the debug chip must stay hidden there; the admin tab lists only marked
tracks, so an un-marked one simply leaves, and reversibility is a session-scoped
"Undo" strip rather than durable state.

**A debug mark does not pin, so `Keep` is the other bulk action.** The tab's own
honesty note says the evidence can be evicted mid-investigation;
`setTrackFlags({ favourited: true })` is the only thing on the page that stops
it. Bulk **delete** was deliberately NOT offered here: a triage list is where an
operator decides what to look at, and a destructive action one click from a
"select all" is how evidence disappears mid-investigation. Delete stays on the
Events feed and in the detail panel, behind the track the operator is reading.

**A one-shot seed race can look like missing data.** In
`state-values-stream.tsx`, snapshot-seeded capability slices are marked
`placeholder: true` and are replaced by live values; a live value is never replaced
by a placeholder. Before that, a one-shot seed guard let placeholders win and the
State panel rendered every field as `null` — while the same data displayed fine
elsewhere in the app. When a panel is empty and the rest of the app is not, suspect
the panel.

## A per-camera function is switched in ONE group, on both clients

The invariant has never moved, and it is [D62](../decisions/adr-0062.md)'s: **a
per-camera function switch stores NOTHING and writes the authority that already
owns it.** What moved twice is where the operator flips it.

[D113](../decisions/adr-0113.md) withdrew `CameraSwitchGroup` in August 2026 —
the panel, not the rule — on the argument that every function already had a
settings page of its own. Thirteen months later that prediction was inverted in
the code: the viewer had never left the group, and the admin UI had grown a
hand-written list of FOUR ids, so `privacy-mask`, `device-audio`,
`broker-audio`, `stream-broker` and `notifications` had no representation on the
device header at all. Two surfaces that disagreed about which functions exist,
which is the D62 defect one level up. The operator found it by looking for the
mask control and not finding it.

So [D544](../decisions/adr-0544-the-switch-group-is-the-one-surface-on-both-clients.md)
reinstated the group as THE surface and cancelled D113's phase 4:
`pipelineOrchestrator.getCameraSwitches` / `setCameraSwitch` are the composed
read and the composed write, no longer deprecated, and device details renders
them as ONE multi-select (`CameraFunctionSwitches`, rows from
`camera-switch-rows.ts`) rather than a row of pills whose membership was a local
decision. **Neither client keeps a catalog**: labels, cost lines, availability
and order travel on the wire, so a switch the hub gains tomorrow renders
tomorrow on a client released today. Icons are decoration matched on the LABEL —
an id-keyed icon map is a catalog through the side door, and both clients guard
against one.

The per-function pages D113's phase 3 built are NOT removed: the group is where
a function is flipped, those pages are where it is configured. Each function's
authority is unchanged, and it is the authority a write goes to:

| Function | Authority written | Where it is configured |
| --- | --- | --- |
| `stream-broker` | `deviceManager.setDisabled` | the device list's own disable |
| `object-detection` · `audio-analysis` | `deviceManager.setWrapperActive` | the device's detection / audio settings |
| `recording` | `recordingArchive.setDeviceConfig` (`enabled` only — bands remain the SoT, below) | `RecordingSettings` |
| `notifications` | `notificationRules.setDeviceMuted` | `DeviceNotificationMute`, device Overview |
| `privacy-mask` · `device-audio` | `privacyMask.setMask` / `setAudioEnabled` | `PrivacyMaskSettings` (ui-library, Image tab) — and the Reolink driver form's `privacyMaskEnabled`, a SECOND writer of the same mask, is deleted |
| `broker-audio` | `streamBroker.setDeviceAudioMute`, node-routed | `StreamBrokerPanel` (addon-pipeline widget) |

Rules for any surface that grows one of these:

- **Write the authority, never a store of your own.** Two knobs that disagree is
  worse than one knob; this repo has shipped that twice.
- **Off is a STATE, not an absence.** A switched-off function renders an "off"
  badge and `CameraStatus.switchedOff` carries the same ids. A camera producing
  nothing because somebody turned it off must never look like a broken one.
- **Unknown is not a control.** A source that did not answer renders as unknown
  and cannot be clicked — never a value defaulted to "on". A toggle over a
  guessed state writes the opposite of what the operator sees half the time.
- **Never normalise on mount.** Mounting issues reads and nothing else. A
  surface that "corrects" state on render silently undoes a decision.
- **Say what it costs.** Each surface carries its own cost line now that the
  payload no longer ships one; it is still always visible, never tooltip-only.

`switchedOff` is an ARRAY of ids, never a boolean, and that is what makes a
partial switch expressible: `device-audio` appearing there means the camera is
silent, not that the camera is off. A surface that collapses the array to "this
camera is switched off" would turn a muted camera into a dead one. It is
composed straight from the authorities (`composeSwitchedOff`), so it survives
the removal of everything above it — and it reports `unreadable` separately,
because an empty list is a positive claim only when nothing failed to read.

**"Off" and `switchedOff` are not the same set**, and the exception is
load-bearing. `privacy-mask` is the one row whose ON does not mean "this
function is working" — ON means the mask is ACTIVE, video deliberately
obscured — so it never enters `switchedOff`. Without that, every camera nobody
has masked would badge as operator-disabled and drown the badge that matters.
Render the per-function badge from the row you are drawing and the camera-level
warning from `switchedOff` — never recompute one from the other.

### The rule generalises past a per-camera switch: a MIRROR surface

The same shape applies wherever a surface shows a value some other authority
owns. The worked example, 2026-08-20: on the two steps whose model is
`modelScope: 'cluster'` (`face-embedding`, `clip-embedding` —
[D199](../decisions/adr-0199-a-model-choice-has-a-scope-and-a-scope-change-has-a-workflow.md))
the step inspector stops showing the per-`(node, device)` `modelId`, which
the runtime now overrides and which is therefore a leftover. It shows the ONE
cluster row, badged `cluster` on the chip and `cluster-wide` in the inspector,
READ-ONLY, with a link to its card on Cluster → Settings (Faces & recognition, or Semantic search) — the one
place that row is edited (D757; it used to be a second editor of it).

Two decisions inside that are the reusable part:

- **The row stays VISIBLE rather than being hidden.** An operator configuring a
  node's accelerators reads this list, and a step silently missing from it
  says "not available on this node" — the wrong conclusion, drawn from an
  absence nobody wrote.
- **The warning comes BEFORE the choice, not after it in a log.** The inspector
  says up front when the viewed engine ships no build of the selected model,
  because the consequence there is a REFUSAL (no vectors from this node), not a
  substitution.

Second worked example, 2026-08-21 and 2026-10-24: step **settings** are
node-scoped content. D210 first made the dispatch read FOLD them across the
node's accelerators (a species allow-list saved under `hub:cpu` read as
"unset" in the gpu/npu cells while sheep labels kept flowing). The fold read
disabled entries too, and production ended up keeping its only allow-list on
switched-off `cpu` entries. Since
[D927](../decisions/adr-0927-a-model-is-chosen-by-the-accelerator-that-runs-it.md)
node-wide content has its own key (`agentSettings[node].stepSettings`), a
device entry is read for that device alone, and the inspector shows
`effectiveStepSettingsForDevice` = node layer ⊕ the device's own entry — the
same rule as the runtime's `nodeDeviceBase`.

`components/pipeline/` is hardcoded English with no `useTranslation` in any of
its components (41 `.tsx` files at 2026-08-26, tests excluded). That is a known gap, and the reason this change added none:
translating two strings inside it makes the surface look partly localised, which
is worse than uniformly untranslated.

## Recording bands are the source of truth

`RecordingConfig.bands` is the only authored recording intent — when to record
and how. `mode` on the wire is a derived summary the recorder stamps on save;
authoring it has no effect. `packages/types/src/interfaces/recording-config.ts`
(`deriveRecordingMode`) is THE one definition: any continuous band →
`continuous`, any band at all → `events`, empty bands or `enabled: false` →
`off`. The settings UI, the cap's `activeMode`, and Notification-Center's
"is this camera recording" read all go through it.

The Mode chip in `RecordingSettings`
(`packages/ui-library/src/composites/cap-settings/RecordingSettings.tsx`) is a
shortcut, not a second store:

| Chip | What it writes |
| --- | --- |
| Off | `bands = []` (`enabled` follows) |
| Events / Continuous | replace with one all-week `00:00–23:59` band of that mode (`alwaysBand`) |

**A band also says whether its footage carries SOUND.** `band.audio`
(`on | muted`) is optional and its ABSENCE MEANS `on` — every recording written
before the key existed carried sound, and a band whose key is missing must keep
meaning what it meant, so `Silent` in the editor is always an explicit choice
and never a migration artefact. It is on the band rather than on the camera
because one camera can want both (silent across a shop floor by day, sound
overnight), it is offered for both modes, and `bandAudioAt` is a decision of its
own — `shouldRecordAt` still owns whether to record at all.

`activeBandAt` (`packages/addon-pipeline/src/recorder/band-engine.ts`) is the
first band whose weekday+span covers *now*. No covering band = nothing is
recorded then. Overlapping bands are legal in the schema; only the first match
wins, silently. A mix of continuous and events is valid only as **non-overlapping
windows** (day vs night). Do not encode the mix as two overlapping rows and
expect both to fire.

The device-header switch still writes `enabled` only (table above). Settings
stamps `enabled` from `bands.length > 0`. `deriveRecordingMode` reads both, so
`enabled: false` with leftover bands is Off. Do not add a third Mode field.

There is no clip file and no clip sweep. A videoclip is a query-time window
over `recording.getAvailability` plus analytics events; the recorder is not
rewritten to persist visits. Footage the CAMERA holds — an SD card, a hub
child's event list — is a different store asked the same question: the
`videoclips` collection cap's browser, a SECTION at the end of the **Recording**
tab and not a tab of its own, because the tab already carries the recorder's
panel, the bands and retention. Event-mode holes (pre/post keep-window) are real
gaps — `RecordingIndex` merges only ≤ 5 s. `recordingArchive.getStorageUsage` reports
indexed used bytes and `statfs` capacity per physical volume; it is not an
ENOSPC event and nothing on this page should pretend the volume is full from
it. See [post-analysis.md](post-analysis.md#disk-wins-reconcile).

The Recordings tab's disk bar (`?tab=storage`, labelled "Recordings" since the
page was re-sorted by domain) plots VOLUME fill — `(totalBytes - availableBytes) /
totalBytes` — not `usedBytes / totalBytes`, which is the share of the disk taken
by footage. The two diverge on any shared array: 92.9 GB of recordings on a
4 TB volume renders 2% while the disk sits at 99%. Thresholds and the roll-up
live in `components/recordings/storage-fill.ts` (warn ≥ 85%, critical ≥ 95%);
the recordings share is still shown because it is the part Prune and Delete can
free. `usage.locations` is OPTIONAL — the hub serves this method through a baked
router, so a hub on an older framework train strips the array out of an answer a
newer recorder produced, and a UI that dereferences it unconditionally loses the
whole page over a missing disk bar.

### The switch pair is the API, not a shim

`pipelineOrchestrator.getCameraSwitches` / `setCameraSwitch`
(`addon-pipeline-orchestrator/src/camera-switch-service.ts`) carried a
deprecation notice for thirteen months while the shipped viewer was BUILT on
them, and `addon-provider-homeassistant`'s `ha-export` projected the same group
as Home Assistant switch entities. A shim its own clients depend on is not a
shim; the notice only stopped new code from using the good door. D544 removed
it, and device details is now a caller too.

`scripts/check-switch-successor-surfaces.ts` (CI) survives with the half that
still holds: every switch writes the authority that owns its function
(`applyWrite` dispatches on `CameraSwitch.authority`). It no longer fails a new
caller of the pair — it prints them as a census, so the set stays visible rather
than remembered.

## A person is an Admin or a Viewer ([D921](../decisions/adr-0921-a-person-is-an-admin-or-a-viewer-and-a-viewer-is-its-devices-and-its-features.md))

`/system/identity?tab=users` → Access (`components/users/UserAccessModal.tsx`)
is the only place an operator sets a person's role. It asks one question,
**Admin or Viewer**, and for a Viewer one device list in one mode plus the
named features:

| Piece | Lives in | Why there |
| --- | --- | --- |
| what Save writes (`draftFromUser`, `withMode`, `saveRequestOf`) | `components/users/user-role-model.ts` | pure, so every write decision is pinned by `user-role-model.spec.ts` |
| the device list | the shared `DevicePicker` (`pages/system/DevicePicker.tsx`), parents only | the picker used everywhere else (D636); a camera's children follow it |
| the mode | `SegmentedChoice`: "All devices except…" or "Only these devices…" | one list, never an allow list beside a block list |
| the feature list | `VIEWER_FEATURES` in `@camstack/types`, labels translated under `users.viewerFeatures.<id>` | the catalogue grows one entry at a time with the methods it unlocks |
| the device count (`auth.previewScope`) | `server/backend/src/api/core/auth.router.ts`, shown by `components/users/RolePreview.tsx` | see below |

Rules that each cost something to learn:

- **Save writes the admin flag, then the scope set.** Admin is
  `updateUser({ isAdmin: true })` + `setUserScopes([])`; Viewer is
  `isAdmin: false` + `[viewerRow]` (`Users.tsx` → `handleRoleSave`).
  `setUserScopes` refuses any other shape.
- **"All devices except…" is `allow: '*'`, `block: <picked>`.** Nothing picked
  is every device, including ones added later. "Only these devices…" is
  `allow: <picked>`, `block: []`, and Save is refused until one device is
  picked. Switching mode keeps the picked ids. A camera's children follow the
  parent, so the picker lists parents.
- **A stored allow-list plus a block has no mode.** It opens as "Only these
  devices…" with `allow` minus `block`. Nothing else is said.
- **The preview is the ENFORCEMENT, not a model of it.** `previewScope` is the
  same `summarizeEffectiveScope` over the same `ctx.deviceFleet()` that
  `auth.me` uses. Never recompute a reach count in the browser, and suppress
  the number while the draft is unsaveable rather than show a stale one.
- **Zero access is stated, in words.** A non-admin with no viewer row opens as
  "All devices except…" under a "No access yet" notice, and reads "No access"
  in the table until a role is saved. A leftover grant set is not shown.
- **The operator cannot demote themself** from this modal.

The raw scope editor (`ScopePicker`) remains for TOKENS
(`components/access/CreateTokenModal.tsx`), not for people; the View / Operate /
Full management presets (`packages/types/src/schemas/access-roles.ts`) no longer
have a screen.

## The viewer's notification rule editor — one kind, a summary, a route per section ([D631](../decisions/adr-0631-the-viewer-edits-a-rule-per-kind-on-its-own-route.md))

The phone (`camstack/`) edits notification rules on its own routes, not inside
the Rules / Targets / Snooze segment — switching segment used to throw an
unsaved rule away.

| route | screen |
| --- | --- |
| `app/(app)/rule/new.tsx` | kind picker, or the summary of a new rule when `?kind=` is known (the static `new` beats `[id]`) |
| `app/(app)/rule/[id]/index.tsx` | the rule's summary: one row per section, Save / Cancel, the back guard |
| `app/(app)/rule/[id]/[section].tsx` | one section's sub-screen |
| `app/(app)/timelapse-rule/[id].tsx` | the timelapse editor (`id` = `new` to create) |
| `app/(app)/summary-rule/[id].tsx` | the digest editor (`id` = `new` to create) |

The hrefs come only from `camstack/src/navigation/rule-routes.ts`, typed as
expo-router `Href`.

- **The kind first, then locked.** The rules list is a strip by kind
  (`viewerKindStrip`, `rule-kind-nav.ts`) plus the timelapse and digest tabs;
  an empty System tab is dropped only once `auth.me` has said not-admin (D315).
  The editor never offers another kind's discriminator, so the phone never
  converts a rule.
- **Sections are not listed here.** `editorSectionsFor(kind, isAdmin)`
  (`rule-editor-sections.ts`) is the shared `ruleEditorSectionsForKind` minus
  Actions for a non-admin; the viewer owns only the labels and the claim map
  (which form field each section edits, every field exactly once — spec).
- **The draft is memory-only** (`camstack/src/store/nc-rule-draft-store.ts`,
  no persistence): the summary and its sub-screens share it, Save discards it
  only after every write landed, and a section opened cold (by URL) discards
  an orphan draft a tick after it unmounts unless a summary holds it. Editors
  render inside `EditorScroll` (KeyboardAvoidingView + `keyboardShouldPersistTaps`).
- **The back guard** is `usePreventRemove` from `expo-router/react-navigation`
  plus `useConfirm` — a raw `beforeRemove` does not hold the iOS swipe, and
  `Alert.alert` does nothing on web. Armed only while the draft is dirty.
- **Invalid fields turn red only after a Save attempt**; Save stays enabled
  and a pressed invalid Save lists the problems (`ruleFormProblems`, the one
  authority `isRuleFormValid` derives from).
- **Save waits for two answers.** Who is saving (`AdminVerdict` =
  `pending | admin | not-admin | unknown`, `camstack/src/data/use-me.ts`) and
  which targets are his (`nc.listMyTargets`) decide which stored targets a save
  keeps (`target-ownership.ts`: an admin keeps unlisted ones verbatim, a
  non-admin's are filtered to his own). `save-gate.ts` blocks every Save — rule,
  timelapse, digest — on `pending`, on `unknown` (a FAILED `auth.me`) and on a
  pending or failed targets read, and names the reason. For visibility
  `unknown` is not-admin; for a Save it is never guessed. The picker says how
  many unlisted targets the save keeps (admin) or removes (non-admin).
- **A kept deleted device is drawn.** A selected device id the answered camera
  list lacks is looked up by id (`useDevicesByIds`, never the whole catalogue)
  and shown as "Device #id — removed" (or by name when it is a non-camera
  device), deselectable; pending shows loading and a failed list never says
  "no cameras". Where an empty list means ALL cameras, emptying it warns. The
  same helper, `device-selection.ts`, lives byte-identical in the admin UI
  (`packages/addon-admin-ui/src/pages/system/device-selection.ts`), held by
  `scripts/check-device-selection-in-sync.ts`.
- **Admins can test from the phone:** the dry-run under Conditions and Test
  now on a saved rule's summary, both hidden unless the verdict is `admin` and
  both refused by the hub otherwise.
- **A disabled rule the prune switched off** carries the D633 banner (admin
  only, `nc.listPrunes`).

## A device selection is ONE smart picker, in both clients ([D636](../decisions/adr-0636-battery-alerts-are-authored-apart-and-an-unheard-raise-stays-pending.md))

Every notification device selection — a rule's devices, a system rule's
include and exclude lists, the timelapse and digest cameras — is the same
picker (the alarm's non-blocking openings are a table that shares its filters,
below): the selection as removable chips
("+N more" past six) and a searchable list, opened only to change it, grouped
by (type, room) with a per-group count and **All / Clear**, big groups
collapsed at rest. The decisions are `device-picker-model.ts`, byte-identical
in `packages/addon-admin-ui/src/pages/system/` and
`camstack/src/components/notifications/` (guarded by
`scripts/check-device-selection-in-sync.ts`, with its spec).

- **Admin:** `pages/system/DevicePicker.tsx`, whose chips and search shell are
  `SearchableMultiSelectField`'s (`SelectedChip`, `INPUT_SHELL`). The list is
  rendered a page (60 rows) at a time with "Show N more".
- **Viewer:** `DevicePicker.tsx` + `DevicePickerSheet.tsx`, opening the
  sheet frame the accessory "add" sheet uses (`components/ui/PickerSheet.tsx`,
  extracted from `AccessoryAddSheet`). The list is one `FlatList` with a fixed
  row height and a render window of 30 — 500 devices of one type mount 29
  device rows.
- **Reads:** the picker filters the list its caller already holds (`cameras`,
  or `fleet` — the phone reads the fleet catalogue only while the sheet is
  open — or `caps`, the devices `listDeviceIdsByCaps` answers for the battery
  section, or a `given` list). A selected id the list lacks is named by a
  TARGETED `listAll({ deviceIds })`; `device-selection.ts` still decides
  removed / named / unknown (D315) and nothing is dropped on a read (D49).
- **Filters: Type, Zone, Location, Reset**
  ([D697](../decisions/adr-0697-an-alarm-mode-inherits-every-delay-it-does-not-set-and-a-switch-writes-one-membership.md)).
  Beside search and "Group by", the picker offers multi-select **Type**, **Zone**
  and **Location** filters (`DeviceFilterBar`, `device-filter-bar.tsx`; the
  decisions are `applyPickerFilters` / `pickerFacetOptions` in
  `device-picker-model.ts`, so both clients filter alike). Filters NARROW the
  list; "Group by" only arranges it. **Zone applies only from an ANSWERED zones
  read** (D315): until then the dropdown is disabled ("loading zones…" /
  "zones unavailable") and a chosen zone is reported as paused, never as
  "matches nothing". **Reset filters** clears search, Type, Zone and Location and
  leaves "Group by" untouched. A selected id that the filters hide is not
  dropped: the picker says "N selected hidden by filters". The Zone and Location
  facets are **confirmed by the operator (2026-10-02)**.
- **The alarm's sensor list is the shared `DeviceList` (generic mode).** It is
  the Devices page's chrome: a Type filter on the left, the search on the right,
  ONE table sorted by name, the zone and location a muted line under the name.
  It is never split by zone or room, and it has no Group by (operator,
  2026-10-02, after the live check). On a phone the Type and "Checked when
  arming" columns are hidden (`hidden sm:table-cell`), so Name, State and the
  switch fit. The table-state model `alarm-sensor-table-model.ts` is kept
  byte-identical in the viewer; it drops the rows no rule of the mode covers
  (Q2, see `notifications.md`). The guard
  (`scripts/check-device-selection-in-sync.ts`) holds 10 pairs.
  `CAMSTACK_VIEWER_DIR=<viewer checkout>` points it at a checkout when the
  `camstack/` submodule is not present; with the variable SET, a missing viewer
  file is a failure, not a skip.
- **The Alarm tab is laid out like the Rules tab.** The modes are sub-tabs
  (`Tabs`, with the mode's sensor count); one mode is shown at a time. A mode is
  one line of badges (what it checks, how many open sensors refuse the arm,
  how many are not notified), with the long coverage words in the badges'
  tooltips; its three delays sit on ONE row (`FormField`, the "Default" badge or
  a reset icon beside the unit); then its sensors. There are no paragraphs; the
  open-now list is the State column. The viewer does the same with a
  `SegmentedControl` and one short line per fact. An alarm-only table, field,
  tab bar or paragraph is what made the tab look like another product.
- **A system rule lists EVERY device**, not only cameras: a battery or a
  consumable belongs to a sensor or a vacuum. The battery SECTION lists only
  the devices carrying `battery` or `consumables`. Which section a system rule
  is edited in comes from the editor's category, never from the value — a
  mixed rule whose last general kind is unticked stays general.

## Model Studio → Installed is a file inventory ([D746](../decisions/adr-0746-installed-lists-files-per-model-and-format-and-in-use-means-resident-in-a-pool.md))

One row per model × format on the selected node, in the library `DataTable`
(cards below `sm`). Each row has its own size, precision (`getSchema`
`precision`, shown only when the build states it) and copy state (`onDisk`;
a `stale` badge for a copy not at its D743/D744 revision). The chips are the
node's devices of that format, so NPU and iGPU sharing one IR are two chips
on one row. A chip is **loaded** when the model is resident in that device's
pool (`listLoadedEngines`) and **configured** when the device is enabled, the
file is current, and the device's effective model is this one. A disabled
device is drawn "off" and never counts. The status column reads in use /
configured / idle / unused / audio analyzer / load unknown. Remove deletes
one format and appears only on idle and unused rows. Filters are provider ·
step · device (from `getNodeInferenceDevices`, disabled devices marked off;
it keeps the rows whose format that device runs) · node, all in the URL. A
cluster-scoped model (face, CLIP) has read-only chips. The **Cluster models**
section shows, for each online node, where it runs (node · runtime ·
devices · loaded, or "no build for <format> → refused"), and changing it is
that section's explicit action with its confirm. The logic is pure and
tested in `addon-model-studio/src/ui/installed-inventory.ts`.

## Pipeline → Cluster: one tab per question ([D748](../decisions/adr-0748-a-share-is-a-share-of-parallel-sessions-held-at-each-session-start.md))

The Cluster pane answers four different questions, each on its own tab, and a
control lives on exactly one of them:

- **Assignments** — WHICH camera runs WHERE: `CameraAssignmentsTable`, the
  library `DataTable` with one row per camera of the CAMERA LIST (never per
  assignment record — a camera with no session and no pin has none, and 27 of
  32 were missing), one Placement column (node pin + accelerator pin, library
  `Select`s, the only editors), **Roles here** (Detection / Decode / Audio as
  coloured pills from `assignNodeColorId` + live `getCameraStatuses` when
  available), "Running on" by node NAME, live status, and an activity filter
  (Active / Recently active / Inactive chips above the table,
  `CAMERA_ACTIVITY_CHOICES` in `assignments/camera-activity.ts`). Stream brokers open in the
  standard library `Dialog` (header title + `DialogContent`'s Close; the
  compact stream-broker widget omits its own title). A node's own Assignments
  tab (`NodeCameraAssignmentsTable`) lists the cameras placed there now, with
  the same Roles here column. Every surface names a node by its display name and
  a camera by its name (`assignments/assignment-rows.ts` `nodeNamer` /
  `cameraNamer`; Auto tune and Stale device pins included).
- **Load balancing** (`ClusterLoadBalancingTab.tsx`) — HOW MUCH each node and
  accelerator carries: the orchestrator `load` settings section (the
  `sessionPlacement` policy, node stress, low-fps relocate — rendered here and
  omitted from Settings), live load, `NodeLoadOverview` (target vs the actual
  1 h share of parallel sessions from `getPlacementStats`), the node share
  stack with its source selector **Hardware / Benchmark / Manual** (D750,
  D755; a radiogroup of three buttons, `SHARE_SOURCE_OPTIONS`): under the two
  automatic sources the computed shares from `getEffectiveShares`, read-only
  (`WeightSliderStack readOnly`, and the accelerator stacks via
  `NodeInferenceDevices autoDeviceShares`), and under Benchmark one line naming
  every node that fell back to its hardware capacity; in Manual one
  `setLoadBalancingShares` write per release — plus the line naming a node that
  cannot take sessions and where its share went, max concurrent sessions,
  Suggest from hardware / benchmark (advisory caps shown on the accelerator
  rows; "Apply" only in manual), accelerators, and stale device pins
  (one-click clear). The D748 "Auto tune with these shares" what-if is gone:
  shares no longer change the plan.
- **Auto tune** — the detector recommendation (D745, D755): options "Keep
  free" (headroom) and "At least N cameras at once per accelerator"
  (`minSessionsPerDevice`), a Capacity column per device, both options sent
  with the plan and with the apply.
- **Roles** (tab id `roles-nodes`, `?ctab=roles-nodes`; label **Roles** only —
  stable deep links keep the id) (`ClusterRolesNodesTab.tsx`) — WHO does what:
  two `SectionCard`s — Cluster roles (one row per role, the library `Select`,
  nodes by name) and Node capabilities (`NodeCapabilitiesTable`: the shared
  `DataTable`, a library `Switch` per capability — Detect and Audio only;
  reachable host is on Nodes → General, decode limits on Pipeline → node →
  Engine & decoder). Mesh cutover controls (clear port, agent dashboard
  origins, join-token pairing) were retired from the `system-config` Cluster
  form — use Pipeline → Cluster / Nodes instead; a stored `cluster.meshClearPort`
  is still applied at hub boot. No share and no cap here, and no
  storage: the events folder (the `eventMedia` location) is managed only on
  Recordings → Events (`ClusterEventsTab` inside `EventsSection`), beside the
  event store it holds.
- **Settings** (`ClusterSettingsTab.tsx`, D765) — one full-width card per
  subject, from `cluster-settings-sections.ts`: Faces & recognition (face
  encoder, embed floor, the face-gallery matching knobs), Semantic search
  (CLIP encoder), Enrichment crop, Full-resolution crops (native lease),
  Runner defaults (runner tuning + audio backend: cluster values every node
  reads), Failover. A card draws fields from several addons with
  `NodeAddonsSettingsPanel` `fieldKeys` / `hideSectionChrome`; every key is
  still saved by its own addon. The cluster-scoped encoders are edited HERE
  only; the step matrix links to their card (`clusterStepSettingsHref`).
  The three face-size floors are three gates (embed / keep / auto-assign) and
  stay three keys.

There is no Templates tab: pipeline templates were removed with their caps
([D759](../decisions/adr-0759-pipeline-templates-are-removed.md)), and a stale
`?ctab=templates` link lands on Assignments.

Cards on these tabs use the library's `SectionCard` (`SECTION_CARD` +
`SECTION_HEADER` + `TEXT_SECTION_LABEL`), the same chrome as the device
Customize tab (`CustomizeCard` wraps it). A share slider stack commits its
whole batch in one request — a write per entry raced its siblings.

An accelerator is named by one function, `acceleratorLabel` in
`ui-library/src/composites/accelerator-label.ts` (Intel NPU, Intel iGPU, Coral
Edge TPU, Apple Neural Engine, CPU — and `acceleratorShortLabel`: NPU, iGPU,
Coral, ANE, CPU). The placement board's `acceleratorFace`, the load reading,
the assignments picker, the step matrix's column headers and Model Studio's
device chips all go through it, and Auto tune's hardware-kind names match it.
Hand-kept copies had named the Mac's CoreML device "Coreml All", "Apple ANE"
and "CoreML".

## Cluster → Palette ([D939](../decisions/adr-0939-the-display-palette-is-one-hub-capability.md), [D940](../decisions/adr-0940-the-display-palette-is-provided-by-the-pipeline-orchestrator.md))

`/system/pipeline?ctab=palette` (`ClusterPaletteTab`) edits the hub
`display-palette` singleton. The pipeline orchestrator provides it (D940)
and stores the document under `displayPalette` in its own addon settings.
The tab edits a preset, or a custom table that starts from one.
The editor runs `validatePalette` while the operator changes a colour, and
`setPalette` refuses the same pairs. The legend names every swatch (label
and hex) on both contrast grounds (`#0c0a09`, `#fafaf9`); subclasses sit in
a collapsed group under their parent. The live cursor and the heatmap handle
must be at least ΔE2000 20 apart. In the CamStack preset the handle is
`#4b32ff`.

Detection colours, the event-kind legend and server-drawn boxes read that
palette. A pending read stays pending. An `unknown` result (the settings
store could not be read) keeps the bundled CamStack preset and says so; it
is not presented as the stored choice. The viewer consumes the same
`getPalette` shape in a later phase.

## Network → Diagnostics: WebRTC from the browser in your hand ([D752](../decisions/adr-0752-webrtc-reachability-is-diagnosed-from-the-network-page-through-the-real-player.md))

`/system/network?tab=diagnostics` (`NetworkDiagnostics.tsx`, the cards from
`ui-library/src/composites/webrtc-diagnostics/`). It replaced Benchmark's
WebRTC / TURN tab, which is gone.

- **ICE servers** — the live `turnProvider.getTurnServers` list, one row per
  URL (credentials are passed to the probes and shown only as `auth`). "Test
  each endpoint" gathers per URL and, for a TURN URL, connects two relay-only
  peers in the page: srflx mapping, relay allocated, relay protocol (the
  loopback's local-candidate stat, else the candidate), the ICE event `url`,
  relay RTT. "Check NAT" asks two STUN destinations from ONE peer connection
  and compares the srflx mappings: different ports for one base = symmetric
  NAT; one mapping across two destinations is `likely` endpoint-independent
  (browsers drop an identical second candidate). A same-page loopback with
  policy `all` is not offered — it always connects host↔host.
- **Hub session test** — camera + pinned stream (cheapest first: low, sub,
  mid, high; never adaptive), 15 s through `CameraStreamPlayer` with browser
  policy `all`, then 15 s `relay`. The card only listens (D752); the report
  is the hub's candidates parsed from the answer SDP + trickle with the
  "LAN/Tailscale only, no srflx/relay" flag, ICE → DTLS → first-frame times,
  the selected pair and RTT, packets/bytes/frames received against the hub's
  `rtpPacketsSent`, loss/freezes/PLI/NACK, and a per-layer verdict.
- **Unknown is a word.** Every unmeasured value renders "unknown" (`format.ts`),
  never `0` or a dash; a hub count that was not read keeps the verdict
  `unknown` rather than "hub not sending".
- **On a phone** the page is the same admin route in the phone's browser (it
  stacks; the endpoint table becomes cards). The native app's WebView is not
  wired yet — see the roadmap.


## A detection step is edited from the step matrix ([D757](../decisions/adr-0757-a-detection-step-is-edited-from-the-step-matrix-in-a-panel-docked-to-the-scroll-container.md))

Pipeline → node → Pipeline (`NodeStepInspector`) is the steps × accelerators
matrix. Device → Detection pipeline → Steps (`CameraStepInspector`) is not:
a camera only turns steps on or off (D927), so that page is the catalog's
step tree — name, kind, the classes the step consumes and produces, and
On / Off / Auto (`stepToggles`; Auto follows the catalog default). An
ancestor that is off idles its descendants. One line above the tree links to
Pipeline › Nodes, where the accelerator that runs the camera chooses the
model. The docked panel edits camera-semantic settings only and says so when
a step has none. The bullets below describe the **node** matrix.

- **The page:** the steps × accelerators matrix, `DeviceStepMatrix`.
- **The settings:** the clicked cell's settings open in a docked panel built
  from `ui-library/src/composites/step-inspector/`.
- **The glue:** admin-side `components/pipeline/step-inspector/`
  (`StepMatrixFrame`, the view model).

D756's list + inspector shipped in 1.2.476. It was reverted on the operator's
word: the table was the part he liked; the settings detail was the part that
did not work.

**The matrix.**

- One row per step (slot, name, class chips, the camera's gate as a badge) and
  one column per accelerator under its node.
- Each column header comes from the ONE naming function `acceleratorLabel`
  (ui-library `accelerator-label.ts`, also used by Load balancing, the camera
  assignments pin and Model Studio), plus the format, the elected model and
  "off".
- Switched-off accelerators show only behind "Show disabled accelerators".
- A cell opens `(step, accelerator)`; a step's header opens the STEP itself,
  with no accelerator (D764).
- Keyboard:
  - one Tab stop (a roving tabindex over headers and cells);
  - arrows, Home, End and PageUp/PageDown move it;
  - Enter or Space opens the cell, and focus follows into the panel. A pointer
    click keeps focus on the cell; `onCellClick`'s `viaKeyboard` carries the
    difference.
  - Escape on the panel or on the matrix closes the panel and returns focus to
    the cell (`DeviceStepMatrixHandle.focusCell`).
- `/` filters the rows by step name or field label; Enter opens the first hit.

**The panel never reflows the matrix.**

- **Anchoring.** `StepDetailDock` is `position: fixed` over the right edge of
  the nearest scroll container (`dockBox` measures its top, bottom and right),
  so its header and save bar stay on screen whatever the matrix scrolls.
- **It reserves no width.** The matrix adds a trailing spacer as wide as the
  dock (`reserveRightPx`) and scrolls the selected cell into the uncovered
  part.
- **Narrow areas.** When a sticky step column plus the dock leaves less than one
  column of room (the camera page beside its live view), the step column stops
  being sticky. Its width is unchanged; only its stickiness goes.
- **Never use `md:pr-*` or any width reservation for a side panel.** That was
  the original slide-over's bug (before D756): the matrix re-measured into its
  single-node layout and hid the clicked cell.
- **Phone:** the dock is a full-screen `Dialog` sheet with "‹ Steps".

**Selection.**

- `?step=&acc=` (`lib/step-url-selection.ts`, `useStepUrlSelection`), `replace`,
  every other param kept. The panel is open exactly while `step` is set; a
  `step` that names nothing opens nothing and says so. `acc` is
  `${nodeId}/${deviceKey}`; absent or unknown it is the step view, never the
  first accelerator.
- The node page's tab is `?ntab=`, and the cluster page's tab is
  `?ctab=&section=`. Build those links with `pipeline-links.ts`.
- Changing the device tab or the node tab clears `step` and `acc`.

**The panel is about what was clicked** ([D764](../decisions/adr-0764-the-step-settings-panel-is-about-the-clicked-cell.md)):

- `StepInspectorPanel`: pinned header (title "<Step> · <node> ·
  <accelerator>" for a cell, "<Step> · <node>" / "<Step> · this camera" for a
  header; the gate on a camera), one scrolling body, and a save bar where Save
  keeps the panel open. There are no accelerator tabs.
- Model: on a node, a cell shows that accelerator's `StepModelRow` alone
  (change, reset, "Run on"); a header lists every accelerator's model
  read-only (`EffectiveModelSummary`). A camera has no model section — the
  model is chosen on the accelerator (D927), and the camera panel does not
  name one. Cluster-scoped models (face / CLIP) are read-only on the node,
  with a link to their card on Cluster → Settings.
- `LayeredSettingsForm`:
  - On a node: the node-wide fields (`setNodeStepSettings`) and, on a cell,
    that accelerator's model-bound floors (its own entry) — the step view says
    floors are per accelerator. On a camera: the camera layer only, without
    any model-bound field (`cameraScopedFields`).
  - Every field shows the value in force on the viewed accelerator, its source
    and the levels below it, with "Reset to <next level>".
  - Writes are field-level (D754); a copy of the merged view is never written.
- Node-wide settings live in `agentSettings[node].stepSettings`; a device
  entry holds that accelerator's own fields and is never read for a sibling
  (D927, replacing D210's fold).

**Checking a layout change.** jsdom cannot measure it. The recipe:

- A scratch Vite root mounts the real tab inside the real page scroller, over a
  fake tRPC link that applies writes to an in-memory store.
- Playwright opens every step on its RIGHTMOST accelerator at 1440 × 900,
  1280 × 720 and 390 × 844, and asserts:
  - the panel's heading and Save are on screen;
  - the clicked cell is on screen and not under the dock;
  - the grid's column template is unchanged;
  - `scrollWidth - clientWidth == 0`;
  - Escape closes the panel and focus returns to the cell.

## Pipeline page (`Pipeline.tsx`)

The route is `/system/pipeline` (there is no `/system/server`). The top bar
switches **Nodes** (`?view=nodes`, default) vs **Cameras** (`?view=cameras`).
Nodes mode is master-detail: `?node=` selects the synthetic Cluster entry
(`__cluster__`, default) or a cluster node id for `ClusterDetail` /
`NodeDetail`. Cameras mode is the operational roster (`CamerasOverview`).

## Pipeline → node page

`NodeDetail.tsx`: Assignments, Pipeline (the step matrix), Engine & decoder,
Scheduler, Warm instances, Logs, in `?ntab=`. It renders the `perNode`
population only (`fieldScope="perNode"`, D765): a value every node reads from
one cluster key (runner tuning, the audio backend) is on Cluster → Settings →
Runner defaults. The decoder's section is shown on the engine tab
(`tabAliases`, `?ntab=decoder` lands there). The scroller pads `p-4 sm:p-6`.

