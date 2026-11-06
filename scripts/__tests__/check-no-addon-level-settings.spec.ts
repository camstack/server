import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BASELINE_PATH,
  findViolations,
  retiredHooksOf,
  withoutComments,
} from '../check-no-addon-level-settings.js'
import { isProductSource, loadBaseline, ROOT, readSources, walk } from '../lib/family-baseline.js'
import { itRealTree } from './lib/real-tree.js'

const DECLARER = `
class A extends BaseAddon {
  override globalSettingsSchema() { return z.object({}) }
  integrationSettingSections = []
}
`
const CALLER =
  'await ctx.api.addonSettings.updateGlobalSettings.mutate({})\nawait x.getGlobalSettings()\n'
const PROSE =
  '// getIntegrationSettings used to live here\n/* updateGlobalSettings, globalSettingsSchema */\nconst ok = 1\n'
const file = (p: string, text: string) => ({ path: p, text })

const BASELINE = {
  families: {
    'm5-declarers': { 'packages/a/src/declarer.ts:addon-level-settings': 'P8' },
    'm5-addon-blobs': { 'packages/b/src/caller.ts:addon-level-settings': 'P8' },
  },
}
const FILES = [
  file('packages/a/src/declarer.ts', DECLARER),
  file('packages/b/src/caller.ts', CALLER),
]

describe('check-no-addon-level-settings', () => {
  it('names the retired hooks and ignores comments', () => {
    expect(retiredHooksOf(DECLARER)).toEqual(['globalSettingsSchema', 'integrationSettingSections'])
    expect(retiredHooksOf(CALLER)).toEqual(['updateGlobalSettings', 'getGlobalSettings'])
    expect(retiredHooksOf(PROSE)).toEqual([])
    expect(withoutComments("const u = 'http://x'; // c")).toContain("'http://x'")
  })

  it('is green on a baseline that lists every file', () => {
    expect(findViolations([...FILES, file('packages/c/src/prose.ts', PROSE)], BASELINE)).toEqual([])
  })

  it('is red when a baseline line is removed', () => {
    const found = findViolations(FILES, {
      families: { 'm5-declarers': BASELINE.families['m5-declarers'] },
    })
    expect(found).toHaveLength(1)
    expect(found[0]?.where).toBe('packages/b/src/caller.ts')
  })

  it('is red on a stale entry (the addon moved its settings)', () => {
    const found = findViolations([FILES[0] as (typeof FILES)[number]], BASELINE)
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('remove the line')
  })

  it('is red on a new use of a retired hook', () => {
    const found = findViolations(
      [...FILES, file('packages/d/src/new.ts', 'x.getIntegrationSettings()')],
      BASELINE,
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('D986')
  })

  itRealTree('holds on the committed tree and baseline', { timeout: 120_000 }, () => {
    const files = [
      ...walk(path.join(ROOT, 'packages'), isProductSource),
      ...walk(path.join(ROOT, 'server'), isProductSource),
    ]
    expect(findViolations(readSources(files), loadBaseline(BASELINE_PATH))).toEqual([])
  })
})
