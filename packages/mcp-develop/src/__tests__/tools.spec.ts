import { describe, expect, it } from 'vitest'
import { findWorkspaceRoot, listAddonPackages, listSkills, readSkill } from '@camstack/develop'

describe('mcp-develop wiring (library surface)', () => {
  it('resolves the workspace and lists addons + skills', () => {
    const root = findWorkspaceRoot()
    expect(root).toBeTruthy()
    if (!root) return
    expect(listAddonPackages(root).length).toBeGreaterThan(5)
    const skills = listSkills()
    expect(skills.map((s) => s.id)).toEqual(
      expect.arrayContaining([
        'camstack-addon',
        'camstack-capability',
        'camstack-secrets',
        'camstack-docs',
        'architecture',
        'track-review',
      ]),
    )
    // The pre-rename ids still resolve, to the renamed files.
    expect(readSkill('track-review')?.content).toContain('track_review_apply')
    expect(readSkill('add-addon')?.info.id).toBe('camstack-addon')
    expect(readSkill('sync-docs')?.content).toContain('name: camstack-docs')
  })
})
