---
title: UI conventions
applies-to:
  - packages/addon-admin-ui/src/components/device/IntercomPanel.tsx
  - packages/addon-admin-ui/src/components/form-builder/TabbedSettingsForm.tsx
  - packages/ui-library/src/lib/tailwind-variants.ts
  - packages/ui-library/src/lib/responsive.ts
  - packages/ui-library/src/index.ts
  - packages/ui-library/src/composites/__tests__/export-panel-scales-down.spec.ts
  - packages/ui-library/src/primitives/dialog.tsx
  - packages/ui-library/src/primitives/floating-panel.tsx
  - packages/ui-library/src/primitives/bottom-sheet.tsx
  - scripts/check-safe-area-overlays.ts
covers:
  - packages/addon-admin-ui/src/**
  - packages/ui-library/src/**
last-verified: 2026-10-09
---

# UI conventions

The rules every UI change in this repository follows — admin UI, ui-library and
addon pages. Part of [`docs/ui/`](README.md); the workflow that applies them is
the `camstack-ui` skill. Moved here from `docs/architecture/ui.md` on
2026-10-09 unchanged in substance; that page keeps the architecture.

## Use the library

Before building a panel, check `@camstack/ui-library` for it: `StreamPanel`,
`CameraStreamPlayer`, `AutotrackSection`, `DataTable`, `DeviceList`, `LogStream`,
`EventStream`, `NodePicker`, `PHASE_CONFIG`, `useDeviceWebrtc`,
`useDeviceDetections`. Do not fork a composite — extend it or add a prop.

Not everything shared-looking is in the library: `IntercomPanel` and
`TabbedSettingsForm` are admin-UI-local
(`packages/addon-admin-ui/src/components/device/IntercomPanel.tsx`,
`packages/addon-admin-ui/src/components/form-builder/TabbedSettingsForm.tsx`).
Check the library's barrel (`packages/ui-library/src/index.ts`) before importing
one by name.

## Field-learned rendering facts

**An icon is DATA; the renderer supplies the component.** A glyph baked into a
string on the server can never be drawn any other way. `enabledAudioClasses`
built each label as `${emoji} ${name}` server-side, so the admin drew the 25
sound classes as emoji while the viewer already drew the same taxonomy from the
lucide `EVENT_KIND_ICONS` set — two icon vocabularies for one taxonomy, and the
settings surface spoke the one nothing else did. A config option now carries
`ConfigOption.iconId` and each renderer maps it: `resolveEventKindIcon`
(`lucide-react`) on the web, the viewer's `lucide-react-native` map on native.
If you find yourself concatenating a glyph into a label, the glyph is being
chosen in the wrong package.

**One axis of `overflow` is never just one axis.** Per CSS Overflow, `visible` is
not combinable with `hidden` / `auto` / `scroll`: set one axis to any of those and
the other is promoted from `visible` to `auto`. The element becomes a scroll
container in **both** directions — and a scroll container silently disables
`position: sticky` for every descendant, because sticky resolves against the
nearest scrolling ancestor and a non-scrolling one never moves.

This has bitten three separate components here:

| Where | Written as | Consequence |
| --- | --- | --- |
| `NodeCard` | `overflow-hidden`, only to clip to the border radius | no sticky tab bar or table header inside the card |
| `AdminPage` | `overflow-x-hidden`, to stop the page h-scrolling | `FormSaveBar`'s `sticky bottom-0` never pinned, on every admin page |
| `SchemaTabBar` | `overflow-x-auto` below `md` | a one-row tab bar with two scrollbars |

Fixes, in order of preference: drop it (round the child instead, as `NodeCard`
does); use **`overflow-x-clip`**, which clips identically and *does* combine with
`visible`, so the other axis is left alone (`AdminPage`); or let the content wrap
so no overflow exists (`SchemaTabBar`).

**A collapsing panel height eats the scroll position.** Tab surfaces render only
the active panel, so a switch unmounts a tall panel and mounts a short one — and
the replacement's first frame is usually a loading stub. The scroll container's
`scrollHeight` collapses in one commit, the browser clamps `scrollTop` to ~0, and
when the query resolves the height returns but the position does not. That is the
"bounce" reported on mobile, where container-query forms are 3–5× taller and the
delta is correspondingly larger.

`StableTabPanel` fixes the cause: hold the outgoing height until the incoming
panel catches up, so nothing ever shrinks and there is no clamp to recover from.
Wrap any tab content that mounts a query-backed panel in it.

Note what does **not** work, because it looks obvious: measuring `offsetHeight` in
a layout effect keyed on the tab. Every effect runs after React has committed the
new children, so the DOM already reports the *incoming* height. The height must be
sampled continuously in post-paint callbacks, which lag by exactly one panel —
that lag is the mechanism.

**Do not refresh a time-ordered list under someone reading it.** The Events feed
invalidated on live pipeline activity, so new events entered at the top and the
card being examined slid down. `useEventsLiveRefresh({ paused })` keeps
subscribing and coalescing but defers *applying* the result while the operator is
engaged — a detail panel open, a selection in progress, or scrolled into the grid
(`useScrolledPast`) — then flushes on disengage, with a sticky "New events —
refresh" pill in the meantime. Refreshing a list only helps when nobody is using
it.

**`position: fixed` never sees the app shell's safe area.** `AppLayout` pads by
`env(safe-area-inset-*)` and `index.html` opts into `viewport-fit=cover`; both are
correct and neither reaches a `fixed` overlay, which resolves against the VIEWPORT
regardless of where it is mounted. `fixed top-4` is 16px from the PHYSICAL top of
the screen while `safe-area-inset-top` is ~47–59px on a notched iPhone — that is
the restart toast rendering over the iOS status-bar clock. So every
viewport-anchored surface spells its offset
`top-[calc(env(safe-area-inset-top)+1rem)]` (each term collapses to the old
literal where the insets are 0, so nothing moves off-notch), and a surface flush
with an edge absorbs the inset as PADDING instead — `bottom-sheet.tsx`,
`floating-panel.tsx` and `dialog.tsx`'s sheet variant, or the sheet's last row is
untappable. A dialog CENTRED on the viewport has to subtract **twice the larger**
inset from its height cap to clear both asymmetric edges at once.

This one is invisible in review (`top-4` looks obviously correct) and identical in
every desktop browser and every non-notched device, so it is a guard rather than a
convention. `scripts/check-safe-area-overlays.ts` scans
`packages/addon-admin-ui/src` and `packages/ui-library/src` for three shapes —
`fixed` + a bare edge token, `fixed bottom-0` with no bottom padding, and a
`100dvh`/`100vh` height cap that does not subtract the insets — and also fails if
`viewport-fit=cover` ever leaves `packages/addon-admin-ui/index.html`, without
which every `env()` in the tree silently resolves to 0. A `fixed inset-0` scrim
and viewport-centred `translate` positioning are deliberately not flagged. The
viewer is out of scope: it is React Native and solves this with
`react-native-safe-area-context`, not CSS.

## Narrow viewports

[D43](../decisions/adr-0043.md): a concession that only holds at desktop width is
a token in `lib/responsive.ts` carrying its own breakpoint, consumed by a
primitive. `sticky`, a fixed label width and `truncate` never appear
unconditionally in a shared component.

| Want | Use | Below the breakpoint |
| --- | --- | --- |
| A label/value settings row | `<SettingRow>` | stacks at `sm`: label above, value full-width, wrapping |
| A device table | `<DeviceList>` | the NAME pin is off below `md`, the column scrolls with the rest and the name is never cut |
| Any other table | `<DataTable>` | ≥ 4 columns become one card per row; fewer keep their rows |

**Horizontal padding COMPOUNDS, so a nested container states it responsively.**
No single value has to be large for this to bite: `AdminPage`'s `p-4`, an
expanded panel's own `p-4` and its rows' `px-4` are three layers of 16 px a
side, which on a 320 px phone is **96 px — 30% of the viewport** — spent on
margins before any content, and invisible on a desktop. The operator reported it
on Connectivity → Export, 2026-09-10. Write `p-2 sm:p-4`: a bare `px-4` inside a
shared component is a desktop measurement wearing no qualifier, and
`composites/__tests__/export-panel-scales-down.spec.ts` refuses one.

**A badge whose text length varies with the DATA cannot define a column.** The
storage rows put the provider id (`FILESYSTEM-STORAGE`, eighteen characters;
`SMB-STORAGE`, eleven) at the head of a flex line, so every row's name, path and
capacity bar started wherever that row's badge happened to end — a staircase
where a scale was meant. Put the badge in a fixed slot and let it keep its own
size inside it; stretching a short badge to the longest id draws a box mostly
made of air. Reserve the slot at `sm:` only: on a phone the row wraps anyway and
128 px of label column is 40% of the viewport.

`DataTable` is always a table: on a phone it scrolls sideways inside its own
container and the page body never moves. There is no card mode and no switch
for one — a card list loses the column alignment the table exists for.
**Never** answer "wide table on a phone" with a smaller font or a card stack.
See "Table conventions" in [admin-patterns.md](admin-patterns.md#table-conventions)
for `maxBodyHeight`.

The device table's pin sits at `md` for a reason worth keeping: below `md` every
optional column has already folded away (`COLUMN_BREAKPOINT_CLASS`), so a pinned
NAME holds its width against nothing and pushes the remaining column off-screen.
A sticky first column earns its keep only where the other columns still fit
beside it.

**Making a name FIT is not the same as making it readable.** The first pass at
that pin also narrowed the NAME column below `md` (`w-44 max-w-[11rem]`) so NAME
+ Preview would fit a phone with no horizontal scroll at all. The result was
every camera rendering as "Camera ve…" / "Camera co…" — not a
shortened name, no name, and rows that could not be told apart. The operator's
call was explicit: show the whole name, and pay for it in sideways scroll.

So `md` is now the breakpoint for the *truncation* too
(`NAME_COLUMN_TRUNCATE_BREAKPOINT`). Below it the column carries no width cap
and the name carries `whitespace-nowrap` with no ellipsis
(`NAME_TEXT_CLASS = 'whitespace-nowrap md:truncate'`), so the name sizes its own
column, the table exceeds the viewport, and `TableLayout`'s existing
`overflow-x-auto` wrapper — **one** scroll context for the whole body, never one
per row, so every column stays under its header — carries it. From `md` up
nothing changed.

Two things learned measuring this in a real engine, both counter-intuitive
enough to be worth writing down:

- The only two utilities that were cutting the name are `truncate` and the
  width cap. `min-w-0` and `overflow-hidden` on the cell and on the header's
  flex chain are **inert** once the column is uncapped — an auto-layout table
  cell sizes to its content's min-content width regardless — so they stay
  unconditional, and they keep clipping (rather than overlapping the Preview
  column) as the failure mode if anything ever squeezes the column again.
- The secondary lines in the same cell (`#id · stableId`, "Under: <parent>",
  and the badge's own `max-w-full`) follow the same policy via `nameOverflow`.
  A full name sitting above an ellipsised parent badge reads as a rendering
  bug, not as a deliberate hierarchy.

`nameOverflow` is a prop on `DeviceItemHeader` and defaults to `'truncate'`:
the card layouts are width-bounded boxes with nowhere to scroll to, and the
stacked card already answers a long name by wrapping to two lines.

Test the DECISION, not the class string. `lib/tailwind-variants.ts` gives
`hasUnconditionalClass` / `hasVariantClass`, so an assertion reads "the name
column is not pinned at every width" instead of freezing a `className` — see
"Frozen-string tests have an expiry date" below for why the literal form goes bad.

## Frozen-string tests have an expiry date

`dialog-placement.test.tsx` asserts the dialog's center class set byte-for-byte. It
was written to guard one migration — adding a `placement` prop must not change the
existing output — and that migration landed long ago. What it guards now is
accidental churn, which is still worth guarding.

But a frozen literal cannot tell a deliberate change from an accidental one. When
`[&:not([open])]:hidden` was added to the primitive and the literal was not, the
result was two permanently red tests whose failure read as unrelated breakage. If
you write one of these, say in the file what it guards *now* and that the literal
moves in the same commit as any intentional change.

## Confirmation copy

Say what will happen, in one sentence. Do not explain the subsystem.

> Install `{{pkg}}@{{version}}` on "{{node}}" and restart to apply.

Not a paragraph about how updates work. And never describe a safety net that does
not exist — the update confirm promised an automatic rollback for a while after
[D17](../decisions/adr-0017.md) removed it.

When a server capability is removed, remove the UI that consumed it. Dead controls
are worse than absent ones: they tell the operator a feature exists.
