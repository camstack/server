---
id: D774
title: An integration page shows one integration, chosen from icon pills in the page header, and its address is in the URL
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/addon-admin-ui/src/components/integration-hub/**
  - packages/addon-admin-ui/src/lib/integration-hub-url.ts
  - packages/addon-admin-ui/src/hooks/useIntegrationSelection.ts
  - packages/addon-admin-ui/src/pages/system/Integrations.tsx
  - packages/addon-admin-ui/src/components/brokers/BrokerManager.tsx
  - scripts/check-integration-hub-links.ts
---

## Context

Connectivity, Remote Access, Mesh Networks, TURN Servers, Authentication and
Log destinations were all `AddonCollectionPage`: an accordion table with one
collapsible row per addon, each row expanding into that addon's panel,
settings and logs. Connectivity stacked a page header, a kind tab strip, a
second header per kind and then the table. The operator asked for the app's
usual page header with the integrations as pills showing each one's ICON next
to its NAME, the content switching below, deep links to every integration on
every page, and a review of whether the settings use the form builder.

Two things the table hid surfaced in the rework. The open row was component
state, so no link, reload or notification could name an integration. And the
message brokers were one kind-wide connections table: the broker addons' own
settings (the embedded MQTT broker, the Alexa-import proxy login) were
reachable only from the Addons page.

## Decision

An integration page is an `<IntegrationHub>`: `AdminPage`'s header with a pill
per integration (addon icon + name + state) in its `nav` slot, and exactly one
integration's body below — for an addon, `<AddonIntegrationBody>` (status strip
with the common controls, the page's panels, the addon's schema settings
through `NodeAddonsSettingsPanel`, activity). The selection is
`?integration=<addonId>` and a body section is `?section=<id>`; both are spelled
only by `lib/integration-hub-url.ts`. Choosing a pill pushes a history entry, a
stale id falls back to the first integration and says so once the list has
answered, and Connectivity's old `?tab=<kind>` links still open their group.
On Connectivity a message broker is an integration per addon, with its
connections (`BrokerManager addonId`) as its panel. A page contributes panels,
never a settings form; where an addon's cap-scoped schema would duplicate a
panel, the addon omits that section for that cap.

## Consequences

- Choosing an integration pushes history, unlike `?node=` and `AdminTabs`'
  `?tab=`, which replace. A hosting tab must drop the hub's params when left
  (`ownedParams: INTEGRATION_HUB_OWNED_PARAMS`).
- Settings and Activity stay on one scroll; a deep link scrolls to a section
  rather than hiding the others behind sub-tabs.
- The per-provider accordion and its search box are gone; with one to five
  integrations per page, the pills are the list.
- `mqtt-broker`'s schema under the `broker` cap leaves out
  `mqtt-broker-external`, because Connectivity → MQTT Broker → Connections edits
  the same `config.brokers`. The addon's own page still shows it.

## Enforcement

`scripts/check-integration-hub-links.ts` (in `checks.yml`): no admin-ui source
spells `integration=` / `section=` outside the builder, every page in
`INTEGRATION_HUB_PAGES` is a route `App.tsx` declares, and every hosting tab
takes its id from the registry and declares the owned params.
`integration-hub.spec.tsx` pins the header, the pills, URL selection, deep-link
restore, back/forward, the stale notice and the settings being the form
builder; `integration-hub-url.spec.ts` pins the resolver and the builder.
