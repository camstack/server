/**
 * The generic skill pointers: every repo skill reaches Codex through the root
 * AGENTS.md table, reaches the packages it concerns through a nested block,
 * and reaches Cursor through an `.mdc`. The check is only worth something if
 * it refuses an unregistered skill, a renamed one, a dead doc or glob, an
 * orphaned block, and a root that would push package rules out of Codex's
 * 32 KiB window.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  blockBegin,
  blockEnd,
  codexBudget,
  extractBlock,
  mergeTargets,
  planPointers,
  removeBlock,
  renderMdc,
  spliceBlock,
  staleWrites,
} from '../skills/lib/pointer-blocks.js'
import {
  addonPackageDirs,
  packageSkillsBlock,
  readFrontmatter,
  registryProblems,
  SKILLS,
  SKILLS_BLOCK_HEADING,
  SKILLS_BLOCK_ID,
  type SkillEntry,
  skillAgentsTargets,
  skillMdcTargets,
  skillsTableBlock,
  WORKING_STYLE_BLOCK_ID,
  workingStyleBlock,
} from '../skills/lib/skill-registry.js'

const REPO = path.resolve(import.meta.dirname, '..', '..')

const entry = (id: string, over: Partial<SkillEntry> = {}): SkillEntry => ({
  id,
  when: `doing ${id}`,
  agents: [],
  cursor: null,
  docs: [],
  ...over,
})

const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function repo(files: Readonly<Record<string, string>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-pointers-'))
  tmp.push(root)
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), content)
  }
  return root
}

const skillFile = (name: string, description = 'Use when testing.'): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`

describe('the registry of this repository', () => {
  it('lists every skill directory exactly once, with names, docs and globs that resolve', () => {
    expect(registryProblems(REPO)).toEqual([])
    const ids = SKILLS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps the table rows short enough for the root budget', () => {
    for (const s of SKILLS) expect(s.when.length).toBeLessThanOrEqual(90)
  })
})

describe('registry problems', () => {
  it('names an unregistered skill, a missing one, a name/folder mismatch, a dead doc and a dead glob', () => {
    const root = repo({
      '.claude/skills/listed/SKILL.md': skillFile('listed'),
      '.claude/skills/stray/SKILL.md': skillFile('stray'),
      '.claude/skills/renamed/SKILL.md': skillFile('old-name'),
      'docs/real.md': '# real\n',
    })
    const problems = registryProblems(root, [
      entry('listed', {
        docs: ['docs/real.md', 'docs/gone.md'],
        cursor: { description: 'd', globs: ['docs/**', 'nowhere/**'] },
      }),
      entry('renamed'),
      entry('ghost'),
    ])
    expect(problems).toEqual([
      '.claude/skills/renamed/SKILL.md: frontmatter name "old-name" must equal the folder name',
      '.claude/skills/stray has no entry in scripts/skills/lib/skill-registry.ts',
      'listed: doc docs/gone.md does not exist',
      'listed: rule glob nowhere/** matches no file',
      'registry entry "ghost" has no .claude/skills/ghost/SKILL.md',
    ])
  })

  it('reads single-line frontmatter and reports a missing description', () => {
    expect(readFrontmatter(skillFile('x', 'Use it: now.'))).toEqual({
      name: 'x',
      description: 'Use it: now.',
    })
    const root = repo({ '.claude/skills/bare/SKILL.md': '---\nname: bare\n---\n' })
    expect(registryProblems(root, [entry('bare')])).toEqual([
      '.claude/skills/bare/SKILL.md: frontmatter has no description',
    ])
  })
})

describe('blocks', () => {
  it('render the root table in registry order, one row per skill', () => {
    const block = skillsTableBlock([entry('a'), entry('b')])
    expect(block.lines).toEqual([
      '| Doing this | Skill |',
      '| --- | --- |',
      '| doing a | `a` |',
      '| doing b | `b` |',
    ])
  })

  it('put a NEW package block before the first section, so Codex truncating the tail cannot drop it', () => {
    const text = '# AGENTS.md — pkg\n\nIntro.\n\n## Rules\n\nLong rules.\n'
    const block = packageSkillsBlock([entry('a')])
    const once = spliceBlock(text, block)
    expect(once.indexOf(blockBegin(SKILLS_BLOCK_ID))).toBeLessThan(once.indexOf('## Rules'))
    expect(once.startsWith('# AGENTS.md — pkg\n\nIntro.\n\n## Skills for this package\n')).toBe(
      true,
    )
    expect(spliceBlock(once, block)).toBe(once)
  })

  it('put a block placed under a heading right below it, and keep it there on the next pass', () => {
    const text = '# A\n\n## Working style\n\n- First rule.\n\n## Next\n'
    const block = workingStyleBlock([entry('wf', { rootRule: 'Any change → `wf` first.' })])!
    const once = spliceBlock(text, block)
    expect(once).toBe(
      `# A\n\n## Working style\n\n${blockBegin(WORKING_STYLE_BLOCK_ID)}\n- Any change → \`wf\` first.\n${blockEnd(WORKING_STYLE_BLOCK_ID)}\n- First rule.\n\n## Next\n`,
    )
    expect(spliceBlock(once, block)).toBe(once)
    // No skill with a root rule → no block.
    expect(workingStyleBlock([entry('a')])).toBeNull()
  })

  it('remove a block and the heading the generator appended, leaving the rest intact', () => {
    const text = '# A\n\nIntro.\n\n## Rules\n\nText.\n'
    const withBlock = spliceBlock(text, packageSkillsBlock([entry('a')]))
    expect(removeBlock(withBlock, SKILLS_BLOCK_ID, SKILLS_BLOCK_HEADING)).toBe(text)
    expect(removeBlock(text, SKILLS_BLOCK_ID, SKILLS_BLOCK_HEADING)).toBe(text)
  })

  it('merge two sources targeting one file without duplicating a block id', () => {
    const a = packageSkillsBlock([entry('a')])
    const b = { id: 'other', heading: 'Other', lines: ['x'] }
    const merged = mergeTargets([
      { file: 'p/AGENTS.md', pkg: 'p', blocks: [b] },
      { file: 'p/AGENTS.md', pkg: 'p', blocks: [a, b] },
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.blocks.map((x) => x.id)).toEqual(['other', SKILLS_BLOCK_ID])
  })
})

describe('targets', () => {
  it('list each skill in the packages it names, create only where asked, and give addons the addon skill', () => {
    const root = repo({
      'AGENTS.md': '# root\n',
      'packages/types/AGENTS.md': '# types\n',
      'packages/addon-x/AGENTS.md': '# x\n',
      'packages/addon-y/package.json': '{}',
    })
    const skills = [
      entry('cap', {
        agents: [
          { dir: 'packages/types', create: false },
          { dir: 'server/backend', create: true },
        ],
      }),
      entry('addon', { agents: 'addon-packages' }),
      entry('nowhere', { agents: [{ dir: 'packages/sdk', create: false }] }),
    ]
    expect(addonPackageDirs(root)).toEqual(['packages/addon-x'])
    const targets = skillAgentsTargets(root, [], skills)
    expect(targets.map((t) => t.file)).toEqual([
      'AGENTS.md',
      'packages/addon-x/AGENTS.md',
      'packages/types/AGENTS.md',
      'server/backend/AGENTS.md',
    ])
    const types = targets.find((t) => t.file === 'packages/types/AGENTS.md')!
    expect(types.blocks[0]!.lines.join('\n')).toContain('`cap` (`.claude/skills/cap/SKILL.md`)')
    // An addon page the UI generator is about to create also gets the addon pointer.
    expect(skillAgentsTargets(root, ['addon-y'], skills).map((t) => t.file)).toContain(
      'packages/addon-y/AGENTS.md',
    )
  })

  it('write one Cursor rule per skill with a rule — agent-requested when it has no globs', () => {
    const rules = skillMdcTargets([
      entry('globbed', {
        cursor: { description: 'G', globs: ['docs/**', 'x/**'] },
        docs: ['docs/a.md'],
      }),
      entry('asked', { cursor: { description: 'A', globs: [] } }),
      entry('none'),
    ])
    expect(rules.map((r) => r.file)).toEqual([
      '.cursor/rules/globbed.mdc',
      '.cursor/rules/asked.mdc',
    ])
    const globbed = renderMdc(rules[0]!)
    expect(globbed).toMatch(
      /^---\ndescription: G\nglobs: docs\/\*\*, x\/\*\*\nalwaysApply: false\n---\n/,
    )
    expect(globbed).toContain('- @.claude/skills/globbed/SKILL.md')
    expect(globbed).toContain('`docs/a.md`')
    expect(renderMdc(rules[1]!)).not.toMatch(/^globs:/m)
  })
})

describe('the workflow entry point', () => {
  it('reaches the root AGENTS.md as a Working style line and Cursor as a tiny always-applied rule', () => {
    const root = repo({ 'AGENTS.md': '# root\n\n## Working style\n\n- Rule.\n' })
    const skills = [
      entry('wf', {
        rootRule: 'Any change → load `wf` first.',
        cursor: {
          description: 'W',
          globs: [],
          alwaysApply: true,
          body: ['Any change → `wf` first.'],
        },
      }),
    ]
    const [rootTarget] = skillAgentsTargets(root, [], skills)
    expect(rootTarget!.blocks.map((b) => b.id)).toContain(WORKING_STYLE_BLOCK_ID)
    const [rule] = skillMdcTargets(skills)
    const text = renderMdc(rule!)
    expect(text).toMatch(/^---\ndescription: W\nalwaysApply: true\n---\n/)
    expect(text).toContain('Any change → `wf` first.')
    // Always applied = paid on every request: no @-attachment of the whole skill.
    expect(text).not.toContain('- @.claude/skills/wf/SKILL.md')
  })

  it('is registered first, with a root rule and an always-applied Cursor rule', () => {
    const wf = SKILLS[0]!
    expect(wf.id).toBe('camstack-workflow')
    expect(wf.rootRule).toBeDefined()
    expect(wf.cursor?.alwaysApply).toBe(true)
    expect(renderMdc(skillMdcTargets([wf])[0]!).split('\n').length).toBeLessThan(15)
  })
})

describe('plan and check', () => {
  it('removes an owned block from a file no target names any more', () => {
    const orphan = `# p\n\n## Skills for this package\n\n${blockBegin(SKILLS_BLOCK_ID)}\nold\n${blockEnd(SKILLS_BLOCK_ID)}\n\n## Rules\n\nKeep.\n`
    const root = repo({ 'AGENTS.md': '# root\n', 'packages/p/AGENTS.md': orphan })
    const { writes } = planPointers(root, [{ file: 'AGENTS.md', blocks: [] }], [], {
      owned: [{ id: SKILLS_BLOCK_ID, heading: SKILLS_BLOCK_HEADING }],
      known: ['packages/p/AGENTS.md'],
    })
    const p = writes.find((w) => w.file === 'packages/p/AGENTS.md')
    expect(p?.content).toBe('# p\n\n## Rules\n\nKeep.\n')
    expect(extractBlock(p!.content, SKILLS_BLOCK_ID)).toBeNull()
  })

  it('is current right after a write, and stale after a hand edit inside the table', () => {
    const root = repo({
      'AGENTS.md': `# root\n\n${blockBegin('skills-table')}\n${blockEnd('skills-table')}\n`,
    })
    const targets = [{ file: 'AGENTS.md', blocks: [skillsTableBlock([entry('a')])] }]
    for (const w of planPointers(root, targets, []).writes)
      fs.writeFileSync(path.join(root, w.file), w.content)
    expect(staleWrites(root, planPointers(root, targets, []).writes)).toEqual([])
    const file = path.join(root, 'AGENTS.md')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('doing a', 'doing b'))
    expect(staleWrites(root, planPointers(root, targets, []).writes).map((w) => w.file)).toEqual([
      'AGENTS.md',
    ])
  })

  it('fails a root over its budget and warns, naming the package, for a chain over the cap', () => {
    const root = repo({
      'AGENTS.md': 'r'.repeat(100),
      'packages/small/AGENTS.md': 's'.repeat(10),
      'packages/big/AGENTS.md': 'b'.repeat(200),
    })
    const files = ['AGENTS.md', 'packages/small/AGENTS.md', 'packages/big/AGENTS.md']
    expect(codexBudget(root, files, [], 250, 150)).toEqual({
      errors: [],
      warnings: [
        "packages/big/AGENTS.md: root + package AGENTS.md is 300 bytes, over Codex's 250-byte cap (AGENTS.md + packages/big/AGENTS.md) — Codex drops the tail of packages/big/AGENTS.md",
      ],
    })
    // A pending write counts, not the file on disk.
    const grown = codexBudget(
      root,
      files,
      [{ file: 'AGENTS.md', content: 'r'.repeat(160) }],
      250,
      150,
    )
    expect(grown.errors).toEqual([
      'AGENTS.md is 160 bytes, over its 150-byte budget (Codex reads 250 bytes of root + package AGENTS.md) — shorten it',
    ])
  })
})
