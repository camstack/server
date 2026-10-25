/**
 * Every repository skill, and where its pointers go.
 *
 * One entry per `.claude/skills/<id>/SKILL.md`. The entry says, for agents
 * that do not read `.claude/skills` natively (Codex) or read it only when
 * asked (Cursor):
 *   - `when`    — the row of the root `AGENTS.md` skills table;
 *   - `agents`  — the package `AGENTS.md` files that list it (nested
 *                 `AGENTS.md` apply to every file under them);
 *   - `cursor`  — a `.cursor/rules/<id>.mdc`: glob-attached where a natural
 *                 path set exists, agent-requested (no globs) otherwise;
 *   - `docs`    — the long-form pages the pointer names next to the skill.
 *
 * The UI skills' package blocks and rules are richer and live in
 * `ui-pointers.ts`; they still need an entry here for the root table.
 * `gen-skill-pointers.ts --check` fails when a skill directory has no entry,
 * an entry has no directory, or a named doc or glob matches nothing.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { type AgentsTarget, type BlockSpec, mdcHeader, type MdcTarget } from './pointer-blocks.js'

export const SKILLS_TABLE_ID = 'skills-table'
export const SKILLS_TABLE_HEADING = 'Skills'
export const SKILLS_BLOCK_ID = 'skills-pointer'
export const SKILLS_BLOCK_HEADING = 'Skills for this package'
export const WORKING_STYLE_BLOCK_ID = 'workflow-pointer'
export const WORKING_STYLE_HEADING = 'Working style'

/** Where a package-level pointer goes. `create` makes the AGENTS.md if absent. */
export interface NestedTarget {
  readonly dir: string
  readonly create: boolean
}

export interface SkillEntry {
  readonly id: string
  /** Root-table cell: "Doing this". Keep it short — the root is near Codex's cap. */
  readonly when: string
  /** Package directories whose AGENTS.md lists this skill. */
  readonly agents: readonly NestedTarget[] | 'addon-packages'
  /** Null = no generic rule (the UI skills have their own in ui-pointers.ts). */
  readonly cursor: {
    readonly description: string
    readonly globs: readonly string[]
    /**
     * In every request's context. Only for the entry point every change goes
     * through; it then carries `body` (a few lines) instead of the default
     * body, and never `@`-attaches the whole skill.
     */
    readonly alwaysApply?: boolean
    readonly body?: readonly string[]
  } | null
  readonly docs: readonly string[]
  /** A line first under the root AGENTS.md "Working style": a rule for every change. */
  readonly rootRule?: string
}

const BACKEND: NestedTarget = { dir: 'server/backend', create: true }
const SYSTEM: NestedTarget = { dir: 'packages/system', create: false }
const TYPES: NestedTarget = { dir: 'packages/types', create: false }

const WORKFLOW_SKILL = '.claude/skills/camstack-workflow/SKILL.md'

export const SKILLS: readonly SkillEntry[] = [
  {
    id: 'camstack-workflow',
    when: 'ANY change (feature, fix, refactor, UI, server) — load FIRST; the definition of done',
    agents: [],
    cursor: {
      description:
        'CamStack entry point for any change — phases, gates and the definition of done; how to ask the operator',
      globs: [],
      alwaysApply: true,
      body: [
        `**Any change** (implement, fix, add, refactor, build) → follow the \`camstack-workflow\` skill first: \`/camstack-workflow\`, or read \`${WORKFLOW_SKILL}\`. It sets the phases, the gates and the definition of done; the other skills give the details.`,
        '',
        'Ask the operator with the `AskQuestion` tool (it is reliably offered in Plan mode — Shift+Tab): one decision per question, 2–4 options, the recommendation first. No picker → a numbered list with the recommendation marked, then stop and wait.',
      ],
    },
    docs: ['docs/design/2026-10-09-repo-skills-and-ui-skill-plan.md'],
    rootRule:
      '**Any change → load `camstack-workflow` first**: phases, gates, definition of done. The skills below give the details.',
  },
  {
    id: 'camstack-ui',
    when: 'Any UI — admin-ui, ui-library, an addon page or widget, the viewer — load FIRST',
    agents: [],
    cursor: null,
    docs: ['docs/ui/README.md'],
  },
  {
    id: 'camstack-ui-admin',
    when: '… then, for admin-ui / ui-library / addon pages',
    agents: [],
    cursor: null,
    docs: ['docs/ui/admin-patterns.md'],
  },
  {
    id: 'camstack-ui-viewer',
    when: '… or, for the viewer app and its embed player',
    agents: [],
    cursor: null,
    docs: ['docs/ui/viewer.md'],
  },
  {
    id: 'camstack-addon',
    when: 'A new or changed addon or manifest entry; `camstack deploy`',
    agents: 'addon-packages',
    cursor: {
      description:
        'CamStack addon authoring — manifest, vite entries, BaseAddon traps, forked vs in-process, device settings stores, camstack deploy',
      globs: [
        'packages/addon-*/package.json',
        'packages/addon-*/vite.config.ts',
        'packages/*/src/**/*.addon.ts',
        'packages/system/src/builtins/**',
      ],
    },
    docs: ['docs/architecture/addon-lifecycle.md', 'docs/architecture/addon-custom-actions.md'],
  },
  {
    id: 'camstack-capability',
    when: 'A new or changed `*.cap.ts`; picking a provider',
    agents: [TYPES, SYSTEM, BACKEND],
    cursor: {
      description:
        'CamStack capability change end to end — cap schema, codegen, registerProvider, bindings, CAP_INPUT_DEFAULTS, what to publish',
      globs: [
        'packages/types/src/capabilities/**',
        'packages/types/src/generated/**',
        'scripts/codegen.ts',
        'scripts/generate-*.ts',
      ],
    },
    docs: ['docs/architecture/capabilities.md', 'docs/reference/capabilities.md'],
  },
  {
    id: 'camstack-server-change',
    when: 'A change to `server/backend`, `system`, `types` or `sdk`: test, build, ship',
    agents: [BACKEND, SYSTEM, TYPES],
    cursor: {
      description:
        'CamStack server-side change — typecheck vs real build, .d.ts leaks, publish → applyServerUpdate → restart → verify, CI rules',
      globs: [
        'server/backend/src/**',
        'packages/system/src/**',
        'packages/types/src/**',
        'packages/sdk/src/**',
        'packages/node-root/src/**',
      ],
    },
    docs: ['docs/architecture/update-and-release.md'],
  },
  {
    id: 'camstack-secrets',
    when: 'A password / token / key, or a credential for a child process',
    agents: [SYSTEM, BACKEND],
    cursor: {
      description:
        'CamStack secrets — keychain, secret field types, no env vars, 0600 files for spawned children, the secret guards',
      globs: ['packages/system/src/builtins/keychain/**', 'scripts/check-*secret*.ts'],
    },
    docs: ['docs/architecture/secrets-keychain.md'],
  },
  {
    id: 'camstack-diagnose',
    when: 'Something is wrong on a running node: logs, API, where work ran',
    agents: [BACKEND],
    cursor: {
      description:
        'Debug a live CamStack system — log tiers, hub.mjs and the tRPC API, topology, verifying where work ran, instrument before guessing',
      globs: [],
    },
    docs: ['docs/architecture/overview.md', 'docs/architecture/transport.md'],
  },
  {
    id: 'audit-debug-tracks',
    when: 'Track media complaints (no photo, wrong thumbnail, ended too soon)',
    agents: [],
    cursor: {
      description:
        'Audit CamStack tracks the operator flagged — missing media kinds, thumbnails, early track ends',
      globs: [],
    },
    docs: ['docs/architecture/post-analysis.md'],
  },
  {
    id: 'camstack-publish-ci',
    when: 'Publishing to npm or cutting a release, through CI',
    agents: [],
    cursor: {
      description:
        'CamStack releases through GitHub Actions — Publish Packages, the release tag, registry lag, never dispatch Checks',
      globs: ['.github/workflows/**'],
    },
    docs: ['docs/architecture/update-and-release.md'],
  },
  {
    id: 'camstack-hub-image-deploy',
    when: 'Putting a server closure on a node: `applyServerUpdate`, images',
    agents: [],
    cursor: {
      description:
        'Ship a CamStack server-side change to a running hub/agent — applyServerUpdate, the restart, verification, when an image is needed',
      globs: ['Dockerfile', 'Dockerfile.dev', 'packages/node-root/src/**'],
    },
    docs: ['docs/architecture/update-and-release.md', 'docs/architecture/deploying.md'],
  },
  {
    id: 'camstack-docs',
    when: 'Finishing any work: what to document, ADRs, generated files',
    agents: [],
    cursor: {
      description:
        'CamStack documentation — generated vs hand-written docs, ADRs, applies-to, docs:check, the public docs site',
      globs: ['docs/**', '.claude/skills/**', '**/AGENTS.md'],
    },
    docs: ['docs/README.md', 'docs/decisions/conventions.md'],
  },
  {
    id: 'camstack-benchmark-detection',
    when: 'Filling DETECTOR_PERF / detector-latency for a node×device',
    // types holds DETECTOR_PERF; benchmark owns runPipelineTest. Skip
    // addon-pipeline AGENTS.md — that package is already over Codex's 32 KiB.
    agents: [
      { dir: 'packages/types', create: false },
      { dir: 'packages/addon-benchmark', create: false },
    ],
    cursor: {
      description:
        'Measure Auto-tune detector latency on a live node — warm median, detector-latency.json + DETECTOR_PERF, D745 lock',
      globs: [
        'docs/benchmarks/detector-latency.json',
        'packages/types/src/pipeline/auto-tune/**',
        'scripts/bench-detector-latency-column.mjs',
      ],
    },
    docs: [
      'docs/architecture/inference-devices.md',
      'docs/benchmarks/2026-10-07-detector-comparison.md',
      'docs/architecture/benchmark.md',
    ],
  },
]

const skillPath = (id: string): string => `.claude/skills/${id}/SKILL.md`

// ── Blocks ─────────────────────────────────────────────────────────────────

/** The root `AGENTS.md` table — one row per skill, registry order. */
export function skillsTableBlock(skills: readonly SkillEntry[] = SKILLS): BlockSpec {
  return {
    id: SKILLS_TABLE_ID,
    heading: SKILLS_TABLE_HEADING,
    lines: [
      '| Doing this | Skill |',
      '| --- | --- |',
      ...skills.map((s) => `| ${s.when} | \`${s.id}\` |`),
    ],
  }
}

/** The rules every change follows, first under the root "Working style"; null when no skill has one. */
export function workingStyleBlock(skills: readonly SkillEntry[] = SKILLS): BlockSpec | null {
  const rules = skills.flatMap((s) => (s.rootRule === undefined ? [] : [`- ${s.rootRule}`]))
  if (rules.length === 0) return null
  return {
    id: WORKING_STYLE_BLOCK_ID,
    heading: WORKING_STYLE_HEADING,
    placement: 'under-heading',
    lines: rules,
  }
}

/** A package `AGENTS.md` block listing the skills that target it. */
export function packageSkillsBlock(skills: readonly SkillEntry[]): BlockSpec {
  return {
    id: SKILLS_BLOCK_ID,
    heading: SKILLS_BLOCK_HEADING,
    placement: 'top',
    lines: [
      'Follow the skill; do not reconstruct the procedure (any agent can open the file):',
      '',
      ...skills.map((s) => `- ${s.when} → \`${s.id}\` (\`${skillPath(s.id)}\`)`),
    ],
  }
}

/** Every `packages/addon-*` directory that has (or will be given) an AGENTS.md. */
export function addonPackageDirs(root: string, alsoPackages: readonly string[] = []): string[] {
  const packagesDir = path.join(root, 'packages')
  if (!fs.existsSync(packagesDir)) return []
  const extra = new Set(alsoPackages.filter((p) => p.startsWith('addon-')))
  return fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('addon-'))
    .map((d) => d.name)
    .filter((name) => extra.has(name) || fs.existsSync(path.join(packagesDir, name, 'AGENTS.md')))
    .toSorted()
    .map((name) => `packages/${name}`)
}

/**
 * The package `AGENTS.md` targets. `uiPagePackages` are the addon packages the
 * UI generator gives an AGENTS.md, so an addon page and its addon pointer land
 * in one pass.
 */
export function skillAgentsTargets(
  root: string,
  uiPagePackages: readonly string[],
  skills: readonly SkillEntry[] = SKILLS,
): AgentsTarget[] {
  const byDir = new Map<string, { create: boolean; skills: SkillEntry[] }>()
  const add = (dir: string, create: boolean, skill: SkillEntry): void => {
    const prev = byDir.get(dir)
    if (prev === undefined) byDir.set(dir, { create, skills: [skill] })
    else byDir.set(dir, { create: prev.create || create, skills: [...prev.skills, skill] })
  }
  for (const skill of skills) {
    const targets =
      skill.agents === 'addon-packages'
        ? addonPackageDirs(root, uiPagePackages).map((dir) => ({ dir, create: false }))
        : skill.agents
    for (const t of targets) add(t.dir, t.create, skill)
  }
  const workingStyle = workingStyleBlock(skills)
  const out: AgentsTarget[] = [
    {
      file: 'AGENTS.md',
      blocks: [skillsTableBlock(skills), ...(workingStyle === null ? [] : [workingStyle])],
    },
  ]
  for (const [dir, entry] of [...byDir.entries()].toSorted(([a], [b]) => a.localeCompare(b))) {
    const file = `${dir}/AGENTS.md`
    if (!entry.create && !fs.existsSync(path.join(root, file)) && !isUiPage(dir, uiPagePackages)) {
      continue
    }
    out.push({ file, pkg: dir.split('/').at(-1), blocks: [packageSkillsBlock(entry.skills)] })
  }
  return out
}

function isUiPage(dir: string, uiPagePackages: readonly string[]): boolean {
  return uiPagePackages.some((p) => dir === `packages/${p}`)
}

export function skillMdcTargets(skills: readonly SkillEntry[] = SKILLS): MdcTarget[] {
  return skills.flatMap((s): MdcTarget[] =>
    s.cursor === null
      ? []
      : [
          {
            file: `.cursor/rules/${s.id}.mdc`,
            description: s.cursor.description,
            globs: s.cursor.globs,
            ...(s.cursor.alwaysApply === true ? { alwaysApply: true } : {}),
            body: s.cursor.body
              ? [mdcHeader('Always applied: keep it a few lines.'), '', ...s.cursor.body]
              : [
                  mdcHeader('The procedure lives in the skill below.'),
                  '',
                  `**${s.when}** → follow the \`${s.id}\` skill — \`${skillPath(s.id)}\`. Cursor also offers it as an Agent Skill; any other agent reads the file.`,
                  '',
                  `Long-form reference: ${s.docs.map((d) => `\`${d}\``).join(', ')}.`,
                  '',
                  `- @${skillPath(s.id)}`,
                ],
          },
        ],
  )
}

// ── Validation ─────────────────────────────────────────────────────────────

export interface SkillFront {
  readonly name: string | null
  readonly description: string | null
}

/** `name` / `description` from a SKILL.md frontmatter (single-line values). */
export function readFrontmatter(text: string): SkillFront {
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
  const field = (key: string): string | null => {
    const m = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(front)
    return m ? m[1].trim() : null
  }
  return { name: field('name'), description: field('description') }
}

/** Skill directories (`.claude/skills/<dir>/SKILL.md`) on disk. */
export function skillDirs(root: string): string[] {
  const dir = path.join(root, '.claude', 'skills')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'SKILL.md')))
    .map((d) => d.name)
    .toSorted()
}

function globMatchesSomething(root: string, pattern: string): boolean {
  for (const hit of fs.globSync(pattern, { cwd: root })) {
    if (!hit.split(path.sep).includes('node_modules')) return true
  }
  return false
}

/**
 * What would make a pointer lie: a skill with no entry (invisible to Codex),
 * an entry with no skill, a frontmatter `name` that is not the folder name
 * (Cursor requires them equal), a missing description, a named doc that does
 * not exist, or a rule glob that matches no file.
 */
export function registryProblems(root: string, skills: readonly SkillEntry[] = SKILLS): string[] {
  const problems: string[] = []
  const onDisk = new Set(skillDirs(root))
  const listed = new Set(skills.map((s) => s.id))
  for (const dir of onDisk) {
    if (!listed.has(dir)) {
      problems.push(`.claude/skills/${dir} has no entry in scripts/skills/lib/skill-registry.ts`)
    }
    const front = readFrontmatter(fs.readFileSync(path.join(root, skillPath(dir)), 'utf8'))
    if (front.name !== dir) {
      problems.push(
        `${skillPath(dir)}: frontmatter name "${front.name}" must equal the folder name`,
      )
    }
    if (!front.description) problems.push(`${skillPath(dir)}: frontmatter has no description`)
  }
  for (const s of skills) {
    if (!onDisk.has(s.id)) problems.push(`registry entry "${s.id}" has no ${skillPath(s.id)}`)
    for (const doc of s.docs) {
      if (!fs.existsSync(path.join(root, doc))) problems.push(`${s.id}: doc ${doc} does not exist`)
    }
    for (const glob of s.cursor?.globs ?? []) {
      if (!globMatchesSomething(root, glob))
        problems.push(`${s.id}: rule glob ${glob} matches no file`)
    }
  }
  return problems
}
