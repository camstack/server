---
title: Admin UI page patterns
applies-to:
  - packages/addon-admin-ui/src/components/integration-hub/IntegrationHub.tsx
  - packages/addon-admin-ui/src/lib/integration-hub-url.ts
  - packages/addon-admin-ui/src/lib/system-page-url.ts
  - packages/addon-admin-ui/src/pages/system/System.tsx
  - packages/addon-admin-ui/src/lib/node-url-selection.ts
  - packages/addon-admin-ui/src/pages/system/Cluster.tsx
  - packages/ui-library/src/composites/node-picker.tsx
  - packages/ui-library/src/composites/charts/time-series-model.ts
  - packages/ui-library/src/composites/charts/chart-scale.ts
  - packages/ui-library/src/composites/device-history/DeviceHistoryView.tsx
  - packages/addon-admin-ui/src/components/cluster/tabs/process-class-rank.ts
  - packages/ui-library/src/composites/table-sort.ts
  - packages/ui-library/src/composites/data-table.tsx
  - packages/addon-admin-ui/src/components/access/CredentialTable.tsx
covers:
  - packages/addon-admin-ui/src/**
last-verified: 2026-10-21
---

# Admin UI page patterns

How an admin-ui or addon page is put together. Part of [`docs/ui/`](README.md);
the workflow is the `camstack-ui-admin` skill. The components named here are
catalogued in [common-components.md](common-components.md).

## The skeleton of a page

**Where a page lives decides what it can import.**

- An admin-ui page (`packages/addon-admin-ui/src/pages/`) imports the library
  AND the admin-ui-local components: `AdminPage`
  (`components/AdminPage.tsx`), `AdminTabs` (`components/AdminTabs.tsx`),
  `StableTabPanel`, and `components/integration-hub/`.
- An addon page is a Module Federation remote. Its package declares it in
  `package.json` → `camstack.addons[].pages[]` (`id`, `label`, `icon`,
  `path`, `remoteName`, `bundle`), builds `dist/remoteEntry.js` with
  `vite.page.config.ts` (`@module-federation/vite`, exposing `./page`), and
  `AddonPageLoader` (`packages/addon-admin-ui/src/layouts/AddonPageLoader.tsx`)
  registers the remote and renders the default export of `./page` with
  `AddonPageProps` — `{ trpc, theme: { isDark }, navigate }`. React,
  react-query, tRPC and `@camstack/ui-library` are SHARED with the host, so
  the page imports the library, never a copy, and cannot import admin-ui
  components. `mountAddonPage` runs the same page standalone for development
  (`packages/addon-model-studio/vite.page.config.ts` is the reference).
- An addon page ships no CSS at runtime — next section.

**The page frame.** The library's `PageShell` is the one page chrome: optional
icon + title + subtitle, `actions` on the right, a `nav` slot under the title
(for hub pills / selectors), gutter `p-2 sm:p-4`, and `overflow-x-clip` so the
page never scrolls sideways. Admin-ui `AdminPage` is a thin wrapper around
`PageShell` for `/system/*`. Addon pages import `PageShell` from the library
(the older thinner `PageHeader` remains as a deprecated alias of the title
row only — prefer `PageShell`). Design:
(planning repo: superpowers/specs/2026-10-11-admin-ui-composite-patterns-design.md).

**Tabs.** `AdminTabs` puts the active tab in `?tab=` (deep links and Back
work), drops a tab's `ownedParams` when the operator leaves it, and renders
through `StableTabPanel` so switching tabs does not eat the scroll position.
One `?tab=` strip per page — see "System is one page with tabs" below.

**Sections.** A page body is `SectionCard`s (generic chrome: icon, uppercase
title, `actions` — body is free). Optional `SectionToolbar` inside the body
puts filters / `NodePicker` on the left and Add on the right. A setting inside
a section is a `SettingRow` (label + control, stacking below `sm`). A
schema-driven settings block is `ConfigFormBuilder` /
`AddonGlobalSettingsForm`, never a hand-built form — where a schema is allowed
to appear is in
[`docs/architecture/ui.md`](../architecture/ui.md#where-a-settings-schema-is-allowed-to-appear-and-the-key-that-decides-it).
Schema drives **settings and modal form fields only** — it does not generate
collection list shells.

**A page about the integrations of one kind** is an `IntegrationHub`: the
header's pills are the context switcher (one integration on screen, its id in
`?integration=`), and the body is usually `AddonIntegrationBody`. Identity →
Authentication (`pages/system/Authentication.tsx`) is the smallest complete
example: it lists the providers of the `auth-provider` and `user-passkeys`
capabilities, and its only page-specific contribution is an About panel.
Identity → Tokens & sessions (`pages/system/Access.tsx`) is the same base
over things that are not addons — credential kinds. See "Integration pages"
below for the whole contract.

**A managed list** is a `DataTable` — never a stack of Cards for named
items the operator compares by column. `DeviceList` is the only other table
(device rows); do not invent a third.

```tsx
const filter = useDataTableFilter(rows, {
  searchText: (r) => [r.name, r.id],
  facetValue: (r) => r.kind,
})
<DataTableFilterBar
  state={filter.state}
  facets={filter.facets}
  labels={{ searchPlaceholder: 'Search…', searchLabel: 'Search tokens', facetsLabel: 'Kind', clearLabel: 'Clear' }}
  onSearch={filter.setSearch}
  onToggleFacet={filter.toggleFacet}
  onClear={filter.clear}
/>
<DataTable
  columns={columns}            // DataColumn<T>[]; `sortValue` per sortable column
  rows={filter.rows}
  rowKey={(r) => r.id}
  pageSize={25}
  maxBodyHeight={TABLE_SCROLL_MAX_H}
  emptyMessage={filter.active ? 'Nothing matches the filter' : 'No tokens yet'}
/>
```

`DataTable` sorts per column (`sortValue`, `notSortableReason`; `defaultSort`
for the opening order, or `sort` + `onSortChange` when the owner holds it),
pages client-side (`pageSize`, optional controlled `page` / `onPageChange`,
`paginationLabels`) and selects rows (`selection`, needs `rowKey`) — see
"Controlled sort, pages and selection" below. Filtering is
`useDataTableFilter` + `DataTableFilterBar` OUTSIDE the table (`facetValue`
for one chip row, `facetGroups` for several), which keeps the filtered rows in
the caller's hands for bulk actions. A user-chosen page size that should be
remembered is `PageSizeSelect` + `usePersistedPageSize` with a key of the
surface's own. The reference consumer is Identity → Tokens & sessions
(`components/access/CredentialTable.tsx`).

**Create / edit of a named item** (rules, templates, scripts, provider
entries, tokens with a create form, …) opens an **`ItemFormDialog`** — the
same modal for Add and Edit — never an in-page editor under the list. Canvas
and free-form annotation surfaces are the exception. Open state lives in the
URL via `useItemFormUrl` (`?new=1` or `?edit=<id>`, replace). Reference shell:
Notification Center Rules (`pages/system/NotificationRules.tsx`). Delete uses
`useConfirm`.

**Provider entries.** Selection may still use a pill strip; **editing** an
entry is a full `ItemFormDialog`. Informational fields belong in that
provider’s config schema inside the modal. **Add** is case-by-case: e.g.
Authentication → Addons filtered by capability; Training → add a credential
entry in-page — document the choice on the surface, do not invent a third
pattern.

**KPI strips.** Page-level metrics use `StatCard` inside `GRID_QUICK_STATS`.
Widget panels use `WidgetMetricCard` with the same geometry/tokens — not a
third metric card.

**Media grids.** Image / event / frame collections use library `MediaGrid`
(+ `MediaCard`), not a page-local `grid-cols-[repeat(auto-fill,…)]`.

**Dialogs.** `Dialog` + `DialogContent` (`width`, `placement="sheet-on-mobile"`,
`scroll="body"` for anything tall) + `DialogHeader` / `DialogBody` /
`DialogFooter`. `DialogContent` already paints a Close (X) — never add a
second Cancel in the header next to it (`ItemFormDialog` and NC editors follow
this; footer Cancel next to a primary Save/Create is fine). `ItemFormDialog`
owns body padding and `space-y-3` — fillers must not wrap children in an outer
padding/chrome div. A yes/no question is `useConfirm` (or
`ConfirmActionButton` for a destructive button), a single value `usePrompt`, a
notice `useAlert` — all under the host's `ConfirmDialogProvider`. Never
`window.confirm`.

**Fill-height managed lists.** When a section is mostly one DataTable with
internal scroll, use `SectionedPage` / `PageShell` `fill` + `DataTable fill`,
and list the route in `FULL_HEIGHT_ROUTES` (`AppLayout`) so `<main>` does not
also scroll. Add / New actions belong in the page `actions` header (per active
section), not a second toolbar inside the body — reference: Build, Integrations.

**Secrets.** A password, token or key is `PasswordInput`; a keychain-backed
setting is `SecretFieldControl` (a schema `secret` field renders it for you),
which never holds the stored value and reveals through the audited
`keychain-admin.reveal` given by `SecretRevealProvider`. Background:
`docs/architecture/secrets-keychain.md`.

**Pickers.** A node is `NodePicker` (hidden on a single-node cluster, offline
nodes disabled) or `NodeSelectField` in a form; devices are the one smart
picker, `DeviceSelectField` / `DeviceMultiSelectField` (D636). Selection that
should survive a reload goes in the URL with `replace: true`.

**One control per option set.** A control with a single option is not
rendered (a one-node cluster shows no node chips).

## An addon page ships no CSS: its classes come from the host build ([D747](../decisions/adr-0747-every-addon-page-package-is-scanned-by-the-admin-ui-tailwind-build.md))

`AddonPageLoader` loads an addon page's remote JavaScript and nothing else.
The page's own `dist/<pkg>.css` is never requested, so every utility class a
page uses must already be in the admin-ui stylesheet. Tailwind emits only
the classes it finds in scanned files, and `index.css` therefore has a
generated `@source` block with one entry for each package that declares
`camstack.addons[].pages`. The admin-ui scanned no page package until
2026-10-07, so classes like `gap-x-8` and `pl-1` produced no rule and Model
Studio's Installed card drew one label over another. Its dev server looked
fine because it loads the page's own CSS. A new page package needs
`tsx scripts/check-addon-page-css.ts --write`. That guard also fails on a
page-package stylesheet that declares `@theme`, `@utility` or
`@custom-variant`, since the host build never reads it.


## Field-learned UI facts

**A page that stacks N heavy details shows ONE, and puts the selection in the
URL.** The Cluster page rendered every node's `NodeCard` at once — six tabs, two
chart grids and a process list per node, all mounted. Nodes now uses the
library `NodePicker` (`packages/ui-library/src/composites/node-picker.tsx`)
with `allowOffline` and `alwaysShow`, and mounts one `NodeCard` below
(`pages/system/Cluster.tsx`). Three parts of that are the reusable bit:

- **The pills carry the fleet answer.** "Which node is unhealthy" and "what is
  wrong with this one" are different questions, so collapsing the first into
  the second would lose something. The strip stays the control that switches
  detail; online/offline counts sit above it, and an offline pill stays
  selectable so a dead agent is not a missing choice. Check this before
  replacing any stack with a selector; if the stack was answering a question
  the pills cannot, keep both.
- **The selection lives in `?node=`** (`replace: true`), the same idiom
  `AdminTabs` uses for `?tab=`. Component state would reset on every
  navigation, and an operator reloading while a node restarts would land back
  on the hub each time — worse than the stack it replaced. Resolution is
  `lib/node-url-selection.ts:resolveNodeSelection`, which is pure and tested: an
  id that names nothing falls through to the hub rather than rendering an empty
  page, and reports that it did (below).
- **A control with one option is not rendered — unless the page opts out.**
  `NodePicker` hides itself when there is only one node; Nodes passes
  `alwaysShow` so the strip stays a layout anchor. Addons keeps the default.

## Table conventions

**A list of manageable items is a REAL table that scrolls INSIDE its own
container.** That is the operator's rule, given after the Notification Center
shipped eight tabs of lists, and it decides three things at once:

- `<DataTable>`, never a `div` stack. The question asked of a rules / targets /
  deliveries list is always a per-column one ("which of these is on?", "which
  rule keeps failing?"), and a card cannot answer it.
- `maxBodyHeight` — one prop, `TABLE_SCROLL_MAX_H` unless the surface has a
  reason of its own. The rows scroll in the box; the page header, the filters
  and the New-… button stay where the operator left them. It also PINS the
  column header, because those are one decision: a capped table whose header
  scrolls away is a list of unlabelled cells.
- No narrow-window switch: `DataTable` never becomes a card stack, it scrolls
  sideways in its wrapper (supersedes the `auto` / `cards` modes of
  [D43](../decisions/adr-0043.md)).

The page NEVER scrolls sideways — `DataTable`'s wrapper is the horizontal
scroller too, and `AdminPage` is `overflow-x-clip` above it.

### A row that COLLAPSES has one implementation, not one per page

Two surfaces list a thing whose current contents belong under it rather than
beside it — `/integrations` (an integration's devices) and the device-export
panel. Both render `<DeviceList mode="generic">`: a caller supplies `getKey`,
`getSearchText`, a `DeviceListColumn[]`, and the `isExpanded` /
`renderExpanded` pair, and gets the shared search box, the type filter and the
pagination with it. Two tables with one job diverge; this repo has paid for
that shape before.

The integration pages (Connectivity, Remote Access, Mesh, TURN, Authentication,
Log destinations) were a third such table until 2026-10-08 — `AddonCollectionPage`,
one collapsible row per addon. They are a pill selector now; see
"Integration pages" below.

### What an export entry shows, and why the rest could go

`DeviceExportPanel`'s device table is device TYPE, NAME, EXPORT and a selection
box — not the device-mode row it used to be. The columns it dropped (Hardware,
Features, and the merged Preview cell with the live control, battery pills,
snapshot eye, reboot, PTZ and the reachability dot) are all reachable on
`/devices` and on the device's own page; **that** is what made them removable,
and it is the question to ask before removing a control anywhere else. The
Expose toggle stayed, and the row click still opens the device.

The table pages at **25** by default and the viewer picks 10 / 25 / 50 / 100 /
All under it ("Rows per page"), remembered in `localStorage` under
`camstack.device-export.pageSize` — its own key, not the Devices page's global
`camstack.device-list.pageSize` (25/50/100/200, default 50), so neither surface
inherits a size the other cannot show. The control is generic mode's
`pageSizeSelector` (`usePersistedPageSize` + `PageSizeSelect`, the same control
the device-mode table renders); a generic list without one keeps its fixed size
and shows no control.

Selecting rows exposes or unexposes them together. Every run — bulk or
single-row, both through one runner — ends in a summary naming the devices that
landed and the ones that did not, with the reason. A generic "export failed"
would make the operator re-run the whole set to find out which half worked; the
single-row toggle previously used `mutate` with no `onError` and reported
nothing at all.

### Sorting is a property of the COLUMN, and silence is an answer

`DataTable` sorts. A column opts in with `sortValue: (row) => string | number |
null` and the table owns the state (none → asc → desc → none, `aria-sort` on the
`<th>`, `defaultSort` to choose the opening order). The rules live in
`composites/table-sort.ts` and there is exactly one copy of them — the device
list, which had the app's only column sort, now delegates the toggle there and
keeps only its domain comparators.

Three of them decide whether a sorted table stays readable:

- **`sortValue` returns the RAW value, never the rendered one.** A byte count,
  not `formatBytes(…)`; a timestamp, not a locale string. "9 MB" sorts after
  "1 GB" as text.
- **`null` sorts LAST in both directions.** A missing value is *unknown*, not a
  value to reverse — flipping the column must never promote the rows with
  nothing to say.
- **A column with no meaningful order declares `notSortableReason` and stays
  static.** It renders no button and no `aria-sort`, and the reason reaches the
  operator as the header's `title`. This is not laziness: an argv blob sorts by
  interpreter path, a list of capabilities has no single value, and a cell that
  is a live `<select>` would move its own row out from under the cursor as the
  operator edits it. An ordering that looks authoritative and means nothing is
  worse than none — see
  [D249](../decisions/adr-0249-a-load-chart-shows-what-is-measured-per-camera-or-says-shared.md)
  for the same rule applied to charts.

A **status** column is sortable only where the surface already encodes a rank
— worst first, and the rank lives in a named constant next to the component
(`cluster/tabs/process-class-rank.ts`), never inline in a comparator.

### Controlled sort, pages and selection — still the one `DataTable`

Three opt-ins, all generic and specced in
`ui-library/src/composites/__tests__/data-table-paging-selection.test.tsx`:

- **`sort` + `onSortChange`** — the CONTROLLED form. Present (even `null`) =
  the owner holds the state and the table renders exactly that order, reporting
  header clicks without moving on its own. `defaultSort` stays the uncontrolled
  opening order.
- **`pageSize`** (+ optional controlled `page` / `onPageChange`,
  `paginationLabels`) — client-side pages with a `DataTablePager` under the
  table: a `<nav>` named after the table, the range in a polite live region,
  previous / next. Sorting happens FIRST, so page 1 is the head of the current
  order; a page past the end (the rows shrank) clamps to the last page
  (`paginateRows`). No pager when everything fits.
- **`selection`** — a leading checkbox column (`data-table-selection.tsx`),
  so it works in table and card layouts alike. The header box acts on the
  selectable rows of the page ON SCREEN only, an `isSelectable`-rejected row
  has no box, and keys of rows not on screen survive a page toggle. It needs
  `rowKey`; the caller owns the key set and decides what a bulk action does
  with it.

Filtering stays OUTSIDE the table (`useDataTableFilter` + `DataTableFilterBar`)
so the caller keeps the filtered rows a bulk action must act on. Beside the
single `facetValue` chip row it takes **`facetGroups`** — several independent
chip rows (Status / Owner / Kind), OR inside a group, AND across groups, a
chip nobody carries ignored — rendered by the bar as named `role="group"`s.

### Charts: the library chart family, never a hand-drawn one

Every chart over time is one of `@camstack/ui-library`'s chart family
(`packages/ui-library/src/composites/charts/`, uPlot underneath, D899):

| Need | Component |
| --- | --- |
| Gauges / counters over time (lines, min–max band, stacked parts of a total) | `TimeSeriesChart` |
| Boolean and enum states, with time spent in each | `StateTimeline` |
| Bucketed counts or deltas (kWh per hour, detections per 5 min), with a total | `BarSeries` (`compact` for a strip inside another control) |
| A trend beside a number in a row | `Sparkline` |
| A device's recorded history (sections, window, compare, ⋯ menu) | `DeviceHistoryView` |

Hand-drawn stays only what is not a chart over time: radial gauges, live
meters (waveform, VU), overlays, `CoverageTrack`. The rules the family
enforces — keep them when you feed it:

- **Colour is a categorical SLOT, never a hex.** `colorIndex` picks one of the
  eight `--color-chart-series-*` tokens (fixed order, validated in both
  themes); the caller keeps a series' slot stable across filters (by its
  identity, never its rank). Past eight a slot repeats with a dash.
- **An unknown sample BREAKS the path; so does a hole.** Give a sampled
  series its `gapMs` (`gapThresholdMs(cadence)`) and the hole is broken AND
  shaded; a change-only, held series has no `gapMs` (`interpolation: 'step'`).
  `null` is never drawn as `0`, and an empty answer is the empty state, never
  a flat line.
- **The x axis is WALL TIME**, and charts that answer the same question share
  a cursor (`syncKey`).
- **The selected point has one tooltip**, drawn by the shared chart host.
  Mouse hover moves it and leaving the plot hides it. A tap selects the
  nearest point; a finger drag scrubs along the series (vertical page scroll
  still works when the gesture starts vertical); a second tap or a tap
  outside hides it. Arrow keys move the selection while the chart is focused,
  and the same text is announced (`aria-live`). It stays inside the chart and
  flips at the edges. A line shows the time and each visible series' value
  with its unit (the stored base unit, through the quantity formatter and the
  display preference). A state shows its label and how long that span lasts.
  A bar shows the bucket's range and its value.
- **One unit per chart on a device surface.** Several value axes appear only
  where the reader chose what to overlay (System → History).
- **Pending, absent, empty are three screens** (`pending`, `emptyMessage`, and
  the caller's presence check — D315).
- **State a fact on the axis or in the caption, not both.** The Load tab's
  caption says what one point COVERS (`1 point = 40s (bucket MAXIMUM, not a
  mean)`) because no axis can.

If you are hand-rolling one anyway, this is the shape `DataTable` emits:

```tsx
<div className="rounded-lg border border-border max-h-[60vh] overflow-auto">
  <table className="w-full text-xs border-separate border-spacing-0">
    <thead className="bg-surface">
      <tr><th className="sticky top-0 z-10 bg-surface px-3 py-2 text-left">…</th></tr>
    </thead>
    …
  </table>
</div>
```

`border-separate border-spacing-0` is not cosmetic and only applies while the
header is pinned. Tailwind's preflight makes every table `border-collapse:
collapse`, and a collapsed table hands its cell borders to the TABLE — so a
sticky `th` keeps its background and loses the rule under it the moment the
first row slides beneath. Separated borders with zero spacing render
identically and belong to the cell. `sticky` goes on the `th`, not the `thead`.

A tab bar above scrolling content needs `sticky top-0 z-20`, an **opaque**
background (content scrolls under it) and `overflow-x-auto` with
`shrink-0 whitespace-nowrap` on the buttons, so narrow viewports scroll the tabs
instead of clipping or wrapping them. `<TabsList>` / `<TabsTrigger>` and
`AdminTabs` already carry this; a bare `flex flex-row` of buttons does not, and
past ~4 tabs on a phone it wraps the labels inside their own fixed-height box
and puts the last tabs somewhere unreachable.

## Integration pages: the usual header, icon + name pills, one integration on screen ([D774](../decisions/adr-0774-an-integration-page-shows-one-integration-chosen-from-icon-pills-and-its-address-is-in-the-url.md))

`components/integration-hub/IntegrationHub.tsx` is the ONE base for a page that
lists the integrations of a kind. Connectivity (`/system/integrations`) is an
`AdminSectionedPage` with one section per provider kind (Exporters, Email,
Brokers, Calendars); each section embeds a single-group `IntegrationHub`.
Other hubs: Network → Remote Access / Mesh Networks / TURN Servers, Identity →
Authentication, Identity → Tokens & sessions (credential kinds, not addons) and
Logs → Destinations.

- **Header.** `AdminPage`'s usual title + subtitle, and its `nav` slot carries
  the pills: one per integration, the addon's own `assets/icon.svg` next to its
  name, a status dot, and the state in WORDS whenever it is not healthy
  (`disabled`, `crashed`). Several groups (Connectivity's kinds) get a label
  column from `sm` up; every group ends with a dashed "+ Add …" pill linking the
  Addons catalog filtered to the capability. Pills wrap at every width — the
  Cluster chips' rule — so a phone never scrolls sideways.
- **Body.** Only the selected integration renders, keyed by its id.
  `AddonIntegrationBody` is the same for every addon-backed one: a slim status
  strip (Enabled badge, page badges, addon id; primary action, Enable/Disable,
  Restart), an optional unheaded `lead` block, the page's own panels
  (Connectivity → Connections, Mesh → Status, TURN → Discovered ICE servers,
  Authentication → About), **Settings**, **Activity**, and last the panels a
  page marks `placement: 'end'`. Settings and Activity stay on one scroll on
  purpose — the operator edits a setting while watching what the addon logs
  about it.
- **An exporter's devices table is the last element** (operator, 2026-10-08).
  Connectivity → Device export puts `DeviceExportPanel` at `placement: 'end'`
  with `showSetup={false}`, and renders the exporter's error and Setup block
  (HomeKit's pairing QR, Alexa's directive endpoint) as the `lead` through
  `DeviceExportSetup` — a long device list must not push the settings and
  activity off screen, and a pairing code must not sink under the logs.
  `?section=devices` still scrolls to the table; only its position changed.
  The addon card keeps the whole panel (`showSetup` defaults to true).
- **Settings are always the form builder.** `NodeAddonsSettingsPanel` for the
  addon's `globalSettingsSchema(cap)`, scoped to the page's capability. A page
  contributes panels, never a settings form. An addon whose cap-scoped schema
  would duplicate a page panel drops that section for that cap (mqtt-broker
  leaves `mqtt-broker-external` out under `broker`, because Connections edits
  the same `config.brokers`). The broker Add dialog's own fields (kind, name,
  restore under the original id) are a schema too
  (`brokers/broker-identity-schema.ts`).
- **An exporter's settings follow one layout** (D784): **Connection** (how the
  remote side reaches the hub), **Features** (what each exposed device
  carries), **Account link** (status and the one way to unlink, D104), and one
  **Troubleshooting** section with `style: 'accordion'`, `defaultCollapsed:
  true`; tuning knobs go in a collapsed **Advanced**. Every action is an
  `addon-action-button` with a `successMessage` — never a plain `type:
  'button'`, whose `ButtonField` shows neither the result nor the error — and an
  action with nothing to do throws a sentence the button shows. A row that
  belongs to one mode is absent in the other (Alexa's ingress token exists only
  for a custom skill). An address the remote side calls is an
  `addon-action-select` read live, not a cached list with a Refresh button. A
  one-shot argument (ids to delete) is asked by the button itself through
  `prompt: { param, title?, message?, placeholder? }`, which opens the shared
  prompt dialog and sends the answer as `input[param]` — never a saved field.
  Alexa (`addon-export-alexa/src/settings-schema.ts`) is the reference.

### Identity → Tokens & sessions is a hub of credential KINDS ([D819](../decisions/adr-0819-credentials-are-revoked-in-bulk-only-by-exact-ids-a-typed-count-and-never-the-callers-own.md))

`pages/system/Access.tsx` (`?tab=access`) merged the old Tokens tab (scoped
tokens, share links, admin tokens, the audit and legacy keys stacked on one
page) and the Linked Sessions tab into one `IntegrationHub`. A pill per kind,
grouped: **Sessions** (Login sessions, Linked apps), **Tokens** (Scoped tokens,
Admin tokens, Share links) and
**Identity** (Sign-in links, Audit). The pills carry no health dot
(`showState: false`: a kind is always "there"). `?tab=api-keys` and
`?tab=linked-sessions` redirect to `?tab=access&integration=scoped-tokens` /
`linked-apps` (`Identity.tsx`, `RETIRED_IDENTITY_TABS`).

Every body is `components/access/CredentialTable.tsx` over one row shape
(`credential-row.ts` maps each hub record): the SAME columns in the same order —
name · owner · kind / scope · status · created · last used · expires · actions
— the same Status / Owner / Kind chips and search, 25 rows a page, newest first,
rows scrolling inside the table under its pinned header (`TABLE_SCROLL_MAX_H`)
and sideways inside its own wrapper on a phone. Every
control is a library one (`Button`, `Input`, `Label`, `Checkbox` via the
selection column, `IconButton`, `ErrorBox`, `SectionCard`, `Badge`) and each
body has ONE notice region (`AccessSection`'s `notice`): a failed write and the
outcome of a bulk revoke land in the same line. "Never used" and "never expires" are `null` and sink to the
bottom of their column in both directions.

Bulk revoke exists only where the hub has an audited bulk call
(`auth.revokeCredentials`: login sessions, admin tokens, share links) and only
as **selection → preview → typed count → exact ids**. "Select all N shown" and
"Select expired" SELECT; nothing on a credential list evaluates a predicate and
revokes ("Revoke all never used" deleted all 167 share links on the hub on
2026-10-09). The bulk targets are the selected rows still on screen after the
filter; the caller's own session is never selectable. The confirmation is the
shared prompt dialog with `variant: 'danger'`, listing the first rows, a status
breakdown ("3 active, 137 expired") and a field that must hold the count.

### The address

`lib/integration-hub-url.ts` is the only spelling, and
`scripts/check-integration-hub-links.ts` refuses any other:

| Param | Meaning |
| --- | --- |
| `integration` | the addon id on screen; absent → the first one |
| `section` | a body section to scroll into view: `settings`, `activity`, or a panel id (`devices`, `connections`, `status`, `ice-servers`, `about`) |
| `tab` | NOT the hub's — the hosting `AdminTabs` id (`remote-access`, `mesh`, `turn`, `authentication`, `destinations`) |

`integrationHubHref('connectivity', { integration: 'export-alexa', section:
'settings' })` → `/system/integrations?integration=export-alexa&section=settings`.

- **Choosing a pill pushes history** (unlike `?node=` / `?tab=`, which replace):
  back/forward walks the integrations opened. Every other param survives.
- **A stale id falls back to the first integration AND says so**
  (`StaleIntegrationNotice`), but only once the list has answered — before
  that, "not installed" would be the D315 lie.
- **Connectivity section tabs** use `?tab=exporters|email|brokers|calendars`
  (SectionedPage). Legacy `?tab=device-export|email|broker` is remapped to the
  matching section; within a section the hub still owns `integration` /
  `section` via `INTEGRATION_HUB_OWNED_PARAMS`.
- **Leaving a hosting tab drops `integration` / `section`** — the tab's
  `ownedParams` is `INTEGRATION_HUB_OWNED_PARAMS`, and its id comes from
  `INTEGRATION_HUB_PAGES`, both checked by the guard.
- **Every section heading carries its own link** (the chain glyph), so an
  operator can paste "Alexa → Settings".

Message brokers are per ADDON on Connectivity (Home Assistant, Homematic, MQTT,
Matter, Alexa import): the body's Connections panel is `BrokerManager
addonId=…`, which lists only the connections that provider owns and offers only
its kinds.

## System is one page with tabs; a page with its own `?tab=` stays out

Until 2026-10-08 the sidebar's Administration section carried Secrets,
Capabilities, System (hub settings) and Terminal as four standalone entries.
The first three are now tabs of ONE page (Terminal stays standalone), `pages/system/System.tsx`, at the path the
"System" entry already used, `/system/settings`:

| Tab | `?tab=` | Content |
| --- | --- | --- |
| Settings (default) | `settings` | site location + the hub's addon settings |
| Secrets | `secrets` | the keychain (owns `?view=`, values or audit, inside the tab) |
| Capabilities | `capabilities` | registered capabilities, singleton providers |

The shell is `AdminTabs`, the same `?tab=` strip as Network, Identity, Data and
Logs. `lib/system-page-url.ts` is the one builder: `systemTabHref(tab, search)`
and `SYSTEM_LEGACY_ROUTES`, which App.tsx maps to `SystemTabRedirect` so
`/system/secrets` and `/system/capabilities` land on their
tab **keeping their query** (`/system/secrets?view=audit` →
`/system/settings?view=audit&tab=secrets`). `/system` redirects to the page.

What deliberately did NOT move in:

- **Pages that already own `?tab=`** — Network, Identity & Access, Data, Logs.
  Nesting one under another `?tab=` strip makes two strips fight over one
  parameter; a second param name for the inner strip would break every deep
  link those pages already hand out (`integrationHubHref` targets
  `?tab=remote-access`, `?tab=authentication`, `?tab=destinations`).
- **Cluster, Addons, AI** — their own sidebar section ("Cluster & Server"),
  and Cluster owns `?node=`.
- **Notifications, Calendars, Connectivity** — operator-authored content and
  integrations, not hub configuration.

The sidebar lost two entries (Secrets, Capabilities; Terminal stays its own entry by operator decision); global
search indexes the sidebar, so those two are reached through "System".
`pages/system/__tests__/system-page.spec.tsx` pins the tabs, the deep links,
the redirects and the sidebar.

## A tall dialog pins its chrome — `scroll="body"`

`<DialogContent>` scrolls itself by default (`scroll="content"`), which is right
for a short form and wrong for a long one: the title, the tab strip and the
Save/Cancel row travel with the fields, so the operator who scrolled to the
bottom of a six-tab rule editor has no way back to any of them except scrolling
the form he was reading.

`scroll="body"` makes the dialog a non-scrolling flex column and hands the
scrolling to `<DialogBody>`:

```tsx
<DialogContent width="lg" placement="sheet-on-mobile" scroll="body">
  <div className="shrink-0">…title, close…</div>
  <TabsList className="shrink-0" />          {/* above the scroller */}
  <DialogBody>…fields…</DialogBody>          {/* flex-1 min-h-0 overflow-y-auto */}
  <div className="shrink-0">…Save / Cancel…</div>
</DialogContent>
```

Three things that are easy to get wrong here, and the first one shipped:

- **A `max-height` is not a height, and the difference is invisible on
  desktop.** A top-layer `<dialog>` laid out as a flex column with only a cap
  has an AUTO height: it sizes to the sum of its items' contributions, and a
  `flex-1 min-h-0` item contributes its flex basis — `0%` — on iOS Safari.
  The body resolves to zero, any intermediate wrapper collapses with it, and
  the footer is laid out over children that overflow a box occupying no space.
  Desktop Chrome and desktop Safari contribute the content size instead and
  render it perfectly, so this reaches the operator's phone intact.

  `scroll="body"` therefore emits a DEFINITE height below `md`
  (`h-[92dvh]` for a sheet, the safe-viewport calc for a centred box) and
  `md:h-auto` above it. That is in the primitive; you get it for free. This
  repo has paid for it three times — `EventDetailPanel` and `PlateDetailPanel`
  each fixed it locally and neither fed it back, so `scroll="body"` shipped it
  again on 2026-08-14 (empty rule editor, Save row over the tab strip, iPhone
  at 390px). Those two still carry their own copy; folding them in is a
  migration, not a deletion.
- **`min-h-0` on the body is the other half.** A flex item's default
  `min-height: auto` refuses to shrink below its content, so without it the
  body pushes the footer out of the dialog instead of scrolling. Every
  intermediate wrapper between the dialog and the body — the `<Tabs>` that owns
  a tab strip, say — needs `flex-1 min-h-0` for the same reason.
- **Do not nest a `max-h-[Nvh] overflow-y-auto` inside a dialog.** Three
  Notification Center dialogs did, which meant two scrollbars, a title that
  could still be scrolled away, and a cap measured against the RAW viewport
  while the dialog's own cap subtracts the safe-area insets. One scroller, one
  cap.

None of this is testable in jsdom — `offsetHeight` is 0 for everything, so no
test here can measure a body or intersect two rectangles. `dialog-placement`
pins the DECISION instead (a body-scroll dialog is never height-auto below
`md`; the chrome is in flow, in order, and only the body is shrinkable), and
the height class is verified to survive twMerge. Check the built CSS actually
carries a new arbitrary value before believing it works —
`grep 'h-\[92dvh\]' packages/addon-admin-ui/dist/assets/*.css`.

## Composite-patterns census (pass 2, 2026-10-11)

Status against the design in
(planning repo: superpowers/specs/2026-10-11-admin-ui-composite-patterns-design.md).
`ok` = matches; `partial` = usable but not the shared shell; `gap` = managed
list / shell still wrong. AI profiles stay a **managed list** (not Training
provider pills). Multi-tab shells must not wrap `AdminTabs` in outer padding
Page + section template is **OSD Manager** / library `SectionedPage`: one
`PageShell` whose title and icon match the sidebar entry, then library `Tabs`
for sections. Admin-ui wires URL via `AdminSectionedPage` (react-router).
Section bodies are `embedded` (no second page chrome). Nested strips (Library →
Events) use `sectionsOnly`.

### Multi-tab shells

| Surface | Status | Notes |
| --- | --- | --- |
| Network / Identity / Data / Notifications / AI / Logs / System / My access | ok | `AdminSectionedPage` + sidebar chrome |
| Library / Build / Recordings | ok | Same shell (Library Events: `sectionsOnly`) |
| OSD Manager / Model Studio | ok | OSD: `SectionedPage` + DataTable/`ItemFormDialog` per section; Model Studio: `PageShell` + `Tabs`; sidebar icon via `ADDON_PAGE_ICON_MAP` |

### `/system/ai`

| Tab | Status | Notes |
| --- | --- | --- |
| Shell | ok (2026-10-21) | `useCapabilityPresence('llm')` gate; per-section subtitle and "Add profile" in the page header (an embedded `AdminPage` renders neither) |
| Profiles | ok (pass 2) | DataTable + `ItemFormDialog` + URL; delete via `useConfirm`. Editor / kind picker / model picker: redesign pending |
| Runtimes / Usage | ok (2026-10-21) | `SectionCard` + DataTable, skeleton → error → `EmptyState` inside the card; Usage window picker in the card header |
| Test | ok (2026-10-21) | Setup + Conversation `SectionCard`s; mode is `SegmentedChoice`; Clear in the Conversation header |

### Managed named collections

| Surface | Status |
| --- | --- |
| Scripts / Automations / OSD Templates / OSD Cameras / Training providers | ok |
| NC Sequences / People / Vehicles / Users create / Backup entries | ok |
| Storage locations | ok (exception — `LocationCard`, URL-owned wizard) |
| Access create / NC Rules·Targets / Scenes | ok (pass 2) |
| Training Jobs / Model Studio inventory | ok (pass 2) |
| Devices / Integrations (`DeviceList`) / Auth hub / Calendars | ok (exceptions) |

### Other

| Surface | Status |
| --- | --- |
| Pipeline / Cluster (Nodes) shell | ok |
| Addons install cards | ok (intentional, not named CRUD) |
| Backup encryption | ok (singleton card, LocationCard-style — not a managed list) |

**Singleton cards vs managed lists.** A surface that is one opt-in /
per-resource control panel — Storage's `LocationCard`, Backup's
`BackupEncryptionCard` — stays a card. It is not a named collection, so it
does not use `DataTable` + `ItemFormDialog`. Backup *entries* (schedules) are
the managed list on that page.

## A destructive cluster-wide change shows its whole diff, and applies exactly that ([D745](../decisions/adr-0745-best-settings-picks-one-detector-family-from-static-hardware-and-applies-only-the-confirmed-plan.md))

Pipeline → Cluster → **Auto tune** (`ClusterAutoTuneTab.tsx`) is the
pattern for an action that rewrites many nodes and cameras with no undo:

- the server answers a DRY RUN first (`planAutoTune`) — the decision per
  node and device, with the reasons as typed values, and every write it would
  make; the UI renders the reasons as text (`auto-tune-view-model.ts`) and
  never re-derives them;
- the confirmation lists every write, not a count;
- the mutation carries the plan's hash, and a `stale` answer replaces the plan
  on screen instead of being applied — the operator confirms what is written,
  never a plan the configuration has since moved away from;
- `useConfirm` (a string) is not enough for this: the dialog is built from
  `Dialog` + `DialogBody` with `scroll="body"`.
