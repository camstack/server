import { describe, expect, it, vi } from 'vitest'
import { AppDeclarationSchema, type IAppSourceProvider } from '@camstack/types'
import { createBenchmarkAppSourceProvider } from '../../../addon-benchmark/src/app-source'
import { createModelStudioAppSourceProvider } from '../../../addon-model-studio/src/app-source'
import { createHomematicAppSourceProvider } from '../../../addon-provider-homematic/src/app-source'
import {
  aggregateApps,
  type AppSourceEntry,
} from '../../../system/src/builtins/apps-aggregator/aggregate-apps.js'

// planning#734: the existing custom pages of three addons are admin-only apps
// in the shell drawer. These are the real providers behind the aggregator.
const sources: readonly AppSourceEntry[] = [
  { id: 'benchmark', ...createBenchmarkAppSourceProvider() },
  { id: 'model-studio', ...createModelStudioAppSourceProvider() },
  { id: 'provider-homematic', ...createHomematicAppSourceProvider() },
]
const logger = { warn: vi.fn() }

describe('admin-only addon page apps', () => {
  it('offers the three pages to an admin, each the addon page it is today', async () => {
    const out = await aggregateApps(sources, { isAdmin: true }, logger)
    expect(out.map((i) => i.app.id)).toEqual(['benchmark', 'model-studio', 'homematic-ccu'])
    expect(out.map((i) => i.app.entry)).toEqual([
      { kind: 'addon-page', pageId: 'benchmark' },
      { kind: 'addon-page', pageId: 'model-studio' },
      { kind: 'addon-page', pageId: 'homematic-ccu' },
    ])
    for (const info of out) {
      expect(AppDeclarationSchema.safeParse(info.app).success).toBe(true)
      expect(info.app.nav.flatMap((s) => s.items.map((n) => n.path))).toEqual([
        `/addon/${info.app.id}`,
      ])
    }
  })

  it('offers none of them to a non-admin user', async () => {
    const out = await aggregateApps(sources, { isAdmin: false }, logger)
    expect(out).toEqual([])
  })

  it('declares every page adminOnly at the source, so the filter has something to act on', async () => {
    for (const source of sources) {
      const provider: IAppSourceProvider = source
      for (const app of await provider.listApps()) expect(app.adminOnly).toBe(true)
    }
  })
})
