import { beforeAll, describe, expect, it } from 'vitest'
import { requireWorkspaceRoot } from '@camstack/develop'
import { readSection } from '../knowledge/read.js'
import {
  clearKnowledgeCache,
  decisionsForPath,
  getDecision,
  getKnowledgeIndex,
  normalizeAdrId,
  trapsFor,
} from '../knowledge/index.js'

describe('knowledge index', () => {
  const root = requireWorkspaceRoot()
  let index: ReturnType<typeof getKnowledgeIndex>

  // The index walks and tokenizes every doc (~1 s idle, 10 s+ under machine load).
  // Build it once for the file instead of once per test; no test mutates it.
  beforeAll(() => {
    clearKnowledgeCache()
    index = getKnowledgeIndex(root, { memoryRoots: [], skillRoots: [] })
  }, 60_000)

  it('normalizes ADR ids', () => {
    expect(normalizeAdrId('9')).toBe('D9')
    expect(normalizeAdrId('D9')).toBe('D9')
    expect(normalizeAdrId('adr-0009')).toBe('D9')
  })

  it('indexes ADRs and resolves get_decision', () => {
    expect(index.docs.some((d) => d.kind === 'adr')).toBe(true)
    const d2 = getDecision(index, 'D2')
    expect(d2).toBeTruthy()
    expect(d2!.title.length).toBeGreaterThan(5)
    expect(String(d2!.meta?.decision ?? d2!.body).length).toBeGreaterThan(20)
  })

  it('searches architecture docs', () => {
    const hits = index.search('capability mount collection', { kinds: ['architecture'], limit: 5 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.snippet.length).toBeGreaterThan(0)
  })

  it('decisions_for_path matches applies-to', () => {
    const hits = decisionsForPath(index, 'packages/types/src/interfaces/addon.ts')
    expect(hits.some((h) => h.id === 'D2')).toBe(true)
  })

  it('traps_for surfaces the integration traps and read_section returns them whole', () => {
    const { skills } = trapsFor(
      index,
      'integration globalSettingsSchema integration_settings gateway sibling',
    )
    const hit = skills.find((h) => h.id === 'skill:camstack-addon#integration-traps')
    expect(hit).toBeTruthy()
    const section = readSection(index, 'skill:camstack-addon#integration-traps')
    expect(section?.truncated).toBe(false)
    for (const trap of [
      'globalSettingsSchema()',
      'integration_settings',
      'integrations.getSettings',
      'D987 migration',
      'sibling, never a parent',
      'must provide `integration-instances`',
    ]) {
      expect(section?.text, trap).toContain(trap)
    }
  })
})
