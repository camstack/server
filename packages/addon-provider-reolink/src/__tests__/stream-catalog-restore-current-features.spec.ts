/**
 * #666 — the FIRST catalog pull after a restart is served from the durable
 * slice. A slice written by a pre-#459 build carries `battery-operated` without
 * `sleeps`; the broker reads that list to decide whether a default prebuffer
 * hold may open, so the restored catalog must carry the camera's CURRENT
 * features, never the stored ones.
 */
import { streamCatalogCapability } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { ReolinkCamera } from '../reolink-camera.js'

const STALE = {
  descriptors: [
    {
      camStreamId: 'native:main',
      kind: 'pull-rfc4571',
      label: 'main',
      url: 'lazy:rfc4571:native:main',
      autoEligible: true,
      deviceFeatures: ['battery-operated'],
    },
  ],
  lastFetchedAt: 1,
}

describe('ReolinkCamera.buildStreamCatalog — cold restore', () => {
  it('the first pull carries the current features, not the stored ones', async () => {
    const getCapState = vi.fn((name: string) =>
      name === streamCatalogCapability.name ? STALE : undefined,
    )
    const subject = {
      id: 640,
      features: ['battery-operated', 'sleeps'],
      sleeping: true,
      cachedStreamDescriptors: undefined,
      runtimeState: { getCapState },
      withLiveNativeSdp: (d: unknown) => d,
      restoreStreamCatalogFromLedger: Reflect.get(
        ReolinkCamera.prototype,
        'restoreStreamCatalogFromLedger',
      ),
      ctx: { logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } },
    }
    const out: { deviceFeatures: string[] }[] = await Reflect.apply(
      Reflect.get(ReolinkCamera.prototype, 'buildStreamCatalog'),
      subject,
      [],
    )
    expect(out[0]!.deviceFeatures).toEqual(['battery-operated', 'sleeps'])
    expect(subject.cachedStreamDescriptors).toBeDefined()
  })
})
