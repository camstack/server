import { describe, expect, it } from 'vitest'
import { headingsOf, normalizeHeading, packSyncProblems } from '../check-skill-pack-sync'

const fm = (id: string): string => `---\nname: ${id}\ndescription: x\n---\n\n`
const README = '| `a` | [a.md](./a.md) | job |'
const pack = (body = '## 1. Define it\n\ntext\n') => ({ id: 'a', text: `${fm('a')}# A\n\n${body}` })
const overlay = (body = '## Repo notes\n\ntext\n', pointer = 'packages/develop/skills/a.md') => ({
  id: 'a',
  text: `${fm('a')}# A overlay\n\nCanonical: \`${pointer}\`\n\n${body}`,
})

describe('headings', () => {
  it('matches on the words, not the number or the trailing gloss', () => {
    expect(normalizeHeading('## 3. Hand-edits — then codegen')).toBe('hand-edits')
    expect(normalizeHeading('### `Done-gate`')).toBe('done-gate')
  })

  it('ignores a "## " line inside a code fence', () => {
    expect(headingsOf('# T\n\n```\n## not a heading\n```\n\n## Real\n')).toEqual(['real'])
  })
})

describe('packSyncProblems', () => {
  it('passes a pointing overlay with its own sections', () => {
    expect(packSyncProblems([pack()], [overlay()], README)).toEqual([])
  })

  it('passes a public-only pack skill (no repo skill)', () => {
    expect(packSyncProblems([pack()], [], README)).toEqual([])
  })

  it('fails an overlay that does not point at the pack text', () => {
    const p = packSyncProblems([pack()], [overlay(undefined, 'elsewhere.md')], README)
    expect(p.join('\n')).toContain('must point at its canonical public text')
  })

  it('fails a section written in both places', () => {
    const p = packSyncProblems([pack()], [overlay('## 4. Define it — again\n\ntext\n')], README)
    expect(p.join('\n')).toContain('section "define it" is also in packages/develop/skills/a.md')
  })

  it('fails a pack skill whose name is not its id', () => {
    const bad = { id: 'a', text: `${fm('b')}# A\n` }
    expect(packSyncProblems([bad], [], README).join('\n')).toContain('frontmatter name')
  })

  it('fails a pack link that leaves the pack', () => {
    const bad = pack('See [D4](../../../docs/decisions/adr-0004.md).\n')
    expect(packSyncProblems([bad], [], README).join('\n')).toContain('links outside the pack')
  })

  it('fails a pack file missing from the pack README', () => {
    expect(packSyncProblems([pack()], [], 'nothing').join('\n')).toContain('not listed')
  })
})
