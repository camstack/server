/**
 * Operator ruling, 2026-10-01: a saved rule's `conditions.devices` (the
 * "Only these" include list) may name only devices that can actually produce
 * this rule KIND's subject — a detection rule with a door lock in its device
 * list is refused, and logged, on the cap-provider save route. `devices`
 * absent or empty ("every device") is never judged; a read that cannot be
 * made (no `listDeviceIdsByCaps` wired) FAILS OPEN.
 */
import { makeNcRecords } from './support/nc-test-deps.js'
import { NC_CAMERA_SCOPE_CAP_NAME, NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import {
  makeLogRecorder,
  makeSilentLogger,
} from '../../pipeline-analytics/__tests__/test-helpers.js'
import {
  assertRuleDeviceCompat,
  guardPatchDeviceCompat,
  guardRuleDeviceCompat,
  NcDeviceCompatRefusal,
  NcDeviceCompatWarnSampler,
} from '../device-compat-guard.js'
import { NotificationCenter } from '../index.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const CAMERA_ONLY = async (capNames: readonly string[]): Promise<readonly number[]> =>
  capNames.includes('detection-pipeline') ? [101] : []

/** Sensor 42 (a contact), camera 101, lock 77 (no eventful cap in this fake). */
const FLEET = async (capNames: readonly string[]): Promise<readonly number[]> => {
  if (capNames.includes('detection-pipeline')) return [101]
  if (capNames.includes(NC_CAMERA_SCOPE_CAP_NAME)) return [101]
  if (capNames.includes('contact')) return [42]
  return []
}

/** The same fleet with the sensor's binding missing — only cameras answer. */
const FLEET_CAMERAS_ONLY = async (capNames: readonly string[]): Promise<readonly number[]> =>
  capNames.includes(NC_CAMERA_SCOPE_CAP_NAME) || capNames.includes('detection-pipeline')
    ? [101]
    : []

const detection = { delivery: 'immediate' as const, conditions: { devices: [101] } }
const detectionWithLock = { delivery: 'immediate' as const, conditions: { devices: [101, 42] } }
const sensor = { delivery: 'device-event' as const, conditions: { devices: [42] } }

describe('assertRuleDeviceCompat', () => {
  it('passes a detection rule scoped to a pipeline-capable camera', async () => {
    await expect(assertRuleDeviceCompat(detection, CAMERA_ONLY)).resolves.toEqual({
      outcome: 'compatible',
    })
  })

  it('refuses a detection rule that also names an incompatible device, naming it', async () => {
    await expect(assertRuleDeviceCompat(detectionWithLock, CAMERA_ONLY)).rejects.toThrow(
      NcDeviceCompatRefusal,
    )
    await expect(assertRuleDeviceCompat(detectionWithLock, CAMERA_ONLY)).rejects.toThrow(/42/)
  })

  it('names EVERY incompatible id, not only the first', async () => {
    const both = { delivery: 'immediate' as const, conditions: { devices: [42, 43] } }
    const err = await assertRuleDeviceCompat(both, CAMERA_ONLY).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NcDeviceCompatRefusal)
    expect((err as InstanceType<typeof NcDeviceCompatRefusal>).incompatibleIds).toEqual([42, 43])
  })

  it('never judges an EMPTY or ABSENT device list — "every device" is not a claim', async () => {
    await expect(
      assertRuleDeviceCompat({ delivery: 'immediate', conditions: {} }, CAMERA_ONLY),
    ).resolves.toEqual({ outcome: 'not-judged' })
    await expect(
      assertRuleDeviceCompat({ delivery: 'immediate', conditions: { devices: [] } }, CAMERA_ONLY),
    ).resolves.toEqual({ outcome: 'not-judged' })
  })

  it('a kind with no capability filter (a system family) is never judged', async () => {
    await expect(
      assertRuleDeviceCompat(
        {
          delivery: 'system-event',
          conditions: { devices: [42], systemEvent: { kinds: ['device-offline'] } },
        },
        CAMERA_ONLY,
      ),
    ).resolves.toEqual({ outcome: 'not-judged' })
  })

  it('a sensor rule asks for the sensor/control caps, and a camera-only answer refuses it', async () => {
    // The fleet answers ONLY cameras — a sensor rule asks for the EVENTFUL
    // caps, gets nothing back for them, and its device (42) is refused even
    // though 42 IS the right kind of device in reality. This pins that the
    // guard asks the RIGHT caps, not merely "some caps".
    await expect(assertRuleDeviceCompat(sensor, FLEET_CAMERAS_ONLY)).rejects.toThrow(/42/)
  })

  it('a sensor rule may be scoped to a CAMERA (D630 §6) — cameras are in its compatible set', async () => {
    const onCamera = { delivery: 'device-event' as const, conditions: { devices: [101] } }
    await expect(assertRuleDeviceCompat(onCamera, FLEET)).resolves.toMatchObject({
      outcome: 'compatible',
    })
    // …and the sensor itself, through the eventful caps.
    await expect(assertRuleDeviceCompat(sensor, FLEET)).resolves.toMatchObject({
      outcome: 'compatible',
    })
    // A device that is neither is still refused.
    const onLock = { delivery: 'device-event' as const, conditions: { devices: [77] } }
    await expect(assertRuleDeviceCompat(onLock, FLEET)).rejects.toThrow(/77/)
  })

  it('FAILS OPEN when the capability read is not wired at all — and SAYS so', async () => {
    await expect(assertRuleDeviceCompat(detectionWithLock, undefined)).resolves.toEqual({
      outcome: 'unchecked',
      reason: 'unwired',
      ids: [101, 42],
    })
  })

  it('FAILS OPEN when the capability read throws — a save must not become un-makeable', async () => {
    const throwing = async (): Promise<readonly number[]> => {
      throw new Error('deviceManager unreachable')
    }
    await expect(assertRuleDeviceCompat(detectionWithLock, throwing)).resolves.toMatchObject({
      outcome: 'unchecked',
      reason: 'read-failed',
      error: 'Error: deviceManager unreachable',
    })
  })

  it('an EMPTY answer is UNKNOWN, not "nothing is compatible" (D315/D393) — fails open', async () => {
    // `getAllBindings` answers [] with only a warning while the registry or
    // ledger is still empty at boot; that answer is not a measurement.
    const empty = async (): Promise<readonly number[]> => []
    await expect(assertRuleDeviceCompat(detectionWithLock, empty)).resolves.toMatchObject({
      outcome: 'unchecked',
      reason: 'answered-empty',
    })
  })
})

describe('guardRuleDeviceCompat / guardPatchDeviceCompat', () => {
  it('logs a refused create and rethrows', async () => {
    const rec = makeLogRecorder()
    await expect(
      guardRuleDeviceCompat(detectionWithLock, {
        logger: rec.logger,
        by: 'alice',
        listDeviceIdsByCaps: CAMERA_ONLY,
      }),
    ).rejects.toThrow(NcDeviceCompatRefusal)
    expect(rec.entries.find((e) => e.level === 'warn')?.extras?.meta).toMatchObject({
      by: 'alice',
      kind: 'detection',
      incompatibleIds: [42],
    })
  })

  it('judges the MERGED rule: adding an incompatible device via a patch is refused', async () => {
    const rec = makeLogRecorder()
    await expect(
      guardPatchDeviceCompat(
        detection,
        { conditions: { devices: [101, 42] } },
        {
          logger: rec.logger,
          by: 'alice',
          ruleId: 'r1',
          listDeviceIdsByCaps: CAMERA_ONLY,
        },
      ),
    ).rejects.toThrow(NcDeviceCompatRefusal)
    expect(rec.entries.find((e) => e.level === 'warn')?.extras?.meta).toMatchObject({
      ruleId: 'r1',
    })
  })

  it('a patch that changes neither delivery nor conditions is not judged — no read at all', async () => {
    const rec = makeLogRecorder()
    let asked = false
    const spy = async (capNames: readonly string[]): Promise<readonly number[]> => {
      asked = true
      return CAMERA_ONLY(capNames)
    }
    await guardPatchDeviceCompat(
      detectionWithLock,
      {},
      {
        logger: rec.logger,
        by: 'x',
        ruleId: 'r1',
        listDeviceIdsByCaps: spy,
      },
    )
    await guardPatchDeviceCompat(null, { delivery: 'immediate' }, { logger: rec.logger, by: 'x' })
    expect(rec.entries).toHaveLength(0)
    expect(asked).toBe(false)
  })

  it('never refuses when no capability read is wired — but WARNS, naming the rule (M1)', async () => {
    const rec = makeLogRecorder()
    await guardRuleDeviceCompat(detectionWithLock, { logger: rec.logger, by: 'x' })
    const warns = rec.entries.filter((e) => e.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]?.extras?.meta).toMatchObject({
      by: 'x',
      kind: 'detection',
      reason: 'unwired',
      uncheckedIds: [101, 42],
    })
  })

  it('a failed read is accepted with a WARN carrying the rule id and the error', async () => {
    const rec = makeLogRecorder()
    const throwing = async (): Promise<readonly number[]> => {
      throw new Error('boom')
    }
    await guardPatchDeviceCompat(
      detection,
      { conditions: { devices: [101, 42] } },
      { logger: rec.logger, by: 'x', ruleId: 'r9', listDeviceIdsByCaps: throwing },
    )
    expect(rec.entries.find((e) => e.level === 'warn')?.extras?.meta).toMatchObject({
      ruleId: 'r9',
      reason: 'read-failed',
      uncheckedIds: [42],
      error: 'Error: boom',
    })
  })

  it('the unchecked WARN is SAMPLED per rule — a burst of saves logs once', async () => {
    const rec = makeLogRecorder()
    const sampler = new NcDeviceCompatWarnSampler()
    const ctx = { logger: rec.logger, by: 'x', ruleId: 'r1', sampler }
    await guardRuleDeviceCompat(detectionWithLock, ctx)
    await guardRuleDeviceCompat(detectionWithLock, ctx)
    await guardRuleDeviceCompat(detectionWithLock, { ...ctx, ruleId: 'r2' })
    expect(rec.entries.filter((e) => e.level === 'warn')).toHaveLength(2)
  })

  it('an UPDATE never re-judges a device already stored on the rule (H2)', async () => {
    // 42 was compatible when it was saved; its binding has since gone (the
    // detection wrapper switched off, D62, or an agent mid-handshake). An
    // unrelated conditions edit must still save.
    const rec = makeLogRecorder()
    let asked = false
    const spy = async (capNames: readonly string[]): Promise<readonly number[]> => {
      asked = true
      return CAMERA_ONLY(capNames)
    }
    await expect(
      guardPatchDeviceCompat(
        detectionWithLock,
        { conditions: { devices: [101, 42], classes: ['person'] } },
        { logger: rec.logger, by: 'x', ruleId: 'r1', listDeviceIdsByCaps: spy },
      ),
    ).resolves.toBeUndefined()
    // Nothing was ADDED, so nothing was asked.
    expect(asked).toBe(false)
    expect(rec.entries).toHaveLength(0)
  })

  it('an UPDATE that adds a device judges ONLY the added one, not the kept ones', async () => {
    const rec = makeLogRecorder()
    const err = await guardPatchDeviceCompat(
      detectionWithLock,
      { conditions: { devices: [101, 42, 43] } },
      { logger: rec.logger, by: 'x', ruleId: 'r1', listDeviceIdsByCaps: CAMERA_ONLY },
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NcDeviceCompatRefusal)
    expect((err as InstanceType<typeof NcDeviceCompatRefusal>).incompatibleIds).toEqual([43])
  })
})

// ── The cap-provider route (`notificationRules.createRule/updateRule`) ──

const centers: NotificationCenter[] = []
afterEach(async () => {
  await Promise.all(centers.splice(0).map((c) => c.stop()))
})

async function makeCenter(
  listDeviceIdsByCaps?: (capNames: readonly string[]) => Promise<readonly number[]>,
): Promise<NotificationCenter> {
  const world = makeNcRecords()
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: makeSilentLogger(),
    pruneWindows: async () => ({
      outboxMs: null,
      timelapseExportMs: null,
      artifactShelfMs: null,
      summaryMosaicMs: null,
    }),
    dispatcher: {
      listTargets: async () => [
        { id: 'target-1', addonId: 'notifiers', name: 'phone', kind: 'zentik', enabled: true },
      ],
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => null,
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    listDeviceIdentities: async () => [],
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
    ...(listDeviceIdsByCaps ? { listDeviceIdsByCaps } : {}),
  })
  centers.push(center)
  await center.start({ evaluation: false })
  return center
}

const ADMIN = { userId: 'admin', isAdmin: true }

function rule(delivery: string, conditions: Record<string, unknown>) {
  return NcRuleInputSchema.parse({
    name: 'Vialetto',
    delivery,
    conditions,
    targets: [{ targetId: 'target-1' }],
  })
}

describe('buildProvider — a device must be able to produce the rule KIND (operator ruling 2026-10-01)', () => {
  it('creates a detection rule scoped to a compatible camera', async () => {
    const provider = (await makeCenter(CAMERA_ONLY)).buildProvider()
    const { rule: created } = await provider.createRule({
      caller: ADMIN,
      rule: rule('immediate', { devices: [101] }),
    })
    expect(created.conditions.devices).toEqual([101])
  })

  it('refuses a createRule naming an incompatible device, and stores nothing', async () => {
    const provider = (await makeCenter(CAMERA_ONLY)).buildProvider()
    await expect(
      provider.createRule({ caller: ADMIN, rule: rule('immediate', { devices: [101, 42] }) }),
    ).rejects.toThrow(NcDeviceCompatRefusal)
    expect((await provider.listRules({})).rules).toHaveLength(0)
  })

  it('refuses an updateRule that ADDS an incompatible device', async () => {
    const provider = (await makeCenter(CAMERA_ONLY)).buildProvider()
    const { rule: created } = await provider.createRule({
      caller: ADMIN,
      rule: rule('immediate', { devices: [101] }),
    })
    await expect(
      provider.updateRule({
        caller: ADMIN,
        ruleId: created.id,
        patch: { conditions: { devices: [101, 42] } },
      }),
    ).rejects.toThrow(NcDeviceCompatRefusal)
  })

  it('a stored rule whose device LOST its binding still accepts an unrelated conditions edit', async () => {
    let fleet: readonly number[] = [101, 616]
    const provider = (
      await makeCenter(async (capNames) => (capNames.includes('detection-pipeline') ? fleet : []))
    ).buildProvider()
    const { rule: created } = await provider.createRule({
      caller: ADMIN,
      rule: rule('immediate', { devices: [101, 616] }),
    })
    // The operator switches detection OFF on 616 (D62): the binding goes.
    fleet = [101]
    const { rule: updated } = await provider.updateRule({
      caller: ADMIN,
      ruleId: created.id,
      patch: { conditions: { devices: [101, 616], classes: ['person'] } },
    })
    expect(updated.conditions.devices).toEqual([101, 616])
    expect(updated.conditions.classes).toEqual(['person'])
  })

  it('a rule saved WITHOUT the capability wired is never refused — fails open', async () => {
    const provider = (await makeCenter()).buildProvider()
    const { rule: created } = await provider.createRule({
      caller: ADMIN,
      rule: rule('immediate', { devices: [101, 42] }),
    })
    expect(created.conditions.devices).toEqual([101, 42])
  })

  it('a STORED (already-incompatible) rule still LOADS and LISTS — the guard never runs at read time', async () => {
    const provider = (await makeCenter()).buildProvider()
    await provider.createRule({ caller: ADMIN, rule: rule('immediate', { devices: [101, 42] }) })
    // Reopen the SAME store under a center that NOW has the capability wired
    // (the production sequence: the rule predates this ruling, or was saved
    // while the read was unreachable) — listRules must not refuse it.
    const rules = await provider.listRules({})
    expect(rules.rules).toHaveLength(1)
    expect(rules.rules[0]?.conditions.devices).toEqual([101, 42])
  })
})
