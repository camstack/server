---
name: camstack-ui-viewer
description: CamStack viewer UI — the Expo / React Native app in the `camstack/` submodule (github.com/camstack/viewer) and its browser `embed/` player. Use with camstack-ui when adding or changing a viewer screen, sheet, settings row, event/timeline view or the embed player, or when touching viewer colours, tokens.ts, SheetModal, PickerSheet or locales. A viewer LAYOUT change must be co-designed with the operator — ask first.
---

# CamStack UI — the viewer

Load the umbrella first: `camstack-ui` (`.claude/skills/camstack-ui/SKILL.md`)
owns the workflow, the token map and the done-gate. Rules in full:
`docs/ui/viewer.md`. The viewer is a SEPARATE repository — its own
`AGENTS.md`, its own `npm run ui:find` / `ui:check`, its own commits.

## Stop: is this a layout change?

**Viewer layout changes are co-designed with the operator — ask before you
restructure a screen.** Moving or regrouping controls, adding or removing a
section, changing a screen's hierarchy or navigation, replacing a component
with a different-looking one: describe the change (before/after, a sketch)
and WAIT for the operator. Not layout: a bug fix, a token/colour fix, an i18n
string, a change the operator already specified. Record the answer in the
done-gate's `viewer rule:` line.

## The kit — `src/components/ui/`

| Need | Use |
| --- | --- |
| Settings group / row | `Section`, `Row` |
| Switch / choice / number | `ToggleRow`, `SelectRow`, `StepperRow` |
| Segments, tabs | `SegmentedControl`, `SegmentBlock` |
| Any modal | `SheetModal` — bottom sheet on iOS/Android, centred dialog on the web, decided once by `sheetPresentation`. Never a raw `Modal` from `react-native` |
| Pick from a list (searchable) | `PickerSheet`, `PickerSheetButton` |
| Confirm / notice / prompt | `useConfirm`, `useNotice`, `usePrompt` (`confirm.tsx`, under `ConfirmProvider`) — never `Alert.alert` |
| Menu / dropdown | `AnchoredMenu`, `AnchoredDropdown` |
| Filters | `FilterChip`, `ChipMultiselect`, `ScopeBar` |
| Loading / progress | `SkeletonBox`, `ProgressStrip`, `ConnectingIndicator` |
| Crash boundary | `RenderErrorBoundary` |
| Screen header | `ScreenHeader` (`src/components/ScreenHeader.tsx`) |

Search before building: `npm run ui:find -- "<need>"` in the viewer repo.

## Tokens — `src/theme/tokens.ts`

- Colours come from `useTheme().colors` (`src/theme/theme-provider.tsx`) at
  render; `StyleSheet.create` holds layout only. No hex, `rgb()` or named
  colour (`'white'`, `'red'`) outside `tokens.ts`.
- Spacing / radius / type: `SPACING`, `RADIUS`, `TYPOGRAPHY`, `TABULAR` (for
  ticking digits); activity colours: `BAND`.
- The palette is the web theme's key for key (umbrella §4). A new colour goes
  into `tokens.ts` AND `packages/ui-library/src/tailwind/camstack-theme.css`
  (two repositories, two commits).

## Platform rules

- **Icons:** `lucide-react-native` only through `src/lib/icons.ts` (the barrel
  is refused by `camstack/scripts/check-icon-imports.mjs`).
- **Values from `@camstack/types`** come from `@camstack/types/client` (or
  `/enums`); the bare entry is `import type` only.
- **i18n:** every user-facing string is `t('…')` with a key in BOTH
  `locales/en.json` and `locales/it.json`. No decision ids in UI text.
- **Data:** TanStack Query hooks in `src/data/` over the hub tRPC API; client
  state in Zustand (`src/store/`).
- **The embed player (`embed/`) is web code:** Vite + Tailwind + the SAME
  `camstack-theme.css` and `@camstack/ui-library` composites as the admin UI,
  so the `camstack-ui-admin` styling rules apply there.

## Verify

- **Before every commit (and before push) — `npm run verify:push` GREEN** in
  the viewer checkout (`camstack/`). Mirrors the server’s `verify:push`: it
  takes the changed set (merge-base with `origin/main` + working tree) and
  runs the TypeScript Check gates — `ts-check`, full `test:v2`, native-deps
  when lock/config moved, embed web+ota build when `embed/` moved — plus
  `ui:check` on the changed UI sources. A single green vitest file or a local
  `tsc` is NOT the gate (wiring specs that `readFileSync` a sibling source
  are how TypeScript Check went red on every OTA of 2026-10-19).
- `npm run test:embed` in addition when you touched `embed/` and want the
  browser suite beyond the build gate.
- Look at it on the iOS simulator / Android emulator and the web build at
  ≈390 px and desktop, dark and light. A sheet is a sheet on the phone and a
  centred dialog on the web.
- `npm run ui:shots` (camstack-server) is admin-ui only today. The same
  Playwright measurement could drive the viewer's web build (`npm run web`
  in the viewer repo) with a fixture-backed hub client; not built yet — until
  then measure the web build by hand at ≈390 px and desktop.
- Do NOT ship as part of a UI change: no `update:patch` (OTA), no store
  build, no `build:orchestrator` — shipping is the operator's call.
