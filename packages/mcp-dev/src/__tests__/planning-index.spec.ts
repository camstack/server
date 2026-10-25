import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearKnowledgeCache, getKnowledgeIndex } from '../knowledge/index.js'
import { readSection } from '../knowledge/read.js'

const roots: string[] = []

function tempBase(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-planning-'))
  roots.push(base)
  return base
}

afterEach(() => {
  clearKnowledgeCache()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

/**
 * A worktree whose parent is still inside the main checkout. The planning
 * clone is the sibling of that checkout, not of the worktree.
 */
function worktreeFixture(base: string): { workspace: string; planning: string } {
  const main = path.join(base, 'camstack-server')
  const workspace = path.join(main, '.claude', 'worktrees', 'job')
  const gitDir = path.join(main, '.git', 'worktrees', 'job')
  fs.mkdirSync(gitDir, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, '.git'), `gitdir: ${gitDir}\n`, 'utf8')
  const planning = path.join(base, 'planning')
  fs.mkdirSync(planning, { recursive: true })
  return { workspace, planning }
}

function write(dir: string, rel: string, text: string): void {
  const abs = path.join(dir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text, 'utf8')
}

describe('planning clone index', () => {
  it('indexes the sibling clone from a worktree and tags hits as planning', () => {
    const base = tempBase()
    const { workspace, planning } = worktreeFixture(base)
    write(planning, 'sessions/2026-10.md', '# October\n\nzzplanningneedle-quay is the marker.\n')
    write(planning, 'ideas.md', '# Ideas\n\nzzideasneedle-quay\n')
    write(planning, 'superpowers/specs/note.md', '# Spec\n\nzzsuperneedle-quay\n')
    write(planning, 'archive/handover.md', '# Handover\n\nzzarchneedle-quay\n')
    write(planning, 'infra/VERDICTS.md', '# Infra\n\nzzinfraneedle-quay\n')
    write(planning, '.superpowers/sdd/task.md', '# Task\n\nzzsddneedle-quay\n')
    write(planning, 'shipped.md', 'zzshippedneedle-quay must stay out of the index\n')
    write(
      path.join(base, 'camstack-server', '.claude', 'worktrees'),
      'planning/sessions/decoy.md',
      'zzdecoyneedle-quay is the worktree sibling, not the clone\n',
    )

    const index = getKnowledgeIndex(workspace, { memoryRoots: [], skillRoots: [] })
    expect(index.planning.present).toBe(true)
    expect(index.planning.notice).toBeNull()

    const hit = index.search('zzplanningneedle-quay', { kinds: ['planning'], limit: 5 })[0]
    expect(hit).toBeTruthy()
    expect(hit!.source).toBe('planning')
    expect(hit!.relativePath).toBe('sessions/2026-10.md')
    expect(hit!.snippet).toContain('zzplanningneedle-quay')

    const section = readSection(index, hit!.id)
    expect(section).toBeTruthy()
    expect(section!.source).toBe('planning')
    expect(section!.text).toContain('zzplanningneedle-quay')

    expect(index.search('zzideasneedle-quay', { kinds: ['planning'] })[0]?.relativePath).toBe(
      'ideas.md',
    )
    expect(index.search('zzsuperneedle-quay', { kinds: ['planning'] })[0]?.relativePath).toBe(
      'superpowers/specs/note.md',
    )
    expect(index.search('zzarchneedle-quay', { kinds: ['planning'] })[0]?.relativePath).toBe(
      'archive/handover.md',
    )
    expect(index.search('zzinfraneedle-quay', { kinds: ['planning'] })[0]?.relativePath).toBe(
      'infra/VERDICTS.md',
    )
    expect(index.search('zzsddneedle-quay', { kinds: ['planning'] })[0]?.relativePath).toBe(
      '.superpowers/sdd/task.md',
    )
    expect(index.search('zzshippedneedle-quay', { kinds: ['planning'] })).toEqual([])
    expect(index.search('zzdecoyneedle-quay', { kinds: ['planning'] })).toEqual([])
  })

  it('indexes nothing and reports the absence once when the clone is missing', () => {
    const base = tempBase()
    const workspace = path.join(base, 'camstack-server', '.claude', 'worktrees', 'job')
    fs.mkdirSync(workspace, { recursive: true })

    const index = getKnowledgeIndex(workspace, { memoryRoots: [], skillRoots: [] })
    expect(index.planning.present).toBe(false)
    expect(index.planning.notice).toMatch(/indexed nothing/)
    expect(index.planning.notice).toMatch(/\.\.\/planning/)
    expect(index.docs.filter((doc) => doc.source === 'planning')).toEqual([])
    expect(index.search('zzplanningneedle-quay')).toEqual([])
    expect(() => index.search('anything')).not.toThrow()
  })
})
