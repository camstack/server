import { describe, expect, it } from 'vitest'
import { requireWorkspaceRoot } from '@camstack/develop'
import {
  clearKnowledgeCache,
  decisionsForPath,
  getDecision,
  getKnowledgeIndex,
  normalizeAdrId,
} from '../knowledge/index.js'

describe('knowledge index', () => {
  const root = requireWorkspaceRoot()

  it('normalizes ADR ids', () => {
    expect(normalizeAdrId('9')).toBe('D9')
    expect(normalizeAdrId('D9')).toBe('D9')
    expect(normalizeAdrId('adr-0009')).toBe('D9')
  })

  it('indexes ADRs and resolves get_decision', () => {
    clearKnowledgeCache()
    const index = getKnowledgeIndex(root, { memoryRoots: [], skillRoots: [] })
    expect(index.docs.some((d) => d.kind === 'adr')).toBe(true)
    const d2 = getDecision(index, 'D2')
    expect(d2).toBeTruthy()
    expect(d2!.title.length).toBeGreaterThan(5)
    expect(String(d2!.meta?.decision ?? d2!.body).length).toBeGreaterThan(20)
  })

  it('searches architecture docs', () => {
    clearKnowledgeCache()
    const index = getKnowledgeIndex(root, { memoryRoots: [], skillRoots: [] })
    const hits = index.search('capability mount collection', { kinds: ['architecture'], limit: 5 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.snippet.length).toBeGreaterThan(0)
  })

  it('decisions_for_path matches applies-to', () => {
    clearKnowledgeCache()
    const index = getKnowledgeIndex(root, { memoryRoots: [], skillRoots: [] })
    const hits = decisionsForPath(index, 'packages/types/src/interfaces/addon.ts')
    expect(hits.some((h) => h.id === 'D2')).toBe(true)
  })
})
