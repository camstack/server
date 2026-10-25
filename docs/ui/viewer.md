---
title: The viewer's UI
last-verified: 2026-10-21
---

# The viewer's UI

The viewer is the universal client (iOS, Android, web/PWA): Expo + React
Native, in the `camstack/` submodule, which is its own repository
(`github.com/camstack/viewer`). Its rules mirror the admin UI's, with a
different kit. The workflow is the `camstack-ui-viewer` skill; the viewer
repo's `AGENTS.md` points at the same skill and carries its own catalogue and
`npm run ui:check`.

## The co-design rule comes first

**A viewer layout change is co-designed with the operator — ask before you
restructure a screen.** Moving controls, changing a screen's hierarchy,
adding or removing a section, changing navigation: propose it (a sketch or a
written before/after) and wait. A bug fix, a token fix, an i18n string or a
change the operator has already specified is not a layout change. This is the
one rule the admin UI does not share; it is the operator's standing
instruction for the viewer.

## The kit

`camstack/src/components/ui/` — use these before writing a `View` with
styles:

| Need | Component |
| --- | --- |
| A settings group / a row in it | `Section`, `Row` |
| A switch, a choice, a number | `ToggleRow`, `SelectRow`, `StepperRow` |
| Tabs / segments | `SegmentedControl`, `SegmentBlock` |
| Any modal sheet | `SheetModal` — a bottom sheet on iOS / Android, a centred dialog on the web (`sheetPresentation`); never a raw React Native `Modal` |
| Pick from a list, with search | `PickerSheet` (+ `PickerSheetButton`) |
| Confirm / tell / ask | `useConfirm`, `useNotice`, `usePrompt` from `confirm.tsx` (under `ConfirmProvider`) |
| A menu / a dropdown | `AnchoredMenu`, `AnchoredDropdown` — drawn on `GlassSurface` (`bar` wash), so every menu is the tab bar's material |
| A Library page's header | `LibraryFilterBar` — chips, then sort (⇅), `⋯` (`HeaderOverflowMenu` items via `more`) and the primary "+" (`primary`) in ONE row, the count as `summary` |
| A Library grid tile | `LibraryTile` + `useLibraryGrid` (`library-grid.ts`: 2 / 3 / 4 / 5 columns by list width; People: `shape="square"` + the events column rule) |
| Filter chips | `FilterChip`, `ChipMultiselect`, `ScopeBar` |
| Loading / progress / connecting | `SkeletonBox`, `ProgressStrip`, `ConnectingIndicator` |
| A crash boundary | `RenderErrorBoundary` |
| A tooltip | `Tooltip` |
| A screen header | `ScreenHeader` (`src/components/ScreenHeader.tsx`) |

The full list, with props, is the viewer repo's catalogue (`npm run ui:find`
there).

### The Library pattern (agreed with the operator, 2026-10-21)

Every Library section (Media, People, Plates, Retrain; Events shares the
header) is the same three things under the scope bar: ONE header row
(`LibraryFilterBar` — no second app bar, no lone sort row), the count line,
and a grid of `LibraryTile`s whose column count comes from `library-grid.ts`
and nowhere else. A tile is a 16:9 image (subject centred, `cover`) with when
· where on it, an optional confidence / progress bar on its bottom edge, and
one row: title, state badge, action. A tile without an image is the
placeholder (icon + "No image"), never an empty box; a still-loading source
is a skeleton. A grid's bottom padding is `LIBRARY_GRID_BOTTOM_PADDING` through
`useTabScrollPadding`, so the floating tab bar never covers the last row.
People is the one exception (operator, 2026-10-22): its tiles are SQUARE, the
events gallery's tile (`LibraryTile shape="square"`), and the grid packs by
the events column rule (`useLibraryGrid({ kind: 'events', density })`, the
operator's events density) — Media, Plates and Retrain stay 16:9 on the
Library rule.

## Tokens

`camstack/src/theme/tokens.ts` is the viewer's palette — `ColorTokens` for
dark and light, plus `RADIUS`, `SPACING`, `TYPOGRAPHY`, `TABULAR` and `BAND`.
A component reads colours through `useTheme().colors` (`src/theme/theme-provider.tsx`)
so it follows the theme preference; a `StyleSheet.create` holds layout only,
and colours are applied from `colors` at render. No hex outside `tokens.ts`.

The palette is the web theme's, key for key (`foreground-muted` ↔
`foregroundMuted`): see [common-components.md](common-components.md#tokens-one-palette-two-spellings)
and `npm run ui:tokens`. A new colour goes into BOTH files.

## Icons

Icons are `lucide-react-native`, imported only through `src/lib/icons.ts` —
the package root is a barrel Metro cannot tree-shake, and
`camstack/scripts/check-icon-imports.mjs` (in the viewer's `ts-check`) refuses it. An
icon chosen by data (an event kind, an audio class) is an id the server sends
and the viewer maps; a glyph is never concatenated into a label.

## i18n: English and Italian, always both

Every user-facing string goes through `react-i18next` (`t('…')`) with a key in
BOTH `locales/en.json` and `locales/it.json`. A string in one file only, or a
literal in JSX, is a bug. No decision ids (`D123`) in user-facing text.

## The embed player is web code

`camstack/embed/` is the browser player (live, grid, events, recordings,
scrub) used by the native app as OTA HTML, by the web build and by iframe
integrations. It is Vite + Tailwind and imports the SAME
`camstack-theme.css` and `@camstack/ui-library` composites as the admin UI, so
the web rules apply there: tokens as utilities, library components, no palette
classes. `npm run test:embed` runs its suite; `npm run sync:embed` builds the
artefacts.

## Verify

- **Before every commit/push:** `npm run verify:push` GREEN (TypeScript Check
  gates on the changed set + `ui:check` on touched UI files) —
  `camstack-ui-viewer`.
- `npm run ts-check` and `npm run test:v2` (unit), `npm run test:embed` for
  `embed/`.
- `npm run ui:check -- <files>` in the viewer repo.
- Look at it: iOS simulator or Android emulator, and the web build at phone
  width (≈ 390 px) and desktop, in dark and light. A sheet must be a sheet on
  the phone and a centred dialog on the web.
- Shipping (OTA, store build, the web bundle in the hub) is NOT part of a UI
  change — it is the operator's call.
