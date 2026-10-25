---
name: camstack-ui
description: Load FIRST for any CamStack UI work — a new or changed admin-ui page, a ui-library component, an addon page (Model Studio, Benchmark, OSD, Training), a widget, a viewer screen or the embed player; also "redesign", "restyle", "make it look better", "fix the layout", "add a table/dialog/form/tab", colours, spacing, dark/light theme. Sets the workflow and the done-gate, owns the shared components and the web ↔ viewer token map, and routes to camstack-ui-admin or camstack-ui-viewer.
---

# CamStack UI — the umbrella

CamStack has a CLOSED design system. The job is consistency with it, not a
distinctive look: a new surface should be indistinguishable in style from its
neighbours. A new visual language arrives only as an operator-approved change
to the library, never from one page.

## 1. Route to the sub-skill — now

| You are touching | Also load | Rules |
| --- | --- | --- |
| `packages/addon-admin-ui/**`, `packages/ui-library/**`, an addon page or widget (`packages/addon-*/src/**/*.tsx`), the agent UI | `camstack-ui-admin` (`.claude/skills/camstack-ui-admin/SKILL.md`) | `docs/ui/admin-patterns.md` |
| `camstack/**` — the viewer app (React Native) or its `embed/` player | `camstack-ui-viewer` (`.claude/skills/camstack-ui-viewer/SKILL.md`) | `docs/ui/viewer.md` |
| Both (a feature on both clients) | both | both |

This skill owns what both share; the sub-skill owns the platform. Read the
sub-skill before the first edit.

## 2. The workflow — each step ends with the exit you must be able to state

1. **Find.** For every UI element you need, search before you build:
   `npm run ui:find -- "<need>"` (need table + library catalogue), then
   `npm run ui:show -- <Name>` on the hits for props and real call sites.
   Read `docs/ui/need-x-use-y.md` once. *Exit: a table, element → component
   (or "none").*
2. **Map.** Fill the gaps from library primitives and composites. Never fork a
   composite — extend it with a prop. Never write a page-local look-alike of a
   library component (`ui:check` flags it as `shadows-library`). *Exit: no
   element unmapped.*
3. **Extend the library, if nothing fits.** Web: add it to
   `packages/ui-library/src/{primitives,composites}/`, export it from the
   barrel (`src/primitives/index.ts` / `src/composites/index.ts`), add a spec,
   run `npm run ui:catalogue`. The library is host-provided, so its consumers
   need the new version published. Viewer: `src/components/ui/` in the viewer
   repo. *Exit: the extension listed with its export, spec and catalogue
   regeneration.*
4. **Compose with the established patterns** — the sub-skill lists them.
   *Exit: which pattern each region of the screen uses.*
5. **Tokens only.** No hex, no `rgb()`, no Tailwind palette class
   (`bg-red-500`, `text-emerald-400`, `dark:` twins), no colour or spacing in
   `style=` / `StyleSheet` — the token map is below. *Exit: `ui:check` shows no
   new findings.*
6. **Measure.** Look at it. Web (admin-ui and addon pages): `npm run ui:shots`
   BEFORE your first edit and again after, with `--compare` — light and dark
   at 1440×900 and 390×844 (add `--viewport 320x640` for the narrowest
   phone), against fixture data, no hub. It reports document and `<main>`
   horizontal overflow, elements past the viewport and sticky pinning, and
   flags regressions; usage, fixtures and options are in `camstack-workflow`
   §5. **Any harness (Claude Code, Cursor, Codex, a generic agent):** after
   the run, open the PNGs under `scratchpad/ui-shots/<label>/` with the
   file-read tool that accepts images (Cursor: `Read` on each `.png`) so the
   shots appear in the transcript — a paste of only `report.md` is not
   enough. Note the compounded horizontal padding at the narrowest width.
   Viewer: the iOS simulator / Android emulator and the web build at ≈390 px
   and desktop. *Exit: the `ui:shots` report table (after vs before) plus
   the before/after PNGs inspected in-session, per width and theme.*
7. **Test.** Specs next to the existing ones (they pin tabs, deep links and
   the empty-vs-unanswered states); the package's typecheck. *Exit: the
   commands and their result.*
8. **Document.** A new convention or pattern → `docs/ui/*.md`; an alternative
   really rejected → an ADR; then the `camstack-docs` skill. *Exit: the docs
   touched, or "none needed: <reason>".*

## 3. Shared rules (both clients)

- **Library first.** `docs/ui/common-components.md` maps what exists;
  `docs/reference/ui-components.json` is the generated catalogue.
- **An unanswered query is not an empty answer.** Loading, absent and
  unknown each render differently — never `(data ?? []).length === 0` as
  "nothing installed" (`useCapabilityPresence` on the web).
- **Selection that should survive a reload lives in the URL** (`?tab=`,
  `?node=`, `?integration=`), replaced, not pushed, unless it is navigation.
- **A control with one option is not rendered.**
- **An icon is data**: the server sends an id, each client maps it to its own
  icon set; a glyph is never baked into a label.
- **Copy says what will happen, in one sentence** — no subsystem lectures, no
  decision ids (`D123`) in operator-facing text, and no safety net that does
  not exist (`docs/ui/conventions.md` → "Confirmation copy").
- **A removed capability takes its UI with it** — a dead control is worse than
  an absent one.

## 4. The token map (web ↔ viewer)

One palette, two spellings. Web: `packages/ui-library/src/tailwind/camstack-theme.css`
(utilities `bg-<t>`, `text-<t>`, `border-<t>`, `bg-<t>/10`; `var(--color-<t>)`
in SVG/canvas). Viewer: `camstack/src/theme/tokens.ts` (`ColorTokens` via
`useTheme().colors`). The CSS name in kebab-case is the viewer key in
camelCase.

| Role | Web | Viewer |
| --- | --- | --- |
| accent / text on it | `primary`, `primary-foreground` | `primary`, `primaryForeground` |
| page / raised layer | `background`, `background-elevated` | `background`, `backgroundElevated` |
| card, row / hover | `surface`, `surface-hover` | `surface`, `surfaceHover` |
| lines | `border`, `border-subtle` | `border`, `borderSubtle` |
| text, strongest → inert | `foreground`, `foreground-muted`, `foreground-subtle`, `foreground-disabled` | `foreground`, `foregroundMuted`, `foregroundSubtle`, `foregroundDisabled` |
| status | `success`, `warning`, `danger`, `info` | same keys |
| web only | `provider-*` (provider identity) | — |
| viewer only | — | `live` (LIVE edge), `BAND.*` (activity bands) |

Values: `npm run ui:tokens` prints both sides and marks DRIFT. A colour
neither side has is added to BOTH files in the same piece of work — never
inlined. Radii match (`rounded-sm|md|lg|xl` ↔ `RADIUS.sm|md|lg|xl`).

## 5. The done-gate — paste this, filled in, before you say "done"

```
UI DONE — <surface>
find/map:     <element → component table>
library:      <extensions with export + spec + catalogue regen, or "none">
ui:check:     <`npm run ui:check -- <every touched UI file>` output — 0 new findings>
measure:      `npm run ui:shots` after --compare before: <report table> — regressions: <none|list>;
              padding at the narrowest width: <px>;
              PNGs read in-session: before+after × light/dark × desktop/phone (paths listed)
              (viewer: device/simulator + web ≈390 px and desktop)
tests:        <spec + typecheck commands and result>
pre-push:     <server `verify:push` GREEN | viewer `camstack/` `npm run verify:push` GREEN | n/a>
docs:         <files touched | "none needed: reason">
viewer rule:  <"no viewer layout change" | "layout agreed with the operator on <date>">
```

A coordinator reviewing a UI task checks this block, not the summary. No
block, or a `ui:check` you did not run, means not done.

## 6. Tools without the MCP

`npm run ui:find|ui:show|ui:tokens|ui:check|ui:shots` and `npm run ui:catalogue`
are plain local scripts (`scripts/ui/`; `ui:shots` needs Playwright's Chromium
once: `npx playwright install chromium`). `ui:check` is a developer tool — the
pre-commit hook runs it on staged UI files and only warns; it is never a CI
gate. The viewer repository has its own `ui:find` / `ui:check`.
