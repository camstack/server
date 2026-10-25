import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearKnowledgeCache, getKnowledgeIndex } from '../knowledge/index.js'
import { nextAdrNumber, readSection } from '../knowledge/read.js'

const roots: string[] = []

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-read-section-'))
  roots.push(root)
  return root
}

function write(root: string, rel: string, text: string): void {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text, 'utf8')
}

afterEach(() => {
  clearKnowledgeCache()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('readSection', () => {
  it('returns one architecture section past the search-index slice', () => {
    const root = fixtureRoot()
    const filler = 'abcdefghij'.repeat(900)
    write(
      root,
      'docs/architecture/object-detection.md',
      [
        '# Intro',
        '',
        'preamble',
        '',
        '# The package drop gate chain',
        '',
        'START_MARKER',
        filler,
        'END_MARKER',
        '',
        '# Other',
        '',
        'other section',
        '',
      ].join('\n'),
    )
    const index = getKnowledgeIndex(root, { memoryRoots: [], skillRoots: [] })
    const id = 'arch:object-detection#the-package-drop-gate-chain'
    const section = readSection(index, id)
    expect(section).not.toBeNull()
    expect(section!.id).toBe(id)
    expect(section!.truncated).toBe(false)
    expect(section!.text).toContain('START_MARKER')
    expect(section!.text).toContain('END_MARKER')
    expect(section!.text.length).toBeGreaterThan(8000)
    expect(section!.text).not.toContain('other section')
  })

  it('truncates a section past 12 KB and says so', () => {
    const root = fixtureRoot()
    write(
      root,
      'docs/architecture/object-detection.md',
      `# Huge section\n\n${'z'.repeat(13_000)}\nTAIL_SHOULD_DROP\n`,
    )
    const index = getKnowledgeIndex(root, { memoryRoots: [], skillRoots: [] })
    const section = readSection(index, 'arch:object-detection#huge-section')
    expect(section).not.toBeNull()
    expect(section!.truncated).toBe(true)
    expect(section!.text).toContain('truncated')
    expect(section!.text).not.toContain('TAIL_SHOULD_DROP')
  })

  it('returns the whole decision file, including text the search body omits', () => {
    const root = fixtureRoot()
    write(
      root,
      'docs/decisions/adr-0010-ten.md',
      [
        '---',
        'id: D10',
        'title: Ten',
        '---',
        '',
        '## Decision',
        '',
        'Do the thing.',
        '',
        '## Notes',
        '',
        'ONLY_IN_FULL_FILE',
        '',
      ].join('\n'),
    )
    const index = getKnowledgeIndex(root, { memoryRoots: [], skillRoots: [] })
    const section = readSection(index, 'D10')
    expect(section).not.toBeNull()
    expect(section!.text).toContain('ONLY_IN_FULL_FILE')
    expect(section!.truncated).toBe(false)
  })

  it('returns a skill by the id search_knowledge uses, past the index slice', () => {
    const root = fixtureRoot()
    write(root, '.claude/skills/demo-skill/SKILL.md', `# demo\n\n${'s'.repeat(8500)}\nSKILL_TAIL\n`)
    const index = getKnowledgeIndex(root, { memoryRoots: [], skillRoots: [] })
    const section = readSection(index, 'skill:demo-skill')
    expect(section).not.toBeNull()
    expect(section!.text).toContain('SKILL_TAIL')
    expect(section!.truncated).toBe(false)
  })

  it('returns null for an id the index does not have', () => {
    const root = fixtureRoot()
    write(root, 'docs/architecture/object-detection.md', '# Intro\n\npreamble\n')
    const index = getKnowledgeIndex(root, { memoryRoots: [], skillRoots: [] })
    expect(readSection(index, 'arch:missing#nope')).toBeNull()
  })
})

describe('nextAdrNumber', () => {
  it('is one past the highest adr file and ignores index.md', () => {
    const root = fixtureRoot()
    const dir = path.join(root, 'docs', 'decisions')
    write(root, 'docs/decisions/adr-0002-two.md', '# two\n')
    write(root, 'docs/decisions/adr-0010-ten.md', '# ten\n')
    write(root, 'docs/decisions/index.md', 'next would be D9999 if this file counted\n')
    write(root, 'docs/decisions/template.md', '# template\n')
    const next = nextAdrNumber(dir)
    expect(next).toEqual({
      next: 11,
      id: 'D11',
      filePattern: 'docs/decisions/adr-0011-<slug>.md',
    })
  })

  it('starts at 1 when the directory has no decision files', () => {
    const root = fixtureRoot()
    const dir = path.join(root, 'docs', 'decisions')
    fs.mkdirSync(dir, { recursive: true })
    expect(nextAdrNumber(dir).next).toBe(1)
    expect(nextAdrNumber(dir).filePattern).toBe('docs/decisions/adr-0001-<slug>.md')
  })
})
