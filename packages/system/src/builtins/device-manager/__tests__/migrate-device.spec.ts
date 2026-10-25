/**
 * Replacing a camera — and refusing to lie about the one that is broken.
 *
 * The source camera in a replacement is characteristically dead; that is why it
 * is being replaced. Two of the eight switches write the CAMERA rather than the
 * server, so on a dead one they cannot be written at all. The claim these specs
 * exist for is that such a switch is reported `unreachable` and named in
 * `sourceStillLive` — never folded into the same silence as a switch that was
 * genuinely turned off.
 *
 * Everything else here is ordering: down on both BEFORE the swap, up on the
 * inherited number AFTER it.
 */
import { describe, expect, it } from 'vitest'
import { CAMERA_SWITCH_ORDER, type CameraSwitchId } from '@camstack/types'
import {
  type MigrateDeviceDeps,
  type MigrationLogLevel,
  migrateDevice,
  type SwitchStates,
} from '../migrate-device.js'
import { MigrationRefusedError } from '../migration-refused.js'

const SOURCE = 3836
const TARGET = 4300

interface DeviceLine {
  readonly level: MigrationLogLevel
  readonly deviceId: number
  readonly message: string
  readonly meta: Record<string, unknown>
}

interface Harness {
  readonly deps: MigrateDeviceDeps
  readonly calls: string[]
  readonly logged: Array<{ message: string; meta: Record<string, unknown> }>
  readonly deviceLines: DeviceLine[]
}

/** Every switch offered and ON, except those named off. */
function statesWithOff(off: readonly CameraSwitchId[]): SwitchStates {
  return new Map(CAMERA_SWITCH_ORDER.map((id) => [id, !off.includes(id)]))
}

/** `deadOn` names the switches whose write throws for the given device, as a
 *  camera that does not answer would. */
function harness(deadOn: ReadonlyMap<number, readonly CameraSwitchId[]> = new Map()): Harness {
  const calls: string[] = []
  const logged: Array<{ message: string; meta: Record<string, unknown> }> = []
  const deviceLines: DeviceLine[] = []
  const deps: MigrateDeviceDeps = {
    setSwitch: async (deviceId, switchId, enabled) => {
      calls.push(`set:${deviceId}:${switchId}:${enabled ? 'on' : 'off'}`)
      if ((deadOn.get(deviceId) ?? []).includes(switchId)) {
        throw new Error(`camera ${deviceId} did not answer`)
      }
    },
    swapIds: async (a, b) => {
      calls.push(`swap:${a}:${b}`)
    },
    swapHardwareState: async (a, b) => {
      calls.push(`swap-hw:${a}:${b}`)
    },
    assertNoFieldClaims: async (a, b) => {
      calls.push(`assert-no-claims:${a}:${b}`)
    },
    forgetStreamState: async (deviceId) => {
      calls.push(`forget-streams:${deviceId}`)
    },
    log: (message, meta) => {
      logged.push({ message, meta })
    },
    readSwitches: async () => statesWithOff([]),
    logDevice: (level, deviceId, message, meta) => {
      deviceLines.push({ level, deviceId, message, meta })
    },
  }
  return { deps, calls, logged, deviceLines }
}

describe('migrateDevice — the number moves and the report tells the truth', () => {
  it('takes both cameras down BEFORE the swap', async () => {
    const h = harness()

    await migrateDevice(h.deps, { sourceId: SOURCE, targetId: TARGET })

    const swapAt = h.calls.indexOf(`swap:${SOURCE}:${TARGET}`)
    const lastOff = h.calls.map((c) => c.endsWith(':off')).lastIndexOf(true)
    expect(swapAt).toBeGreaterThan(lastOff)
  })

  it('brings the functions up on the INHERITED number, not the old one', async () => {
    const h = harness()

    await migrateDevice(h.deps, { sourceId: SOURCE, targetId: TARGET })

    const ons = h.calls.filter((c) => c.endsWith(':on'))
    expect(ons).toHaveLength(CAMERA_SWITCH_ORDER.length)
    expect(ons.every((c) => c.startsWith(`set:${SOURCE}:`))).toBe(true)
  })

  it('a dead source names its switches in sourceStillLive', async () => {
    const dead: CameraSwitchId[] = ['privacy-mask', 'device-audio']
    const h = harness(new Map([[SOURCE, dead]]))

    const res = await migrateDevice(h.deps, { sourceId: SOURCE, targetId: TARGET })

    expect(res.sourceStillLive).toEqual(dead)
  })

  it('and never reports one of those as off', async () => {
    const h = harness(new Map([[SOURCE, ['privacy-mask']]]))

    const res = await migrateDevice(h.deps, { sourceId: SOURCE, targetId: TARGET })

    const mask = res.switches.find((r) => r.deviceId === SOURCE && r.switchId === 'privacy-mask')
    expect(mask?.outcome).toBe('unreachable')
    expect(mask?.detail).toContain('did not answer')
  })

  it('a fully reachable source reports nothing still live', async () => {
    const h = harness()

    const res = await migrateDevice(h.deps, { sourceId: SOURCE, targetId: TARGET })

    expect(res.sourceStillLive).toEqual([])
    expect(res.switches.every((r) => r.outcome === 'off' || r.outcome === 'on')).toBe(true)
  })

  it('a switch the camera never offered is NOT counted as still live', async () => {
    const h: Harness = {
      calls: [],
      logged: [],
      deps: {
        setSwitch: async (deviceId, switchId) => {
          if (deviceId === SOURCE && switchId === 'privacy-mask') {
            throw new Error('this camera does not offer privacy-mask')
          }
        },
        swapIds: async () => {},
        swapHardwareState: async () => {},
        assertNoFieldClaims: async () => {},
        forgetStreamState: async () => {},
        log: () => {},
        readSwitches: async () => statesWithOff([]),
        logDevice: () => {},
      },
      deviceLines: [],
    }

    const res = await migrateDevice(h.deps, { sourceId: SOURCE, targetId: TARGET })

    expect(res.sourceStillLive).toEqual([])
    expect(
      res.switches.find((r) => r.deviceId === SOURCE && r.switchId === 'privacy-mask')?.outcome,
    ).toBe('not-offered')
  })

  it('a dead source does NOT refuse the migration — it is the case this exists for', async () => {
    const h = harness(new Map([[SOURCE, [...CAMERA_SWITCH_ORDER]]]))

    const res = await migrateDevice(h.deps, { sourceId: SOURCE, targetId: TARGET })

    expect(res.swapped).toBe(true)
    expect(res.sourceStillLive).toEqual([...CAMERA_SWITCH_ORDER])
  })

  it('refuses source and target being the same device', async () => {
    const h = harness()

    await expect(migrateDevice(h.deps, { sourceId: SOURCE, targetId: SOURCE })).rejects.toThrow(
      /both source and target/,
    )
  })

  /**
   * Measured 2026-09-01: one unanswered switch write burned the transport's
   * 60 s default, once per phase — three minutes of a 3.5-minute migration
   * whose real work is under a second, long enough for the CALLER's own
   * timeout to expire and a retry to run a second swap. The bound caps the
   * wait; the honesty rule caps what it may claim: a write we stopped waiting
   * for is `unreachable`, never `off` — even if it lands late.
   */
  it('bounds a switch write that does not answer — reported unreachable, never off', async () => {
    const h = harness()
    const deps: MigrateDeviceDeps = {
      ...h.deps,
      switchTimeoutMs: 25,
      setSwitch: async (deviceId, switchId, enabled) => {
        h.calls.push(`set:${deviceId}:${switchId}:${enabled ? 'on' : 'off'}`)
        if (deviceId === SOURCE && switchId === 'privacy-mask' && !enabled) {
          // The write eventually SUCCEEDS — after the bound. Folding that late
          // success into `off` is exactly the lie this spec forbids.
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
      },
    }

    const res = await migrateDevice(deps, { sourceId: SOURCE, targetId: TARGET })

    const report = res.switches.find(
      (r) => r.deviceId === SOURCE && r.switchId === 'privacy-mask' && r.outcome !== 'on',
    )
    expect(report?.outcome).toBe('unreachable')
    expect(report?.detail).toMatch(/did not answer within 25ms/)
    expect(res.sourceStillLive).toContain('privacy-mask')
    // The migration did not stall on the unanswered write.
    expect(res.swapped).toBe(true)
  })
})

describe('hardware-scoped state follows the DEVICE, not the number', () => {
  /**
   * The incident of 2026-09-01: `swapIds` moved the rows and NOTHING moved the
   * per-device config, so the new camera was dialled at the old one's dead
   * address forever. The config swap must ride immediately behind the id swap
   * — after it (the store is keyed by the post-swap numbers), and before any
   * switch comes back up on the inherited number.
   */
  it('swaps the hardware state right after the ids, before any switch-up', async () => {
    const h = harness()

    await migrateDevice(h.deps, { sourceId: SOURCE, targetId: TARGET })

    const swapAt = h.calls.indexOf(`swap:${SOURCE}:${TARGET}`)
    const hwAt = h.calls.indexOf(`swap-hw:${SOURCE}:${TARGET}`)
    const firstOn = h.calls.findIndex((c) => c.endsWith(':on'))
    expect(hwAt).toBeGreaterThan(swapAt)
    expect(hwAt).toBeLessThan(firstOn)
  })

  it('a failed hardware swap THROWS — never a migration reported with crossed identities', async () => {
    const h = harness()
    const deps: MigrateDeviceDeps = {
      ...h.deps,
      swapHardwareState: async () => {
        throw new Error('device store unavailable')
      },
    }

    await expect(migrateDevice(deps, { sourceId: SOURCE, targetId: TARGET })).rejects.toThrow(
      /device store unavailable/,
    )
    // The failure happened after the swap and before the up phase.
    expect(h.calls).toContain(`swap:${SOURCE}:${TARGET}`)
    expect(h.calls.some((c) => c.endsWith(':on'))).toBe(false)
  })

  /**
   * BOTH numbers carried broker state describing pre-swap hardware — the
   * derived `Mid to low` feeder on the source respawned every 10 s forever
   * (observed at attempt 2732) because only the device config was repaired.
   */
  it('forgets the broker state of BOTH ids, after the swap and before the switch-up', async () => {
    const h = harness()

    await migrateDevice(h.deps, { sourceId: SOURCE, targetId: TARGET })

    const hwAt = h.calls.indexOf(`swap-hw:${SOURCE}:${TARGET}`)
    const forgetSource = h.calls.indexOf(`forget-streams:${SOURCE}`)
    const forgetTarget = h.calls.indexOf(`forget-streams:${TARGET}`)
    // Before the switch-up — and therefore before the wiring's post-lock
    // per-device reload, which cannot start until this whole composition
    // returns (`migrate-reload.ts`).
    const firstOn = h.calls.findIndex((c) => c.endsWith(':on'))
    expect(forgetSource).toBeGreaterThan(hwAt)
    expect(forgetTarget).toBeGreaterThan(hwAt)
    expect(forgetSource).toBeLessThan(firstOn)
    expect(forgetTarget).toBeLessThan(firstOn)
  })

  it('a failed broker forget is REPORTED, and the migration still completes', async () => {
    const h = harness()
    const deps: MigrateDeviceDeps = {
      ...h.deps,
      forgetStreamState: async (deviceId) => {
        h.calls.push(`forget-streams:${deviceId}`)
        throw new Error('stream-broker unreachable')
      },
    }

    const res = await migrateDevice(deps, { sourceId: SOURCE, targetId: TARGET })

    expect(res.swapped).toBe(true)
    // One loud line per id — silence would read as "the stale state is gone".
    const complaints = h.logged.filter((l) => l.message.includes('NOT forgotten'))
    expect(complaints.map((l) => l.meta['deviceId']).toSorted()).toEqual(
      [SOURCE, TARGET].toSorted(),
    )
    expect(complaints.every((l) => typeof l.meta['remedy'] === 'string')).toBe(true)
  })
})

describe('a device that is not there costs nothing', () => {
  /**
   * Found live, not by reading: a probe with two nonexistent ids reached
   * `swapIds` having already MUTED notifications for both — the disable phase
   * ran first and the swap discovered the problem afterwards. On real ids that
   * is worse than a wasted call: a typo in the TARGET would leave the source
   * with every function off and no migration performed. The camera goes dark
   * and nothing happened.
   *
   * The composition itself cannot make this check — it has no store — so the
   * claim here is the one it CAN make: that it never writes a switch before it
   * is told to proceed. The precheck lives in the wiring
   * (`device-meta-actions.ts::migrateDevice`), above the lock's first write.
   */
  it('an UNKNOWN swapIds failure is read as "rows may have moved": both stay off, no switch comes back', async () => {
    const h = harness()
    const deps: MigrateDeviceDeps = {
      ...h.deps,
      swapIds: async () => {
        throw new Error('sqlite: disk I/O error during moveRow')
      },
    }

    await expect(migrateDevice(deps, { sourceId: SOURCE, targetId: TARGET })).rejects.toThrow(
      /disk I\/O error/,
    )

    expect(h.calls.some((c) => c.endsWith(':off'))).toBe(true)
    expect(h.calls.some((c) => c.endsWith(':on'))).toBe(false)
    const alarms = h.deviceLines.filter((l) => l.level === 'error')
    expect(alarms.map((l) => l.deviceId)).toEqual([SOURCE, TARGET])
    expect(alarms[0]?.meta).toMatchObject({ sourceId: SOURCE, targetId: TARGET, phase: 'swapIds' })
    expect(alarms[0]?.message).toMatch(/operator must intervene/)
  })

  it('a claim on either device refuses the migration BEFORE any switch is flipped or any row swapped (D663)', async () => {
    const h = harness()
    const deps: MigrateDeviceDeps = {
      ...h.deps,
      assertNoFieldClaims: async (a, b) => {
        h.calls.push(`assert-no-claims:${a}:${b}`)
        throw new Error(
          'device 3836 has fields claimed by a customization (battery [percentage]: blk-1)',
        )
      },
    }

    await expect(migrateDevice(deps, { sourceId: SOURCE, targetId: TARGET })).rejects.toThrow(
      /fields claimed by a customization/,
    )

    expect(h.calls).toEqual([`assert-no-claims:${SOURCE}:${TARGET}`])
  })

  it('asks about claims first, on the pre-swap numbers', async () => {
    const h = harness()

    await migrateDevice(h.deps, { sourceId: SOURCE, targetId: TARGET })

    expect(h.calls[0]).toBe(`assert-no-claims:${SOURCE}:${TARGET}`)
    expect(h.calls.filter((c) => c.startsWith('assert-no-claims:'))).toHaveLength(1)
  })
})

/**
 * Ruling I-1 (D663 task 5b): a refusal with NOTHING moved puts both cameras back
 * exactly as they were; a failure once rows may have moved leaves both off and
 * says, per device, that an operator must intervene.
 */
describe('after the disable phase — refused vs failed while moving', () => {
  const refuse = async (): Promise<void> => {
    throw new MigrationRefusedError('[device-manager] swapIds: temp id 5000 is taken')
  }

  it('a refusal with nothing moved switches BOTH cameras back on, then rethrows the refusal', async () => {
    const h = harness()
    const deps: MigrateDeviceDeps = { ...h.deps, swapIds: refuse }

    await expect(migrateDevice(deps, { sourceId: SOURCE, targetId: TARGET })).rejects.toThrow(
      /temp id 5000 is taken/,
    )

    const downs = CAMERA_SWITCH_ORDER.map((id) => `set:${SOURCE}:${id}:off`).concat(
      CAMERA_SWITCH_ORDER.map((id) => `set:${TARGET}:${id}:off`),
    )
    const ups = CAMERA_SWITCH_ORDER.map((id) => `set:${SOURCE}:${id}:on`).concat(
      CAMERA_SWITCH_ORDER.map((id) => `set:${TARGET}:${id}:on`),
    )
    expect(h.calls).toEqual([`assert-no-claims:${SOURCE}:${TARGET}`, ...downs, ...ups])
    expect(h.calls.some((c) => c.startsWith('swap-hw:'))).toBe(false)
    const lines = h.deviceLines.filter((l) => l.message.includes('switches restored'))
    expect(lines.map((l) => [l.level, l.deviceId])).toEqual([
      ['warn', SOURCE],
      ['warn', TARGET],
    ])
    expect(h.deviceLines.some((l) => l.level === 'error')).toBe(false)
  })

  it('restores the EXACT prior state — a switch the operator had off stays off (D62)', async () => {
    const h = harness()
    const deps: MigrateDeviceDeps = {
      ...h.deps,
      swapIds: refuse,
      readSwitches: async (deviceId) =>
        deviceId === SOURCE ? statesWithOff(['notifications', 'recording']) : statesWithOff([]),
    }

    await expect(migrateDevice(deps, { sourceId: SOURCE, targetId: TARGET })).rejects.toThrow()

    const sourceUps = h.calls.filter((c) => c.startsWith(`set:${SOURCE}:`) && c.endsWith(':on'))
    expect(sourceUps).toEqual(
      CAMERA_SWITCH_ORDER.filter((id) => id !== 'notifications' && id !== 'recording').map(
        (id) => `set:${SOURCE}:${id}:on`,
      ),
    )
    const targetUps = h.calls.filter((c) => c.startsWith(`set:${TARGET}:`) && c.endsWith(':on'))
    expect(targetUps).toHaveLength(CAMERA_SWITCH_ORDER.length)
    const sourceLine = h.deviceLines.find(
      (l) => l.deviceId === SOURCE && l.message.includes('switches restored'),
    )
    expect(sourceLine?.meta['stillOff']).toEqual(['recording', 'notifications'])
  })

  it('a switch the camera does not offer is not written on restore', async () => {
    const h = harness()
    const offered = new Map<CameraSwitchId, boolean>([['stream-broker', true]])
    const deps: MigrateDeviceDeps = {
      ...h.deps,
      swapIds: refuse,
      readSwitches: async () => offered,
    }

    await expect(migrateDevice(deps, { sourceId: SOURCE, targetId: TARGET })).rejects.toThrow()

    expect(h.calls.filter((c) => c.endsWith(':on'))).toEqual([
      `set:${SOURCE}:stream-broker:on`,
      `set:${TARGET}:stream-broker:on`,
    ])
  })

  it('an unreadable prior is reported, and the restore falls back to ON — a refusal never leaves a camera dark', async () => {
    const h = harness()
    const deps: MigrateDeviceDeps = {
      ...h.deps,
      swapIds: refuse,
      readSwitches: async (deviceId) => {
        if (deviceId === SOURCE) throw new Error('orchestrator unreachable')
        return statesWithOff(['notifications'])
      },
    }

    await expect(migrateDevice(deps, { sourceId: SOURCE, targetId: TARGET })).rejects.toThrow()

    expect(h.calls.filter((c) => c.startsWith(`set:${SOURCE}:`) && c.endsWith(':on'))).toHaveLength(
      CAMERA_SWITCH_ORDER.length,
    )
    const unreadable = h.deviceLines.find((l) =>
      l.message.includes('prior switch states unreadable'),
    )
    expect(unreadable).toMatchObject({ level: 'warn', deviceId: SOURCE })
    const restored = h.deviceLines.find(
      (l) => l.deviceId === SOURCE && l.message.includes('switches restored'),
    )
    expect(restored?.meta['priorKnown']).toBe(false)
  })

  it('a swapHardwareState failure leaves BOTH off and raises an ERROR per device naming what moved', async () => {
    const h = harness()
    const deps: MigrateDeviceDeps = {
      ...h.deps,
      swapHardwareState: async () => {
        throw new MigrationRefusedError('even a refusal HERE is not a refusal: rows already moved')
      },
    }

    await expect(migrateDevice(deps, { sourceId: SOURCE, targetId: TARGET })).rejects.toThrow(
      /rows already moved/,
    )

    expect(h.calls.some((c) => c.endsWith(':on'))).toBe(false)
    const alarms = h.deviceLines.filter((l) => l.level === 'error')
    expect(alarms.map((l) => l.deviceId)).toEqual([SOURCE, TARGET])
    for (const alarm of alarms) {
      expect(alarm.message).toMatch(/both cameras left switched off; operator must intervene/)
      expect(alarm.meta).toMatchObject({
        sourceId: SOURCE,
        targetId: TARGET,
        phase: 'swapHardwareState',
      })
      expect(String(alarm.meta['moved'])).toMatch(/rows swapped/)
    }
  })
})
