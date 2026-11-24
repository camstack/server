import { describe, expect, it, vi } from 'vitest'
import type { IAppSourceProvider } from '@camstack/types'
import { aggregateApps } from '../../../system/src/builtins/apps-aggregator/aggregate-apps.js'
import { buildAdminApp } from '../../../addon-admin-ui/src/server/admin-app'
import { createViewerAppSourceProvider } from '../viewer-app-source.js'

// The two real providers behind the aggregator (D1096), not fakes of them.
const sources: ReadonlyArray<IAppSourceProvider & { id: string }> = [
  { id: 'pipeline-orchestrator', ...createViewerAppSourceProvider() },
  { id: 'admin-ui', listApps: async () => [buildAdminApp()] },
]
const logger = { warn: vi.fn() }

describe('apps.listApps over the real providers', () => {
  it('offers Viewer then Admin to an admin', async () => {
    const out = await aggregateApps(sources, { isAdmin: true }, logger)
    expect(out.map((i) => i.app.id)).toEqual(['viewer', 'admin'])
  })

  it('offers only the Viewer to a non-admin', async () => {
    const out = await aggregateApps(sources, { isAdmin: false }, logger)
    expect(out.map((i) => i.app.id)).toEqual(['viewer'])
  })

  it('gives an admin the Admin nav from the shared table', async () => {
    const out = await aggregateApps(sources, { isAdmin: true }, logger)
    const admin = out.find((i) => i.app.id === 'admin')
    expect(admin?.app.nav.flatMap((s) => s.items).length).toBeGreaterThan(5)
  })
})
