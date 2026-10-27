---
title: UI anti-patterns
last-verified: 2026-10-09
---

# UI anti-patterns

The off-system shapes that exist in the tree today, each with what replaces
it. `npm run ui:check -- <files>` finds every one of them and names the
replacement in the finding. Existing drift is paid down **on touch**: a file
you edit leaves with no new findings, and the ones already there go when the
surrounding code is being changed anyway (operator decision, 2026-10-09). It
is never a CI gate. A deliberate high-signal batch (name collisions, hand-rolled
dialogs, status tokens, daily paths) is planned in
[`docs/design/2026-10-09-ui-style-paydown-plan.md`](../design/2026-10-09-ui-style-paydown-plan.md).

## Baseline (2026-10-09 night, after P0–P3 paydown)

`ui:check --summary` on `packages/` (1,156 files), findings / files:

| Rule | admin-ui | ui-library | other packages | Replace with |
| --- | --- | --- | --- | --- |
| `palette-class` | 332 / 41 | 383 / 46 | 47 | `text-danger`, `bg-success/10`, `border-border` … |
| `raw-button` | 445 / 165 | 300 / 111 | 92 | `Button`, `IconButton` |
| `raw-hex` | 45 / 7 | 106 / 15 | 55 | a token; `var(--color-*)` in SVG |
| `inline-style` | 50 / 28 | 129 / 48 | 20 | utilities; style only for computed geometry |
| `raw-select` | 42 / 29 | 41 / 27 | 18 | `Select`, `NodePicker`, `DeviceSelectField` |
| `raw-dialog` | 0 | 1 / 1 | 4 | `Dialog` + `DialogContent`, `useConfirm` |
| `raw-table` | 13 / 12 | 6 / 6 | 1 | `DataTable`, `DeviceList mode="generic"` |
| `raw-color-fn` | 1 / 1 | 11 / 8 | 0 | a token with an opacity modifier |
| `shadows-library` | 0 | — | 0 | the library export, or a prop on it |

Total: 2,142 findings in 413 of 1,156 UI files. A `raw-button` in the library
is often legitimate (a primitive's own internals, a chip that is a button);
mark a deliberate one `ui-check-ok: <reason>` rather than leaving it to read
as drift. P0 cleared every admin-ui `shadows-library` hit; P1 cleared every
admin-ui `raw-dialog`; P2 cleared palette classes on AlertBell / ToastContainer /
CopyUrlChips; P3 cleared palette-class + raw-hex on Cluster (incl. load-chart
tokens), System Capabilities / mesh badges, Integrations hub chrome, Events
list / track overlay, and Model Studio surfaces.

## The shapes, with real files

**A hand-rolled modal.** `fixed inset-0 … bg-background/80` plus a raw
`<button onClick={onClose}>` for the close. Admin-ui P1 cleared the fleet
(NewExportModal, BackupEncryptionCard, IntegrationDetail, …). Remainders live
in addon pages (e.g. `addon-model-studio` ImportProgressModal /
InstalledSettingsModal) and one library false-positive on
`confirm-dialog.tsx`. It has no focus trap, no Esc, no safe-area handling and
no sheet on mobile.
→ `Dialog` + `DialogContent` (`placement="sheet-on-mobile"`,
`scroll="body"` when tall); the close is the dialog's own.

**An inline two-step delete.** A `confirmDelete` / `confirming` /
`pendingDelete` state that swaps the row's buttons for "Delete this X? /
Delete / Cancel" in place (the Custom devices, Scripts and Automations rows,
the batch toolbar and the scene reference gallery did this). It shifts the
layout, is easy to click through, and does not name what is destroyed on a
phone. `ui:check` flags the state hook as `inline-confirm-state`.
→ `useConfirm` (`@camstack/ui-library`): `await confirm({ title, message:
<names the item>, confirmLabel, variant: 'danger' })`; example
`useConfirmRemove` in `components/device/customize/`.

**Palette colours for status.** A palette hue does not follow the theme —
the `dark:` pair is the tell — and it says nothing about meaning. Global
chrome (AlertBell / ToastContainer / CopyUrlChips) was paid in P2; page-local
status colours remain on touch.
→ `text-info` / `text-success` / `text-warning` / `text-danger`, and
`bg-danger/10` for a tinted box (one class, both themes).

**Raw hex in a component.** Load-chart series and event-track overlays now
read `var(--color-chart-series-*)` / `var(--color-warning|info|success|danger)`.
Remainders include `packages/addon-admin-ui/src/components/addons/AddonCard.tsx`.
→ a token, read as `var(--color-…)` where the value has to be a string (SVG
`stroke`, canvas). A terminal emulator's 16-colour palette (`TerminalPanel.tsx`)
is the kind of exception that earns a `ui-check-ok` with its reason.

**A local component with a library component's name.** Two components with
one name and two looks is how a page drifts from its neighbours. → use the
library's; if it lacks something, add a prop there; if the local thing is a
different UX under the same name, rename it (P0: `NodeScopePicker`,
`CredentialStatusBadge`). Admin-ui P0 cleared the listed shadows
(`StatusBadge`, `FloatingPanel`, scope `NodePicker`, overview `StatCard`).
(`shared/DetectionOverlay.tsx` is a re-export of the library's and is fine.)
A private `StatCard` still lives in
`addon-pipeline-orchestrator/.../PipelineQuickStats.tsx` — migrate when that
widget is next touched (library already accepts `icon` / `subtext` /
`valueClassName`).

**A raw `<table>` for a managed list.** `packages/addon-admin-ui/src/components/backup/BackupRunsPanel.tsx`,
`packages/addon-admin-ui/src/components/pipeline/tabs/NodeEnginesTab.tsx`.
→ `DataTable` — it brings the pinned header, the inner scroll
(`maxBodyHeight`), sorting, the mobile layout and the filter bar.

**A `div` stack for a list someone manages.** The Notification Center shipped
eight tabs of them; the operator's rule since is a real table that scrolls in
its own box ([admin-patterns.md](admin-patterns.md#table-conventions)).

**N heavy details at once instead of a selector.** The Cluster page mounted
every node's card; it is a selector with the selection in `?node=` now
([admin-patterns.md](admin-patterns.md#field-learned-ui-facts)).

**A nested `?tab=` strip.** A page that owns `?tab=` stays out of another
`AdminTabs` page ([admin-patterns.md](admin-patterns.md#system-is-one-page-with-tabs-a-page-with-its-own-tab-stays-out)).

**Unconditional `sticky`, `truncate` or a fixed label width in a shared
component** (D43) — each needs its breakpoint
([conventions.md](conventions.md#narrow-viewports)).

**`overflow-x-hidden` to stop a page scrolling sideways.** It makes a scroll
container and kills every `sticky` inside; use `overflow-x-clip`
([conventions.md](conventions.md#field-learned-rendering-facts)).

## Viewer

The viewer repository measures its own drift (`npm run ui:check -- src` there):
raw hex outside `src/theme/tokens.ts`, named colours, a raw React Native
`Modal` where `SheetModal` exists, `Alert.alert` where `confirm.tsx` exists.
Its baseline is in the viewer repository, `camstack/docs/ui-check.md`.
