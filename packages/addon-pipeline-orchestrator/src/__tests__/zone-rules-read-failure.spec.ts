/**
 * A store that could not answer must not be indistinguishable from a camera
 * with no rules — and must not become PERMANENT.
 *
 * `listRules` folds a read error into `[]`, which is right for a consumer that
 * only filters. Two things were wrong underneath it:
 *
 *  1. The fold was cached. The per-device/per-stage cache is keyed by
 *     PRESENCE, and an empty array is a legitimate cached value, so one
 *     transient `readDeviceStore` rejection pinned that device+stage to "no
 *     rules" for the rest of the process's life. A momentary blip became a
 *     permanent one — and for the `package` stage, whose emptiness strips
 *     `package-detection` from the resolved pipeline, permanently invisible.
 *
 *  2. There was no way for a caller that CARES to tell the two apart.
 *     `listRulesChecked` is that way.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ZoneRule, IScopedLogger, DeviceProxy } from '@camstack/types'
import { ZoneRulesProvider } from '../zone-rules-provider.js'

const packageRule: ZoneRule = {
  id: 'p-1',
  name: 'Front porch drop zone',
  zoneIds: ['z-porch'],
  mode: 'include',
  classFilter: ['package'],
  enabled: true,
}

function makeLogger(): {
  logger: IScopedLogger
  warn: ReturnType<typeof vi.fn>
} {
  const warn = vi.fn()
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: () => log,
    withTags: () => log,
  } as unknown as IScopedLogger
  return { logger: log, warn }
}

const fetchDevice = async (): Promise<DeviceProxy> =>
  ({
    deviceState: { setCapSlice: async () => undefined },
  }) as unknown as DeviceProxy

/** A store whose FIRST read throws and whose later reads succeed. */
function makeFlakyStore(): {
  readonly readDeviceStore: (id: number) => Promise<Record<string, unknown>>
  readonly writeDeviceStore: (id: number, patch: Record<string, unknown>) => Promise<void>
} {
  let calls = 0
  return {
    readDeviceStore: async () => {
      calls += 1
      if (calls === 1) throw new Error('sqlite: database is locked')
      return { zoneRules: { package: [packageRule] } }
    },
    writeDeviceStore: async () => undefined,
  }
}

function makeProvider(settings: ReturnType<typeof makeFlakyStore>): {
  readonly provider: ZoneRulesProvider
  readonly warn: ReturnType<typeof vi.fn>
} {
  const { logger, warn } = makeLogger()
  return {
    provider: new ZoneRulesProvider({ logger, settings, fetchDevice }),
    warn,
  }
}

describe('ZoneRulesProvider — a failed read', () => {
  it('is reported as a FAILURE by listRulesChecked, not as an empty list', async () => {
    const { provider } = makeProvider(makeFlakyStore())
    const read = await provider.listRulesChecked({
      deviceId: 101,
      stage: 'package',
    })
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.error).toContain('database is locked')
  })

  it('is not cached — the next read sees the rules that were there all along', async () => {
    const { provider } = makeProvider(makeFlakyStore())
    expect(await provider.listRules({ deviceId: 101, stage: 'package' })).toEqual([])
    // Before the fix this stayed [] forever: the fold of the failure was
    // written into the cache and every later read short-circuited on it.
    expect(await provider.listRules({ deviceId: 101, stage: 'package' })).toEqual([packageRule])
  })

  it('logs the failure with the deviceId tag', async () => {
    const { provider, warn } = makeProvider(makeFlakyStore())
    await provider.listRulesChecked({ deviceId: 101, stage: 'package' })
    const call = warn.mock.calls.find((c: readonly unknown[]) =>
      String(c[0]).includes('zone-rules store read failed'),
    )
    expect(call).toBeDefined()
    expect((call?.[1] as { tags?: Record<string, unknown> } | undefined)?.tags?.['deviceId']).toBe(
      101,
    )
  })

  it('a genuinely empty stage is a SUCCESSFUL read of no rules', async () => {
    const { provider } = makeProvider({
      readDeviceStore: async () => ({}),
      writeDeviceStore: async () => undefined,
    })
    const read = await provider.listRulesChecked({
      deviceId: 616,
      stage: 'package',
    })
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.rules).toEqual([])
  })
})
