/**
 * A Terminal camera must cost NOTHING.
 *
 * It is a rendered screen: object detection on it finds nothing, forever, at
 * full price. Measured on the hub 2026-08-11 for ONE terminal camera — 19
 * frames per 10 s at ~61 ms of inference each, 115 capture-scheduler requests a
 * minute, `detections=0`.
 *
 * Three things are pinned here and each one has already cost real time:
 *
 *  1. **It writes the AUTHORITY** (`deviceManager.setWrapperActive`), not the
 *     deprecated switch cap (D113). The switch was only ever writing through to
 *     this, and it is being deleted.
 *  2. **`motion-detection` is switched off too.** With the D109 gate stopping
 *     the detection producer, the motion analyzer is the remaining thing
 *     demanding decoded frames — leaving it bound keeps a decode session alive
 *     for a screen recording of a terminal.
 *  3. **A failed resolution FAILS LOUDLY.** The previous version caught
 *     everything and warned. A warn nobody reads is exactly how this tax comes
 *     back: nothing looks broken, the camera works, and the only symptom is a
 *     hub running hot for a reason nobody connects to a terminal created three
 *     weeks earlier.
 */
import type { AddonApi, IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { silenceAnalysisFor, TERMINAL_SILENCED_CAP_NAMES } from '../silence-analysis.js'

const DEVICE_ID = 3218

interface BindingRow {
  readonly capName: string
  readonly kind: string
  readonly providerAddonId: string
}

interface SetWrapperActiveCall {
  readonly deviceId: number
  readonly capName: string
  readonly wrapperAddonId: string
  readonly active: boolean
}

interface FakeWorld {
  readonly calls: SetWrapperActiveCall[]
  readonly api: AddonApi
}

/** Everything a real hub binds to a camera, plus a couple of unrelated rows. */
function defaultBindings(): readonly BindingRow[] {
  return [
    { capName: 'motion-detection', kind: 'wrapped', providerAddonId: 'motion-analyzer' },
    { capName: 'detection-pipeline', kind: 'wrapped', providerAddonId: 'pipeline-executor' },
    { capName: 'audio-analysis', kind: 'wrapped', providerAddonId: 'audio-analyzer' },
    { capName: 'pipeline-analytics', kind: 'wrapped', providerAddonId: 'post-analysis' },
    { capName: 'scene-monitor', kind: 'wrapped', providerAddonId: 'post-analysis' },
    { capName: 'privacy-mask', kind: 'native', providerAddonId: 'provider-reolink' },
    { capName: 'recording', kind: 'wrapped', providerAddonId: 'recording' },
  ]
}

function makeWorld(
  opts: {
    bindings?: readonly BindingRow[]
    bindingsThrows?: boolean
    setThrowsFor?: readonly string[]
  } = {},
): FakeWorld {
  const calls: SetWrapperActiveCall[] = []
  const api = {
    deviceManager: {
      getBindings: {
        query: async (): Promise<{ entries: readonly BindingRow[] }> => {
          if (opts.bindingsThrows) throw new Error('deviceManager unreachable')
          return { entries: opts.bindings ?? defaultBindings() }
        },
      },
      setWrapperActive: {
        mutate: async (input: SetWrapperActiveCall): Promise<void> => {
          if (opts.setThrowsFor?.includes(input.capName))
            throw new Error(`refused for ${input.capName}`)
          calls.push(input)
        },
      },
    },
  } as unknown as AddonApi
  return { calls, api }
}

function makeLogger(): { logger: IScopedLogger; error: ReturnType<typeof vi.fn> } {
  const error = vi.fn()
  const logger: IScopedLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error,
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, error }
}

describe('silenceAnalysisFor', () => {
  it('switches off every analyser the shared list names', async () => {
    // Motion is the load-bearing one for COST: it is what still asks for
    // decoded frames once the detection producer is gated. `pipeline-analytics`
    // is the load-bearing one for CORRECTNESS: it has no gate of its own except
    // this binding, so a derived camera that keeps it writes a motion episode
    // for every event it forwards.
    const world = makeWorld()
    const { logger } = makeLogger()

    await silenceAnalysisFor({ api: world.api, logger }, DEVICE_ID)

    expect(world.calls.map((c) => c.capName).sort()).toEqual(
      [...TERMINAL_SILENCED_CAP_NAMES].sort(),
    )
    expect([...TERMINAL_SILENCED_CAP_NAMES]).toContain('motion-detection')
  })

  it('writes the AUTHORITY, with the wrapper that is actually BOUND', async () => {
    // Never a hardcoded addon id: `setWrapperActive` needs the addon actually
    // providing the cap, and a guess is a silent no-op the day a second
    // provider ships.
    const world = makeWorld()
    const { logger } = makeLogger()

    await silenceAnalysisFor({ api: world.api, logger }, DEVICE_ID)

    expect(world.calls).toContainEqual({
      deviceId: DEVICE_ID,
      capName: 'detection-pipeline',
      wrapperAddonId: 'pipeline-executor',
      active: false,
    })
    expect(world.calls).toContainEqual({
      deviceId: DEVICE_ID,
      capName: 'motion-detection',
      wrapperAddonId: 'motion-analyzer',
      active: false,
    })
    expect(world.calls.every((c) => c.active === false)).toBe(true)
  })

  it('touches nothing else — recording and the camera-native caps are left alone', async () => {
    const world = makeWorld()
    const { logger } = makeLogger()

    await silenceAnalysisFor({ api: world.api, logger }, DEVICE_ID)

    expect(world.calls.map((c) => c.capName)).not.toContain('recording')
    expect(world.calls.map((c) => c.capName)).not.toContain('privacy-mask')
  })

  it('a cap nobody binds here is not an error — there is nothing to pay for', async () => {
    // A deployment with no audio analyzer has nothing to switch off. Demanding
    // one would make every terminal creation fail on a perfectly valid hub.
    const world = makeWorld({
      bindings: [
        { capName: 'detection-pipeline', kind: 'wrapped', providerAddonId: 'pipeline-executor' },
      ],
    })
    const { logger } = makeLogger()

    await silenceAnalysisFor({ api: world.api, logger }, DEVICE_ID)

    expect(world.calls.map((c) => c.capName)).toEqual(['detection-pipeline'])
  })

  it('THROWS when the bindings cannot be read — it never warns and carries on', async () => {
    // The whole point. Silently continuing leaves a screen recording running a
    // full detection pipeline, and nothing anywhere says so.
    const world = makeWorld({ bindingsThrows: true })
    const { logger, error } = makeLogger()

    await expect(silenceAnalysisFor({ api: world.api, logger }, DEVICE_ID)).rejects.toThrow(
      /full detection cost/,
    )
    expect(world.calls).toEqual([])
    expect(error).toHaveBeenCalled()
  })

  it('THROWS when ONE authority refuses, and names it', async () => {
    const world = makeWorld({ setThrowsFor: ['motion-detection'] })
    const { logger, error } = makeLogger()

    await expect(silenceAnalysisFor({ api: world.api, logger }, DEVICE_ID)).rejects.toThrow(
      /motion-detection/,
    )
    // Every OTHER one still got switched off — a partial failure is not a
    // reason to leave the ones that COULD be silenced running.
    expect(world.calls.map((c) => c.capName).sort()).toEqual([
      'audio-analysis',
      'detection-pipeline',
      'pipeline-analytics',
      'scene-monitor',
    ])
    expect(error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tags: { deviceId: DEVICE_ID } }),
    )
  })

  it('every failure line carries the numeric deviceId tag', async () => {
    // A hot hub is always asked about per-camera ("why is 3218 costing us
    // anything?"), and a line without the tag cannot be grouped to answer it.
    const world = makeWorld({ bindingsThrows: true })
    const { logger, error } = makeLogger()

    await expect(silenceAnalysisFor({ api: world.api, logger }, DEVICE_ID)).rejects.toThrow()

    for (const call of error.mock.calls)
      expect(call[1]).toEqual(expect.objectContaining({ tags: { deviceId: DEVICE_ID } }))
  })
})
