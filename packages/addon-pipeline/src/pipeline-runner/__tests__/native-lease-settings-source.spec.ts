/**
 * The runner's read of the cluster-wide native-lease knobs.
 *
 * Same shape and the same failure modes as `crop-convention-source.ts`: a read
 * that fails must keep the last known value (a mid-flight revert to defaults
 * would silently change the RAM profile of every worker spawned after it), and
 * the read must NOT be node-scoped (a per-node projection would let two nodes
 * hold different lease windows for the same camera).
 */

import {
  DEFAULT_NATIVE_LEASE_SETTINGS,
  NATIVE_LEASE_ADMISSION_KEY,
  NATIVE_LEASE_HOLD_KEY,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  NATIVE_LEASE_OWNER_ADDON_ID,
  NativeLeaseSettingsSource,
} from '../native-lease-settings-source.js'

function logger(): {
  info: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
} {
  return { info: vi.fn(), warn: vi.fn() }
}

function apiReturning(query: ReturnType<typeof vi.fn>): {
  addonSettings: { getGlobalSettings: { query: typeof query } }
} {
  return { addonSettings: { getGlobalSettings: { query } } }
}

const VIEW_HOLD = {
  sections: [{ fields: [{ key: NATIVE_LEASE_HOLD_KEY, value: 16 }] }],
}

/**
 * The one admission value that is NOT the shipped default — derived, because a
 * hardcoded one silently stops testing anything the day the default is flipped
 * to it (`readNativeLeaseOverride` treats a knob AT its default as unset).
 */
const NON_DEFAULT_ADMISSION =
  DEFAULT_NATIVE_LEASE_SETTINGS.admission === 'inferred' ? 'all' : 'inferred'

/** The same cluster, after the operator ALSO chose a non-default admission. */
const VIEW_HOLD_ADMISSION = {
  sections: [
    {
      fields: [
        { key: NATIVE_LEASE_HOLD_KEY, value: 16 },
        { key: NATIVE_LEASE_ADMISSION_KEY, value: NON_DEFAULT_ADMISSION },
      ],
    },
  ],
}

describe('NativeLeaseSettingsSource', () => {
  // Found live: `sameOverride` compared only the three NUMERIC knobs, so a
  // change to `admission` alone was fetched from the hub, judged identical to
  // the cached override, and dropped. The setting was stored, served and read,
  // and no decode worker ever saw it — with no log line anywhere, because the
  // "settings changed" line is on the far side of that same comparison.
  it('adopts a change to a knob whose siblings did not move', async () => {
    const log = logger()
    let now = 0
    const source = new NativeLeaseSettingsSource({ logger: log, now: () => now, ttlMs: 10 })
    await source.refresh(apiReturning(vi.fn().mockResolvedValue(VIEW_HOLD)))
    expect(source.current()).toEqual({ holdFrames: 16 })
    now += 100
    await source.refresh(apiReturning(vi.fn().mockResolvedValue(VIEW_HOLD_ADMISSION)))
    expect(source.current()).toEqual({ holdFrames: 16, admission: NON_DEFAULT_ADMISSION })
    expect(log.info).toHaveBeenCalledTimes(2)
  })

  it('starts with no override — the worker then resolves env/default', () => {
    expect(new NativeLeaseSettingsSource({ logger: logger() }).current()).toEqual({})
  })

  it('reads the owner addon global settings, unscoped by node', async () => {
    const query = vi.fn().mockResolvedValue(VIEW_HOLD)
    const source = new NativeLeaseSettingsSource({ logger: logger() })
    await source.refresh(apiReturning(query))
    expect(query).toHaveBeenCalledWith({
      addonId: NATIVE_LEASE_OWNER_ADDON_ID,
    })
    expect(query.mock.calls[0]?.[0]).not.toHaveProperty('nodeId')
    expect(source.current()).toEqual({ holdFrames: 16 })
  })

  it('serves the cached value within the TTL and re-reads after it', async () => {
    const query = vi.fn().mockResolvedValue(VIEW_HOLD)
    let now = 1_000
    const source = new NativeLeaseSettingsSource({
      logger: logger(),
      now: () => now,
      ttlMs: 30_000,
    })
    await source.refresh(apiReturning(query))
    await source.refresh(apiReturning(query))
    expect(query).toHaveBeenCalledTimes(1)
    now += 30_001
    await source.refresh(apiReturning(query))
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('keeps the last known value when a read fails, and says so', async () => {
    const log = logger()
    const source = new NativeLeaseSettingsSource({ logger: log })
    await source.refresh(apiReturning(vi.fn().mockResolvedValue(VIEW_HOLD)))
    const failing = new NativeLeaseSettingsSource({ logger: log })
    await failing.refresh(apiReturning(vi.fn().mockRejectedValue(new Error('hub down'))))
    expect(source.current()).toEqual({ holdFrames: 16 })
    expect(log.warn).toHaveBeenCalled()
  })

  it('an absent api is a no-op, not a revert', async () => {
    const source = new NativeLeaseSettingsSource({ logger: logger() })
    await source.refresh(apiReturning(vi.fn().mockResolvedValue(VIEW_HOLD)))
    await source.refresh(undefined)
    expect(source.current()).toEqual({ holdFrames: 16 })
  })

  it('logs the change once — the anchor for "the workers changed size on Tuesday"', async () => {
    const log = logger()
    let now = 0
    const source = new NativeLeaseSettingsSource({
      logger: log,
      now: () => now,
      ttlMs: 10,
    })
    await source.refresh(apiReturning(vi.fn().mockResolvedValue(VIEW_HOLD)))
    expect(log.info).toHaveBeenCalledTimes(1)
    now += 100
    await source.refresh(apiReturning(vi.fn().mockResolvedValue(VIEW_HOLD)))
    expect(log.info).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight read across concurrent callers', async () => {
    const query = vi.fn().mockResolvedValue(VIEW_HOLD)
    const source = new NativeLeaseSettingsSource({ logger: logger() })
    const api = apiReturning(query)
    await Promise.all([source.refresh(api), source.refresh(api), source.refresh(api)])
    expect(query).toHaveBeenCalledTimes(1)
  })
})
