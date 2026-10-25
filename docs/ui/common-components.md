---
title: Common components and tokens
applies-to:
  - packages/ui-library/src/tailwind/camstack-theme.css
  - packages/ui-library/src/theme/theme-provider.tsx
  - packages/ui-library/src/lib/responsive.ts
  - packages/ui-library/src/primitives/index.ts
covers:
  - packages/ui-library/src/**
last-verified: 2026-10-09
---

# Common components and tokens

What already exists, so nothing is built twice. The full, current list is
generated — `docs/reference/ui-components.json`, searched with
`npm run ui:find -- "<need>"` and read with `npm run ui:show -- <Name>`. This
page is the map of it and the one thing the catalogue cannot hold: how the two
clients' tokens correspond.

## Where components live

| Tree | What | Import |
| --- | --- | --- |
| `packages/ui-library/src/primitives/` | `Button`, `IconButton`, `Badge`, `Card`, `CollapsibleCard`, `Input`, `Select`, `Checkbox`, `Switch`, `PasswordInput`, `Dialog` (+ `DialogContent`, `DialogHeader`, `DialogBody`, `DialogFooter`, `DialogTitle`, `DialogDescription`), `Dropdown`, `Tooltip`, `Popover`, `Tabs`, `ScrollArea`, `Separator`, `Skeleton`, `FloatingPanel`, `MobileDrawer`, `BottomSheet` | `@camstack/ui-library` |
| `packages/ui-library/src/composites/` | everything built from those: `DataTable`, `DeviceList`, `SettingRow`, `SectionCard`, `ConfigFormBuilder`, `NodePicker`, `DeviceSelectField`, `ConfirmActionButton`, `EmptyState`, `ErrorBox`, `StatusBadge`, `KebabMenu`, `CameraStreamPlayer`, … | `@camstack/ui-library` |
| `packages/ui-library/src/hooks/` | data hooks: `useClusterNodes`, `useClusterTopology`, `useCapabilityPresence`, `useDeviceWebrtc`, `usePersistedPageSize`, … | `@camstack/ui-library` |
| `packages/ui-library/src/lib/` | `cn`, `hubPath` and the mount readers, the responsive tokens (`SECTION_CARD`, `SECTION_BODY`, `STACK_GAP`, `LIST_ROW`, …) | `@camstack/ui-library` |
| `packages/addon-admin-ui/src/components/` | admin-ui-LOCAL: `AdminPage`, `AdminTabs`, `StableTabPanel`, `integration-hub/IntegrationHub.tsx`, `IntercomPanel`, `TabbedSettingsForm` | relative import, admin-ui only |
| `camstack/src/components/ui/` (viewer repo) | the React Native kit: `Section`, `Row`, `ToggleRow`, `SelectRow`, `StepperRow`, `SegmentedControl`, `SheetModal`, `PickerSheet`, `AnchoredMenu`, `AnchoredDropdown`, `confirm.tsx` | relative import, viewer only |

An addon page can import only the library: admin-ui-local components are not
reachable from a Module Federation remote. A component two packages need moves
INTO the library — it is never copied.

`@camstack/ui-library` is host-provided (D15): the admin UI shares its copy
with every addon page and widget, so a library change reaches an addon page
only once the host's library is published and deployed.

## Tokens: one palette, two spellings

The web theme is `packages/ui-library/src/tailwind/camstack-theme.css`
(`@theme` registers the tokens so Tailwind generates `bg-*`, `text-*`,
`border-*`, `ring-*` utilities; `.dark` / `.light` on `<html>`, set by
`ThemeProvider`, switch the values). The viewer's is `src/theme/tokens.ts` in
the viewer repo (`ColorTokens`, read through `useTheme().colors`). They are the
same palette: the CSS name `foreground-muted` is the viewer key
`foregroundMuted`, with the same dark and light values.

| Web utility root | Viewer key | Use for |
| --- | --- | --- |
| `primary`, `primary-foreground` | `primary`, `primaryForeground` | the one accent; text on it |
| `background`, `background-elevated` | `background`, `backgroundElevated` | the page; a raised layer |
| `surface`, `surface-hover` | `surface`, `surfaceHover` | cards, rows; their hover |
| `border`, `border-subtle` | `border`, `borderSubtle` | dividers and outlines |
| `foreground`, `foreground-muted`, `foreground-subtle`, `foreground-disabled` | `foreground`, `foregroundMuted`, `foregroundSubtle`, `foregroundDisabled` | text, from primary to inert |
| `success`, `warning`, `danger`, `info` | `success`, `warning`, `danger`, `info` | status — never a palette hue |
| `<s>-fill` + `<s>-on` for `s` in `success`, `warning`, `danger`, `info`, `primary`, `neutral` | `<s>Fill` + `<s>On` | a FILLED status chip: opaque background and the text put on it (>= 4.5:1 in both themes; the light fills are darker than the status text colour). `Badge style="fill"`; the retrain-review verdicts are `RetrainReviewBadge` |
| `provider-onvif`, `provider-hikvision`, `provider-reolink`, `provider-ha`, `provider-rtsp` | — | web only: provider identity colours |
| — | `live` | viewer only: the LIVE-edge accent, distinct from `danger` |

The values are deliberately not repeated here: `npm run ui:tokens` prints both
sides from their sources and marks any key whose values differ as DRIFT. A
colour that neither side has is ADDED to both files in the same piece of work
(the viewer is a separate repository, so that is two commits) — it is never
inlined as a hex.

Radii are shared too: `rounded-sm|md|lg|xl` (4 / 6 / 8 / 12 px) on the web,
`RADIUS.sm|md|lg|xl` in the viewer. Spacing is Tailwind's scale on the web and
`SPACING` in the viewer; typography is the platform font in both, with
`TYPOGRAPHY` sizes in the viewer.

Opacity is a modifier on the token (`bg-danger/10`, `border-success/40`), not
a new colour. In an SVG or a canvas, read the CSS variable
(`var(--color-danger)`) so the drawing follows the theme.

## Responsive tokens

`packages/ui-library/src/lib/responsive.ts` holds the padding and gap strings
the shared composites use (`SECTION_CARD`, `SECTION_HEADER`, `SECTION_BODY`,
`STACK_GAP`, `GRID_GAP`, `LIST_ROW`, …), each carrying its own breakpoint. Use
them instead of re-deriving `p-2 sm:p-3 lg:p-4` by hand; why padding must be
responsive is in [conventions.md](conventions.md#narrow-viewports).
