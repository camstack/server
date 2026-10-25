/**
 * The UI pointers: what the generated UI blocks SAY and WHERE they go. The
 * markers, splicing and file handling are the engine's (`pointer-blocks.ts`).
 *
 * The UI skills get richer pointers than the other skills (a lead line per
 * kind of package, the search commands, the done-gate) because UI work is
 * where external agents went most wrong — see
 * docs/design/2026-10-09-repo-skills-and-ui-skill-plan.md.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { type AgentsTarget, type BlockSpec, mdcHeader, type MdcTarget } from './pointer-blocks.js'

export const UI_BLOCK_ID = 'ui-pointer'
export const UI_HEADING = 'UI work'

export type UiPointerKind = 'root' | 'admin' | 'library' | 'page' | 'agent-ui'

const SKILL = (name: string): string => `.claude/skills/${name}/SKILL.md`

const LEAD: Readonly<Record<UiPointerKind, string>> = {
  root: '**UI work** (admin-ui, ui-library, an addon page or widget, the viewer): load the `camstack-ui` skill first — `.claude/skills/camstack-ui/SKILL.md` — then `camstack-ui-admin` or `camstack-ui-viewer`. Claude Code and Cursor list them as skills; any other agent reads them as files.',
  admin:
    '**This package is the admin UI.** Before any UI change load `camstack-ui` (`.claude/skills/camstack-ui/SKILL.md`), then `camstack-ui-admin` (`.claude/skills/camstack-ui-admin/SKILL.md`). Page patterns: `docs/ui/admin-patterns.md`.',
  library:
    '**This package is the shared component library** (host-provided to every addon page). Before any change load `camstack-ui`, then `camstack-ui-admin` (`.claude/skills/camstack-ui-admin/SKILL.md`). A new export goes in the `src/primitives` / `src/composites` barrel, with a spec, then `npm run ui:catalogue`.',
  page: '**This package ships an addon page** (a Module Federation remote). Before any UI change load `camstack-ui`, then `camstack-ui-admin` (`.claude/skills/camstack-ui-admin/SKILL.md`). It ships no CSS: its classes exist only because the admin-ui build scans it (D747, `npx tsx scripts/check-addon-page-css.ts`).',
  'agent-ui':
    '**This package is the agent UI.** Before any UI change load `camstack-ui`, then `camstack-ui-admin` (`.claude/skills/camstack-ui-admin/SKILL.md`); it uses the same library and theme as the admin UI.',
}

const COMMON_LINES: readonly string[] = [
  '- Search before building: `npm run ui:find -- "<need>"`, `npm run ui:show -- <Name>`, `npm run ui:tokens`.',
  '- Library components and theme tokens only: no hex, no palette classes (`bg-red-500`), no colour or spacing in `style=`.',
  '- Rules: `docs/ui/README.md` (conventions, need → component, admin patterns, viewer, anti-patterns).',
  '- Done = the skill’s done-gate: `npm run ui:check -- <files>` with 0 new findings, plus `npm run ui:shots` before/after (dark + light, desktop 1440×900 + phone 390×844).',
  '- After `ui:shots`: **Read the PNG files** under `scratchpad/ui-shots/<label>/` (Cursor `Read` accepts images) so before/after appear in the transcript — do not stop at `report.md` alone. Any agent / harness, not only Claude Code.',
]

const VIEWER_LINE = '- Viewer layout changes are co-designed with the operator: ask first.'

/** The lines between the markers, for one kind of target. */
export function uiPointerLines(kind: UiPointerKind): string[] {
  return [LEAD[kind], '', ...COMMON_LINES, ...(kind === 'root' ? [VIEWER_LINE] : [])]
}

export function uiBlock(kind: UiPointerKind): BlockSpec {
  return { id: UI_BLOCK_ID, heading: UI_HEADING, lines: uiPointerLines(kind) }
}

// ── Targets ────────────────────────────────────────────────────────────────

const ADMIN_CSS = 'packages/addon-admin-ui/src/index.css'

/**
 * Directories the admin-ui Tailwind build scans (`@source "../../<dir>"` in
 * its stylesheet) — every tree whose classes reach the hub's stylesheet, so
 * every tree whose files are UI. Generated half included (D747).
 */
export function scannedUiRoots(css: string): string[] {
  const out: string[] = []
  for (const m of css.matchAll(/@source\s+"\.\.\/\.\.\/([^"]+)"/g)) {
    out.push(`packages/${m[1].replace(/\/$/, '')}`)
  }
  return out
}

export function uiGlobs(root: string): string[] {
  const css = fs.readFileSync(path.join(root, ADMIN_CSS), 'utf8')
  const roots = new Set<string>([
    'packages/addon-admin-ui/src',
    'packages/ui-library/src',
    'packages/addon-agent-ui/src',
    ...scannedUiRoots(css),
  ])
  return [...[...roots].map((r) => `${r}/**`), 'packages/addon-*/src/**/*.tsx']
}

export const VIEWER_GLOBS: readonly string[] = [
  'camstack/src/**',
  'camstack/app/**',
  'camstack/embed/src/**',
  'camstack/locales/**',
]

function uiMdcBody(skills: readonly string[]): string[] {
  return [
    mdcHeader('The rules live in the skills below and in docs/ui/.'),
    '',
    ...uiPointerLines('root'),
    '',
    'Read these before the first edit (Cursor also offers them as Agent Skills):',
    '',
    ...skills.map((s) => `- @${SKILL(s)}`),
  ]
}

export function uiMdcTargets(root: string): MdcTarget[] {
  return [
    {
      file: '.cursor/rules/camstack-ui.mdc',
      description:
        'CamStack UI design system — load before planning, building or restyling any admin-ui page, ui-library component, addon page, widget or viewer screen',
      globs: [],
      body: uiMdcBody(['camstack-ui']),
    },
    {
      file: '.cursor/rules/camstack-ui-admin.mdc',
      description:
        'CamStack admin UI / ui-library / addon page rules (AdminPage, AdminTabs, IntegrationHub, DataTable, Dialog, theme tokens)',
      globs: uiGlobs(root),
      body: uiMdcBody(['camstack-ui', 'camstack-ui-admin']),
    },
    {
      file: '.cursor/rules/camstack-ui-viewer.mdc',
      description:
        'CamStack viewer (React Native) UI rules — kit, tokens.ts, SheetModal, i18n en+it; layout changes need the operator',
      globs: VIEWER_GLOBS,
      body: uiMdcBody(['camstack-ui', 'camstack-ui-viewer']),
    },
  ]
}

export function uiAgentsTargets(pagePackages: readonly string[]): AgentsTarget[] {
  const fixed: AgentsTarget[] = [
    { file: 'AGENTS.md', blocks: [uiBlock('root')] },
    {
      file: 'packages/addon-admin-ui/AGENTS.md',
      pkg: 'addon-admin-ui',
      blocks: [uiBlock('admin')],
    },
    { file: 'packages/ui-library/AGENTS.md', pkg: 'ui-library', blocks: [uiBlock('library')] },
    {
      file: 'packages/addon-agent-ui/AGENTS.md',
      pkg: 'addon-agent-ui',
      blocks: [uiBlock('agent-ui')],
    },
  ]
  const known = new Set(fixed.map((t) => t.pkg))
  const pages = pagePackages
    .filter((p) => !known.has(p))
    .map(
      (p): AgentsTarget => ({ file: `packages/${p}/AGENTS.md`, pkg: p, blocks: [uiBlock('page')] }),
    )
  return [...fixed, ...pages]
}
