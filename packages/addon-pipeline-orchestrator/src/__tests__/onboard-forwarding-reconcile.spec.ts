/**
 * The vendor onboard-AI flag is a MIRROR of `detectionSources`, not a second
 * authority (D62).
 *
 * Measured on the live hub on 2026-09-15: device 106's stored pick was
 * `['onboard']` while `nativeObjectDetection.getStatus` read `enabled: false`,
 * and the provider logged "Reolink onboard AI detection dropped — forwarding is
 * off for this camera" once a minute. The pick had been saved correctly — the
 * MECHANISM had been forgotten across a provider restart (all seven Reolink
 * cameras carried a `lastFetchedAt` from the boot at 23:19, a field only the
 * cap's cold-start seed writes).
 *
 * These cover the reconcile itself. The direction that matters twice: a pick
 * WITHOUT `onboard` must turn the flag OFF, or this is a ratchet that quietly
 * enables things and never disables them.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { reconcileOnboardForwarding } from '../onboard-forwarding-reconcile.js'

interface LoggedLine {
  readonly level: 'info' | 'warn'
  readonly message: string
  readonly tags: Record<string, unknown>
}

function makeLogger(lines: LoggedLine[], tags: Record<string, unknown> = {}): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: (message: string) => {
      lines.push({ level: 'info', message, tags })
    },
    warn: (message: string) => {
      lines.push({ level: 'warn', message, tags })
    },
    error: () => undefined,
    child: () => logger,
    withTags: (extra: Record<string, unknown>) => makeLogger(lines, { ...tags, ...extra }),
  }
  return logger
}

interface Harness {
  readonly flags: Map<number, boolean>
  readonly writes: Array<{ deviceId: number; enabled: boolean }>
  readonly lines: LoggedLine[]
}

function makeHarness(seed: ReadonlyArray<readonly [number, boolean]>): Harness {
  return { flags: new Map(seed), writes: [], lines: [] }
}

function makeDeps(
  h: Harness,
  overrides: {
    hasCap?: (deviceId: number) => Promise<boolean>
    read?: (deviceId: number) => Promise<boolean>
    write?: (deviceId: number, enabled: boolean) => Promise<void>
  } = {},
): Parameters<typeof reconcileOnboardForwarding>[1] {
  return {
    hasNativeObjectDetectionCap: overrides.hasCap ?? (async (id) => h.flags.has(id)),
    readForwardingEnabled:
      overrides.read ??
      (async (id) => {
        const v = h.flags.get(id)
        if (v === undefined) throw new Error(`no flag for ${id}`)
        return v
      }),
    writeForwardingEnabled:
      overrides.write ??
      (async (id, enabled) => {
        h.writes.push({ deviceId: id, enabled })
        h.flags.set(id, enabled)
      }),
    logger: makeLogger(h.lines),
  }
}

describe('reconcileOnboardForwarding', () => {
  it('re-arms a flag that drifted OFF under a pick that says onboard', async () => {
    const h = makeHarness([[106, false]])

    const outcome = await reconcileOnboardForwarding(
      { deviceId: 106, detectionSources: ['onboard'] },
      makeDeps(h),
    )

    expect(outcome).toEqual({ kind: 'repaired', wantsOnboard: true })
    expect(h.writes).toEqual([{ deviceId: 106, enabled: true }])
    expect(h.flags.get(106)).toBe(true)
  })

  it('turns a flag OFF when the pick no longer includes onboard — the drift closes both ways', async () => {
    const h = makeHarness([[108, true]])

    const outcome = await reconcileOnboardForwarding(
      { deviceId: 108, detectionSources: ['pipeline'] },
      makeDeps(h),
    )

    expect(outcome).toEqual({ kind: 'repaired', wantsOnboard: false })
    expect(h.writes).toEqual([{ deviceId: 108, enabled: false }])
    expect(h.flags.get(108)).toBe(false)
  })

  it('names the repair, with the deviceId tag — a silent repair is indistinguishable from nothing being wrong', async () => {
    const h = makeHarness([[106, false]])

    await reconcileOnboardForwarding({ deviceId: 106, detectionSources: ['onboard'] }, makeDeps(h))

    const repaired = h.lines.filter((l) => l.level === 'info')
    expect(repaired).toHaveLength(1)
    expect(repaired[0]!.message).toContain('onboard forwarding')
    expect(repaired[0]!.tags).toMatchObject({ deviceId: 106 })
  })

  it('writes nothing when the flag already agrees with the pick', async () => {
    const h = makeHarness([
      [106, true],
      [108, false],
    ])

    const agreedOn = await reconcileOnboardForwarding(
      { deviceId: 106, detectionSources: ['onboard'] },
      makeDeps(h),
    )
    const agreedOff = await reconcileOnboardForwarding(
      { deviceId: 108, detectionSources: ['pipeline'] },
      makeDeps(h),
    )

    expect(agreedOn.kind).toBe('aligned')
    expect(agreedOff.kind).toBe('aligned')
    expect(h.writes).toEqual([])
    expect(h.lines).toEqual([])
  })

  it('never writes on a read that FAILED — unknown is not "off"', async () => {
    const h = makeHarness([[106, true]])

    const outcome = await reconcileOnboardForwarding(
      { deviceId: 106, detectionSources: ['pipeline'] },
      makeDeps(h, {
        read: async () => {
          throw new Error('provider unreachable')
        },
      }),
    )

    expect(outcome.kind).toBe('read-failed')
    expect(h.writes).toEqual([])
    // The flag the read could not see is left exactly as it was.
    expect(h.flags.get(106)).toBe(true)
    expect(h.lines.map((l) => l.level)).toEqual(['warn'])
    expect(h.lines[0]!.tags).toMatchObject({ deviceId: 106 })
  })

  it('does nothing on a camera with no native-object-detection binding', async () => {
    const h = makeHarness([])

    const outcome = await reconcileOnboardForwarding(
      { deviceId: 103, detectionSources: ['pipeline'] },
      makeDeps(h, { hasCap: async () => false }),
    )

    expect(outcome.kind).toBe('no-cap')
    expect(h.writes).toEqual([])
    expect(h.lines).toEqual([])
  })

  it('reports a repair that did not land instead of claiming one', async () => {
    const h = makeHarness([[106, false]])

    const outcome = await reconcileOnboardForwarding(
      { deviceId: 106, detectionSources: ['onboard'] },
      makeDeps(h, {
        write: async () => {
          throw new Error('setEnabled failed')
        },
      }),
    )

    expect(outcome.kind).toBe('write-failed')
    expect(h.flags.get(106)).toBe(false)
    expect(h.lines.map((l) => l.level)).toEqual(['warn'])
    expect(h.lines[0]!.tags).toMatchObject({ deviceId: 106 })
  })
})
