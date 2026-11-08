import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findViolations,
  retiredHooksOf,
  withoutComments,
} from '../check-no-addon-level-settings.js'
import { isProductSource, ROOT, readSources, walk } from '../lib/family-baseline.js'
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

  it('is green on prose that only names a retired hook in a comment', () => {
    expect(findViolations([file('packages/c/src/prose.ts', PROSE)])).toEqual([])
  })

  it('refuses every file that names a retired hook: there is no baseline to list it in', () => {
    const found = findViolations(FILES)
    expect(found.map((v) => v.where)).toEqual([
      'packages/a/src/declarer.ts',
      'packages/b/src/caller.ts',
    ])
  })

  it('is red on a re-added hook', () => {
    const found = findViolations([file('packages/d/src/new.ts', 'x.getIntegrationSettings()')])
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('D986')
  })

  itRealTree('holds on the committed tree', { timeout: 120_000 }, () => {
    const files = [
      ...walk(path.join(ROOT, 'packages'), isProductSource),
      ...walk(path.join(ROOT, 'server'), isProductSource),
    ]
    expect(findViolations(readSources(files))).toEqual([])
  })
})
