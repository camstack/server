/**
 * `package-detection` must not be stripped by a store that failed to answer.
 *
 * The step has no operator toggle: `applyPackageZoneActivation` appends it when
 * the camera has ≥1 enabled `package`-stage zone rule and STRIPS it when it
 * does not. The signal feeding that decision came from
 * `zoneRules.listRules`, which swallowed every read error into `[]` — so an
 * unanswerable store looked exactly like "the operator deleted the zone", and
 * the step vanished from the resolved tree with no log line at all.
 *
 * That is the doorbell shape (D49): a one-shot decision gated on a fallible
 * read, where the failure mode DESTROYS work silently. The virtual doorbell's
 * binding mirror (retired in D671) was the pattern this follows, with one
 * difference worth stating: there, a store answering from an empty snapshot and a genuine
 * unbind produced the SAME response and could not be graded, so corroboration
 * was the only discriminator. Here a THROWN read is distinguishable from an
 * empty one, so both defences apply and they cover different failures:
 *
 *   - a read that FAILED carries no information → the mirror is untouched and
 *     the last-known-good answer stands (and the failure is logged, warn);
 *   - a read that SUCCEEDED but is empty for a camera the mirror had as zoned
 *     is the D44 shape (`readDeviceStore` answering `{}` without throwing —
 *     it emptied every addon store once already) → it ARMS the strip and needs
 *     a second consecutive agreeing read to apply it.
 *
 * Erring: a camera that was never read stays OFF (packages are opt-in; erring
 * open there would enable a parcel detector fleet-wide). Only the destructive
 * transition zoned→unzoned is corroborated.
 */
import { describe, it, expect, vi } from 'vitest'
import type { IScopedLogger, ZoneRule } from '@camstack/types'

import { PackageZoneGate } from '../package-zone-gate.js'
import type { ZoneRulesRead } from '../zone-rules-provider.js'

function rule(overrides: Partial<ZoneRule> = {}): ZoneRule {
  return {
    id: 'r1',
    zoneIds: ['z1'],
    mode: 'include',
    stage: 'package',
    enabled: true,
    ...overrides,
  } as ZoneRule
}

interface LoggerSpy {
  readonly logger: IScopedLogger
  readonly warn: ReturnType<typeof vi.fn>
}

function makeLogger(): LoggerSpy {
  const warn = vi.fn()
  const logger = {
    info: vi.fn(),
    warn,
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    withTags: () => logger,
    child: () => logger,
  } as unknown as IScopedLogger
  return { logger, warn }
}

/** A gate over a scripted sequence of reads. */
function makeGate(reads: readonly ZoneRulesRead[]): {
  readonly gate: PackageZoneGate
  readonly warn: ReturnType<typeof vi.fn>
} {
  const { logger, warn } = makeLogger()
  let i = 0
  const gate = new PackageZoneGate({
    logger,
    readPackageRules: async () => reads[Math.min(i++, reads.length - 1)]!,
  })
  return { gate, warn }
}

const OK_ZONED: ZoneRulesRead = { ok: true, rules: [rule()] }
const OK_EMPTY: ZoneRulesRead = { ok: true, rules: [] }
const FAILED: ZoneRulesRead = { ok: false, error: 'store read failed' }

describe('PackageZoneGate — a failed read is not "no zones"', () => {
  it('activates on a successful read that sees an enabled package zone', async () => {
    const { gate } = makeGate([OK_ZONED])
    expect(await gate.isActive(101)).toBe(true)
  })

  it('a DISABLED rule, or one with no zones, is not a package zone', async () => {
    const disabled = makeGate([{ ok: true, rules: [rule({ enabled: false })] }])
    expect(await disabled.gate.isActive(101)).toBe(false)
    const zoneless = makeGate([{ ok: true, rules: [rule({ zoneIds: [] })] }])
    expect(await zoneless.gate.isActive(101)).toBe(false)
  })

  it('keeps the last-known-good answer when the read FAILS, and says so loudly', async () => {
    const { gate, warn } = makeGate([OK_ZONED, FAILED, FAILED])
    expect(await gate.isActive(101)).toBe(true)
    // This is the whole defect: before the fix, both of these were `false` and
    // the step was stripped from the resolved tree.
    expect(await gate.isActive(101)).toBe(true)
    expect(await gate.isActive(101)).toBe(true)

    const call = warn.mock.calls.find((c: readonly unknown[]) =>
      String(c[0]).includes('package-zone read FAILED'),
    )
    expect(call, 'a failed read must be operator-visible, not debug').toBeDefined()
    const opts = call?.[1] as { tags?: Record<string, unknown> } | undefined
    expect(opts?.tags?.['deviceId']).toBe(101)
  })

  it('a failed read does not poison a camera that was never read — it stays off', async () => {
    const { gate } = makeGate([FAILED])
    expect(await gate.isActive(616)).toBe(false)
  })

  it('one empty read after a zoned one does NOT strip — it needs corroboration', async () => {
    const { gate, warn } = makeGate([OK_ZONED, OK_EMPTY])
    expect(await gate.isActive(101)).toBe(true)
    expect(await gate.isActive(101)).toBe(true)
    expect(
      warn.mock.calls.some((c: readonly unknown[]) => String(c[0]).includes('NOT stripping yet')),
    ).toBe(true)
  })

  it('two consecutive empty reads DO strip, and the strip is logged', async () => {
    const { gate, warn } = makeGate([OK_ZONED, OK_EMPTY, OK_EMPTY])
    expect(await gate.isActive(101)).toBe(true)
    expect(await gate.isActive(101)).toBe(true)
    expect(await gate.isActive(101)).toBe(false)
    const call = warn.mock.calls.find((c: readonly unknown[]) =>
      String(c[0]).includes('package-detection STRIPPED'),
    )
    expect(call, 'a branch that drops work logs it').toBeDefined()
    expect((call?.[1] as { tags?: Record<string, unknown> } | undefined)?.tags?.['deviceId']).toBe(
      101,
    )
  })

  it('a zoned read in between DISARMS the pending strip', async () => {
    const { gate } = makeGate([OK_ZONED, OK_EMPTY, OK_ZONED, OK_EMPTY])
    expect(await gate.isActive(101)).toBe(true) // zoned
    expect(await gate.isActive(101)).toBe(true) // empty → armed
    expect(await gate.isActive(101)).toBe(true) // zoned → disarmed
    expect(await gate.isActive(101)).toBe(true) // empty → armed again, not stripped
  })

  it('a first-ever read that is empty strips immediately — opt-in stays opt-in', async () => {
    const { gate } = makeGate([OK_EMPTY])
    expect(await gate.isActive(101)).toBe(false)
  })

  it('mirrors per DEVICE — 102 failing never speaks for 101', async () => {
    const { logger } = makeLogger()
    const script = new Map<number, ZoneRulesRead[]>([
      [101, [OK_ZONED, OK_ZONED]],
      [102, [OK_EMPTY, FAILED]],
    ])
    const gate = new PackageZoneGate({
      logger,
      readPackageRules: async (deviceId: number) => script.get(deviceId)!.shift()!,
    })
    expect(await gate.isActive(101)).toBe(true)
    expect(await gate.isActive(102)).toBe(false)
    expect(await gate.isActive(101)).toBe(true)
    expect(await gate.isActive(102)).toBe(false)
  })
})
