/**
 * How the ONE crop convention reaches the runner.
 *
 * `pipeline-orchestrator` owns it as a cluster-global setting; the runner is
 * its only consumer, because the runner is the only process that cuts a detail
 * crop. Reading it through the hub-routed `addon-settings` cap is the same
 * neutral-owner idiom `decoder-backend.ts` uses, and it is deliberately NOT
 * carried on the per-camera attach config: eleven call sites build a
 * `RunnerCameraConfig`, and a value that eleven builders must remember to
 * copy is a value that will eventually arrive at only ten of them.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DETAIL_CROP_CONVENTION,
  DETAIL_CROP_PADDING_KEY,
  DETAIL_CROP_SQUARE_KEY,
  type HydratedSettingsView,
} from '@camstack/types'
import {
  CropConventionSource,
  CROP_CONVENTION_OWNER_ADDON_ID,
  type CropConventionSettingsApi,
} from '../crop-convention-source.js'

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

function viewWith(padding: unknown, square: unknown): HydratedSettingsView {
  return {
    sections: [
      {
        fields: [
          { key: DETAIL_CROP_PADDING_KEY, value: padding },
          { key: DETAIL_CROP_SQUARE_KEY, value: square },
        ],
      },
    ],
  }
}

function apiReturning(view: HydratedSettingsView, calls: unknown[]): CropConventionSettingsApi {
  return {
    addonSettings: {
      getGlobalSettings: {
        query: async (input: { addonId: string }) => {
          calls.push(input)
          return view
        },
      },
    },
  }
}

describe('CropConventionSource', () => {
  it('serves the default until the first read lands — never a value nobody chose', () => {
    const source = new CropConventionSource({ logger: silentLogger })
    expect(source.current()).toEqual(DEFAULT_DETAIL_CROP_CONVENTION)
  })

  it('reads the convention from the ORCHESTRATOR global settings', async () => {
    const calls: unknown[] = []
    const source = new CropConventionSource({ logger: silentLogger })
    await source.refresh(apiReturning(viewWith(0.5, true), calls))

    expect(calls).toEqual([{ addonId: CROP_CONVENTION_OWNER_ADDON_ID }])
    expect(CROP_CONVENTION_OWNER_ADDON_ID).toBe('pipeline-orchestrator')
    expect(source.current()).toEqual({ paddingRatio: 0.5, square: true })
  })

  it('is CLUSTER-wide: the read never carries a nodeId', async () => {
    // A `nodeId` would make `addon-settings` project that node's scoped value,
    // which is precisely the per-node split this setting exists to prevent.
    const calls: Array<Record<string, unknown>> = []
    const source = new CropConventionSource({ logger: silentLogger })
    await source.refresh(apiReturning(viewWith(0.2, false), calls))
    expect(calls[0]).not.toHaveProperty('nodeId')
  })

  it('caches within the TTL and re-reads after it', async () => {
    const query = vi.fn(async () => viewWith(0.2, false))
    const api = { addonSettings: { getGlobalSettings: { query } } }
    let now = 1_000
    const source = new CropConventionSource({ logger: silentLogger, now: () => now, ttlMs: 10_000 })

    await source.refresh(api)
    await source.refresh(api)
    expect(query).toHaveBeenCalledTimes(1)

    now += 10_001
    await source.refresh(api)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('a failed read KEEPS the last known convention rather than reverting mid-pass', async () => {
    // Reverting to the default on a transient error would change the meaning of
    // every vector written for the rest of the pass, with no operator action.
    const source = new CropConventionSource({ logger: silentLogger, ttlMs: 0 })
    await source.refresh(apiReturning(viewWith(0.5, true), []))
    expect(source.current()).toEqual({ paddingRatio: 0.5, square: true })

    await source.refresh({
      addonSettings: {
        getGlobalSettings: {
          query: async () => {
            throw new Error('transport-failed (addon not loaded)')
          },
        },
      },
    })
    expect(source.current()).toEqual({ paddingRatio: 0.5, square: true })
  })

  it('a failed read is LOUD — an unreadable convention is a silent index corruptor otherwise', async () => {
    const warn = vi.fn()
    const source = new CropConventionSource({
      logger: { ...silentLogger, warn },
      ttlMs: 0,
    })
    await source.refresh({
      addonSettings: {
        getGlobalSettings: {
          query: async () => {
            throw new Error('boom')
          },
        },
      },
    })
    expect(warn).toHaveBeenCalled()
  })

  it('no api surface at all resolves to the default without throwing', async () => {
    const source = new CropConventionSource({ logger: silentLogger })
    await source.refresh(undefined)
    expect(source.current()).toEqual(DEFAULT_DETAIL_CROP_CONVENTION)
  })
})
