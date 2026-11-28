import { describe, expect, it } from 'vitest'
import { AppDeclarationSchema } from '@dominevo/types'
import { createViewerAppSourceProvider } from '../viewer-app-source.js'

describe('viewer app-source', () => {
  it('declares exactly the Viewer app, valid against the cap schema', async () => {
    const apps = await createViewerAppSourceProvider().listApps()
    expect(apps).toHaveLength(1)
    const [viewer] = apps
    expect(AppDeclarationSchema.safeParse(viewer).success).toBe(true)
    expect(viewer?.id).toBe('viewer')
    expect(viewer?.label).toEqual({ key: 'apps.viewer', fallback: 'Viewer' })
    expect(viewer?.entry).toEqual({
      kind: 'web',
      path: '/viewer/camstack/',
      auth: 'session-cookie',
    })
    expect(viewer?.adminOnly).toBe(false)
  })

  it('publishes no nav (its tabs stay in its own bar) and declares settings', async () => {
    const [viewer] = await createViewerAppSourceProvider().listApps()
    expect(viewer?.nav).toEqual([])
    expect(viewer?.settings?.path).toBe('/settings')
  })
})
