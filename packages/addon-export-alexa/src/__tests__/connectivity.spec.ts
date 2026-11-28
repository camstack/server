import type { AddonApi, IScopedLogger } from '@dominevo/types'
import { describe, expect, it, vi } from 'vitest'
import { readConnectivity } from '../connectivity.js'

const logger = { debug: vi.fn() } as unknown as IScopedLogger

function apiAnswering(slice: unknown): AddonApi {
  return {
    deviceStatus: { getStatus: { query: vi.fn(async () => slice) } },
  } as unknown as AddonApi
}

describe('readConnectivity (D1099)', () => {
  it('offline is UNREACHABLE', async () => {
    expect(await readConnectivity(apiAnswering({ online: false }), 1, logger)).toBe('UNREACHABLE')
  })

  it('an unknown slice (provider not answered since a restart) is OK, not UNREACHABLE', async () => {
    expect(await readConnectivity(apiAnswering({ online: false, unknown: true }), 1, logger)).toBe(
      'OK',
    )
  })
})
