/**
 * The `migrateDevice` WIRING — what the composition's deps actually do on a
 * live hub. Four claims, all bought with real minutes on 2026-09-01/04:
 *
 * - **The `stream-broker` switch never crosses the api.** Its authority is
 *   `deviceManager.setDisabled` — this addon. Routed through
 *   `pipelineOrchestrator.setCameraSwitch` it comes back over UDS into the
 *   meta write lock the migration already holds: a self-deadlock the
 *   transport resolved at its 60 s default, once per phase (three minutes of
 *   a 3.5-minute migration), with the timed-out write ghost-landing after the
 *   swap. In-process it is instant, honest, and final.
 * - **The blast radius is the two migrated devices.** The flush is a
 *   per-device `deviceProvider.reloadDevice` at each owning runner plus the
 *   hub's own id-keyed caches — never a provider restart while the reload is
 *   available. Restarting the whole owning addon took 28 devices down for
 *   one migrated camera (2026-09-04).
 * - **The whole-addon restart survives only as the FALLBACK** (provider
 *   unreachable / too old for `reloadDevice`), per affected addon, restarts
 *   concurrent, each still logging its blast radius.
 * - **A retry cannot re-run a swap**: refused mid-flight, replayed as a no-op
 *   after completion — and a replay flushes nothing, because nothing moved.
 *
 * Harness style mirrors `device-disabled-events.spec.ts` — real addon, real
 * sqlite-backed row store, fake api surfaces.
 */
import { CAMERA_SWITCH_ORDER, EventCategory } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { registerCamera, setup, type SwitchCall } from './device-manager-harness.js'

describe('the stream-broker switch is written in-process', () => {
  it('never crosses the api — and the flag genuinely moves', async () => {
    const h = await setup({ reloadableProviders: ['provider-hikvision', 'provider-reolink'] })
    const sourceId = await registerCamera(h, 'provider-hikvision', 'cam-old')
    const targetId = await registerCamera(h, 'provider-reolink', 'cam-new')
    h.events.length = 0

    const res = await h.provider.migrateDevice({ sourceId, targetId })

    // Not one stream-broker write reached the orchestrator; the other seven
    // switches still went through it, three phases each.
    expect(h.switchCalls.filter((c) => c.switchId === 'stream-broker')).toHaveLength(0)
    expect(h.switchCalls).toHaveLength((CAMERA_SWITCH_ORDER.length - 1) * 3)

    // The write is honest: `off`, not the `unreachable` the 60 s self-deadlock
    // used to produce — and the transitions were announced.
    const streamBroker = res.switches.filter((r) => r.switchId === 'stream-broker')
    expect(streamBroker.map((r) => r.outcome)).toEqual(['off', 'off', 'on'])
    expect(res.sourceStillLive).not.toContain('stream-broker')
    const categories = h.events.map((e) => e.category)
    expect(categories.filter((c) => c === EventCategory.DeviceDisabled)).toHaveLength(2)
    expect(categories.filter((c) => c === EventCategory.DeviceEnabled)).toHaveLength(1)

    // Final state: the inherited number is enabled, the outgoing box is off.
    const sourceMeta = await h.provider.loadMeta({ deviceId: sourceId })
    expect(sourceMeta?.disabled).toBe(false)
    const targetMeta = await h.provider.loadMeta({ deviceId: targetId })
    expect(targetMeta?.disabled).toBe(true)
  })
})

describe('the blast radius is the two migrated devices', () => {
  /**
   * The bar (operator, 2026-09-04): after a migration the two migrated
   * devices are correct, and every other device owned by those providers
   * keeps working WITHOUT interruption. This test fails if anything beyond
   * the two migrated identities is touched — a bystander reload, or any
   * whole-addon restart.
   */
  it('reloads exactly the two migrated identities — no bystander, no restart', async () => {
    const h = await setup({ reloadableProviders: ['provider-hikvision', 'provider-reolink'] })
    const sourceId = await registerCamera(h, 'provider-hikvision', 'cam-old')
    const targetId = await registerCamera(h, 'provider-reolink', 'cam-new')
    await registerCamera(h, 'provider-hikvision', 'cam-bystander')

    await h.provider.migrateDevice({ sourceId, targetId })

    // Post-swap, the identity at sourceId is the reolink's, at targetId the
    // hikvision's — each reloaded at ITS owner, and nothing else anywhere.
    expect(h.reloadCalls.toSorted((a, b) => a.stableId.localeCompare(b.stableId))).toEqual([
      { addonId: 'provider-reolink', stableId: 'cam-new' },
      { addonId: 'provider-hikvision', stableId: 'cam-old' },
    ])
    expect(h.reloadCalls.some((c) => c.stableId === 'cam-bystander')).toBe(false)
    expect(h.restartedAddonIds).toEqual([])

    // And the flush comes AFTER the last switch write — the reload's fresh
    // instance must wake up to post-migration state.
    const lastSwitch = h.timeline.map((e) => e.startsWith('switch:')).lastIndexOf(true)
    const firstReload = h.timeline.findIndex((e) => e.startsWith('reload:'))
    expect(firstReload).toBeGreaterThan(lastSwitch)
  })

  it('the hub mirror answers the SWAPPED runtime state immediately — the reseed replaces, it does not fill gaps (D663)', async () => {
    const h = await setup({ reloadableProviders: ['provider-hikvision', 'provider-reolink'] })
    const sourceId = await registerCamera(h, 'provider-hikvision', 'cam-old')
    const targetId = await registerCamera(h, 'provider-reolink', 'cam-new')
    const OLD = { percentage: 10, charging: 'none', sleeping: false, lastUpdated: 1 }
    const NEW = { percentage: 90, charging: 'dc', sleeping: false, lastUpdated: 2 }
    await h.settings.writeDeviceRuntimeState(sourceId, { battery: OLD })
    await h.settings.writeDeviceRuntimeState(targetId, { battery: NEW })
    // The boot seed: both mirrors hold their own hardware's slice.
    await h.provider.loadRuntimeState({ deviceId: sourceId })
    await h.provider.loadRuntimeState({ deviceId: targetId })
    expect(await h.capSlice(sourceId, 'battery')).toEqual(OLD)

    await h.provider.migrateDevice({ sourceId, targetId })

    // A read landing before the respawn answers from the hardware now wearing
    // each number. A fill-gaps seed would have kept OLD under sourceId.
    expect(await h.capSlice(sourceId, 'battery')).toEqual(NEW)
    expect(await h.capSlice(targetId, 'battery')).toEqual(OLD)
  })

  it("the hub's owner map answers the post-swap truth immediately", async () => {
    const h = await setup({ reloadableProviders: ['provider-hikvision', 'provider-reolink'] })
    const sourceId = await registerCamera(h, 'provider-hikvision', 'cam-old')
    const targetId = await registerCamera(h, 'provider-reolink', 'cam-new')

    await h.provider.migrateDevice({ sourceId, targetId })

    // `resolveDeviceOwnerSync` reads ONLY `idToAddonId`. In the restart era
    // this map stayed stale until the provider re-registered — every call
    // routed by owner hit the wrong addon in the meantime.
    expect(h.resolveOwner(sourceId)).toBe('provider-reolink')
    expect(h.resolveOwner(targetId)).toBe('provider-hikvision')
  })

  it('a provider that cannot reload falls back to restarting THAT provider only', async () => {
    // reolink serves `reloadDevice`; hikvision is absent from the registry —
    // the "deployed closure too old / runner unreachable" case.
    const h = await setup({ reloadableProviders: ['provider-reolink'] })
    const sourceId = await registerCamera(h, 'provider-hikvision', 'cam-old')
    const targetId = await registerCamera(h, 'provider-reolink', 'cam-new')
    await registerCamera(h, 'provider-hikvision', 'cam-bystander')

    await h.provider.migrateDevice({ sourceId, targetId })

    expect(h.reloadCalls).toEqual([{ addonId: 'provider-reolink', stableId: 'cam-new' }])
    expect(h.restartedAddonIds).toEqual(['provider-hikvision'])
    // The fallback still names its blast radius — the operator must see it.
    const blastLines = vi
      .mocked(h.logger.info)
      .mock.calls.filter(
        ([message]) => message === 'migration: restarting a whole provider to flush the id maps',
      )
    expect(blastLines).toHaveLength(1)
    expect(blastLines[0]?.[1]?.meta).toMatchObject({
      addonId: 'provider-hikvision',
      devicesTakenDown: 2,
    })
  })
})

describe('the whole-addon restart is only the fallback', () => {
  it('with no reload-capable providers, both owners restart CONCURRENTLY', async () => {
    const h = await setup()
    const sourceId = await registerCamera(h, 'provider-hikvision', 'cam-old')
    const targetId = await registerCamera(h, 'provider-reolink', 'cam-new')

    await h.provider.migrateDevice({ sourceId, targetId })

    expect(h.restartedAddonIds.toSorted()).toEqual(['provider-hikvision', 'provider-reolink'])
    expect(h.maxConcurrentRestarts()).toBe(2)
    const infoCalls = vi.mocked(h.logger.info).mock.calls
    const blastLines = infoCalls.filter(
      ([message]) => message === 'migration: restarting a whole provider to flush the id maps',
    )
    expect(blastLines).toHaveLength(2)
    for (const [, options] of blastLines) {
      expect(options?.meta).toMatchObject({ devicesTakenDown: 1 })
    }
  })
})

describe('a retry cannot re-run a swap', () => {
  it('a second call mid-flight is REFUSED, not queued behind the lock', async () => {
    const h = await setup({ reloadableProviders: ['provider-hikvision', 'provider-reolink'] })
    const sourceId = await registerCamera(h, 'provider-hikvision', 'cam-old')
    const targetId = await registerCamera(h, 'provider-reolink', 'cam-new')

    const gate = h.gateNextSwitchWrite()
    const firstRun = h.provider.migrateDevice({ sourceId, targetId })
    await gate.reached

    // The retry of 2026-09-01, replayed: it must fail NOW, not park on the
    // FIFO lock and swap everything back when the first run finishes.
    await expect(h.provider.migrateDevice({ sourceId, targetId })).rejects.toThrow(
      /already in flight/,
    )

    gate.release()
    const res = await firstRun
    expect(res.swapped).toBe(true)
    // Exactly ONE swap happened: the inherited number wears the new hardware.
    const sourceMeta = await h.provider.loadMeta({ deviceId: sourceId })
    expect(sourceMeta?.stableId).toBe('cam-new')
  })

  it('a repeat of a completed swap is a no-op returning the original report', async () => {
    const h = await setup({ reloadableProviders: ['provider-hikvision', 'provider-reolink'] })
    const sourceId = await registerCamera(h, 'provider-hikvision', 'cam-old')
    const targetId = await registerCamera(h, 'provider-reolink', 'cam-new')

    const first = await h.provider.migrateDevice({ sourceId, targetId })
    const writesAfterFirst = h.switchCalls.length
    const reloadsAfterFirst = h.reloadCalls.length

    const second = await h.provider.migrateDevice({ sourceId, targetId })

    // The same report — and NOTHING re-ran: no switch writes, no second swap,
    // and no reload either (the rows did not move, so there is nothing stale).
    expect(second).toBe(first)
    expect(h.switchCalls).toHaveLength(writesAfterFirst)
    expect(h.reloadCalls).toHaveLength(reloadsAfterFirst)
    expect(h.restartedAddonIds).toEqual([])
    const sourceMeta = await h.provider.loadMeta({ deviceId: sourceId })
    expect(sourceMeta?.stableId).toBe('cam-new')
    const targetMeta = await h.provider.loadMeta({ deviceId: targetId })
    expect(targetMeta?.stableId).toBe('cam-old')
  })
})

describe('a device under customization is not migratable (D663)', () => {
  const CLAIMED_ROW = {
    battery: { percentage: 10, charging: 'none', sleeping: false, lastUpdated: 1 },
    $owned: {
      battery: {
        owner: 'blk-1',
        mode: 'replace',
        fields: ['percentage'],
        values: { percentage: 90 },
      },
    },
  }

  it('a claim on the TARGET row refuses by name — no switch written, no row moved, a tagged line', async () => {
    const h = await setup({ reloadableProviders: ['provider-hikvision', 'provider-reolink'] })
    const sourceId = await registerCamera(h, 'provider-hikvision', 'cam-old')
    const targetId = await registerCamera(h, 'provider-reolink', 'cam-new')
    await h.settings.writeDeviceRuntimeState(targetId, CLAIMED_ROW)

    await expect(h.provider.migrateDevice({ sourceId, targetId })).rejects.toThrow(
      new RegExp(
        `migration ${sourceId} → ${targetId} refused: device ${targetId} has fields claimed by a customization \\(battery \\[percentage\\]: blk-1\\)`,
      ),
    )

    expect(h.switchCalls).toEqual([])
    expect((await h.provider.loadMeta({ deviceId: sourceId }))?.stableId).toBe('cam-old')
    expect(await h.settings.readDeviceRuntimeState(targetId)).toEqual(CLAIMED_ROW)
    const refusals = vi
      .mocked(h.logger.warn)
      .mock.calls.filter(([message]) => message.includes('refused: fields claimed'))
    expect(refusals).toHaveLength(1)
    expect(refusals[0]?.[1]).toMatchObject({
      tags: { deviceId: targetId },
      meta: {
        sourceId,
        targetId,
        claims: [{ cap: 'battery', owner: 'blk-1', fields: ['percentage'] }],
      },
    })
  })

  it('a refused migration is not "in flight" — the retry after deleting the customization runs', async () => {
    const h = await setup({ reloadableProviders: ['provider-hikvision', 'provider-reolink'] })
    const sourceId = await registerCamera(h, 'provider-hikvision', 'cam-old')
    const targetId = await registerCamera(h, 'provider-reolink', 'cam-new')
    await h.settings.writeDeviceRuntimeState(sourceId, CLAIMED_ROW)
    await expect(h.provider.migrateDevice({ sourceId, targetId })).rejects.toThrow(/claimed/)

    await h.settings.writeDeviceRuntimeState(sourceId, { battery: CLAIMED_ROW.battery })
    const res = await h.provider.migrateDevice({ sourceId, targetId })
    expect(res.swapped).toBe(true)
  })
})

describe('a claim racing the migration never moves with the swap (D663 final review I-1)', () => {
  it('a claim whose write-through is still in flight when the migration starts: refused after the drain, switches restored, no claim moved', async () => {
    const h = await setup({ reloadableProviders: ['provider-hikvision', 'provider-reolink'] })
    const sourceId = await registerCamera(h, 'provider-hikvision', 'cam-old')
    const targetId = await registerCamera(h, 'provider-reolink', 'cam-new')
    const OLD = { percentage: 10, charging: 'none', sleeping: false, lastUpdated: 1 }
    const NEW = { percentage: 90, charging: 'dc', sleeping: false, lastUpdated: 2 }
    await h.settings.writeDeviceRuntimeState(sourceId, { battery: OLD })
    await h.settings.writeDeviceRuntimeState(targetId, { battery: NEW })
    await h.provider.loadRuntimeState({ deviceId: sourceId })
    await h.provider.loadRuntimeState({ deviceId: targetId })

    // The composer's claim passed the migration gate; its write-through PARKS
    // (a slow sqlite commit), so the row does not carry `$owned` yet when the
    // migration reads it — `assertNoFieldClaims` passes.
    const realWrite = h.settings.writeDeviceRuntimeState.getMockImplementation()
    if (!realWrite) throw new Error('settings fake has no write implementation')
    let parkedReached: () => void = () => {}
    const reached = new Promise<void>((resolve) => {
      parkedReached = resolve
    })
    h.settings.writeDeviceRuntimeState.mockImplementationOnce(async (id, data) => {
      parkedReached()
      // Lands while the migration's drain awaits it.
      await new Promise((resolve) => setTimeout(resolve, 100))
      await realWrite(id, data)
    })
    const claiming = h.deviceState.claimFields({
      deviceId: sourceId,
      capName: 'battery',
      owner: 'blk-1',
      mode: 'replace',
      fields: ['percentage'],
      values: { percentage: 55 },
    })
    await reached
    h.priorOff.set(targetId, ['notifications'])

    await expect(h.provider.migrateDevice({ sourceId, targetId })).rejects.toThrow(
      new RegExp(`device ${sourceId} .*claimed by a customization`),
    )
    expect(await claiming).toEqual({ ok: true, changed: true })

    // Nothing moved: identities, and the claim on the row of the number it names.
    expect((await h.provider.loadMeta({ deviceId: sourceId }))?.stableId).toBe('cam-old')
    expect((await h.provider.loadMeta({ deviceId: targetId }))?.stableId).toBe('cam-new')
    expect(await h.settings.readDeviceRuntimeState(sourceId)).toMatchObject({
      $owned: { battery: { owner: 'blk-1', fields: ['percentage'] } },
    })
    expect(await h.settings.readDeviceRuntimeState(targetId)).toEqual({ battery: NEW })
    expect(await h.capSlice(sourceId, 'battery')).toEqual({ ...OLD, percentage: 55 })

    // Refused before any row moved: both cameras back exactly as they were.
    const ups = h.switchCalls.filter((c) => c.enabled)
    const expectedUps = (deviceId: number, off: readonly string[]): SwitchCall[] =>
      CAMERA_SWITCH_ORDER.filter((id) => id !== 'stream-broker' && !off.includes(id)).map(
        (switchId) => ({ deviceId, switchId, enabled: true }),
      )
    expect(ups).toEqual([...expectedUps(sourceId, []), ...expectedUps(targetId, ['notifications'])])
    expect((await h.provider.loadMeta({ deviceId: sourceId }))?.disabled).toBe(false)
    const refusals = vi
      .mocked(h.logger.warn)
      .mock.calls.filter(([message]) => message.includes('claim landed during the migration'))
    expect(refusals.map(([, o]) => o?.tags)).toEqual([{ deviceId: sourceId }])
  }, 10_000)
})

describe('the swap never races the mirror writer (D663 re-review N-6)', () => {
  it('a runtime-state write IN FLIGHT when the migration starts lands BEFORE the swap, never on the swapped row', async () => {
    const h = await setup({ reloadableProviders: ['provider-hikvision', 'provider-reolink'] })
    const sourceId = await registerCamera(h, 'provider-hikvision', 'cam-old')
    const targetId = await registerCamera(h, 'provider-reolink', 'cam-new')
    const OLD = { percentage: 10, charging: 'none', sleeping: false, lastUpdated: 1 }
    const OLD_LATEST = { percentage: 11, charging: 'none', sleeping: false, lastUpdated: 3 }
    const NEW = { percentage: 90, charging: 'dc', sleeping: false, lastUpdated: 2 }
    await h.settings.writeDeviceRuntimeState(sourceId, { battery: OLD })
    await h.settings.writeDeviceRuntimeState(targetId, { battery: NEW })
    await h.provider.loadRuntimeState({ deviceId: sourceId })
    await h.provider.loadRuntimeState({ deviceId: targetId })

    // The old box reports once more; its debounced write fires and PARKS in
    // flight (a slow sqlite commit) carrying the old hardware's blob.
    const realWrite = h.settings.writeDeviceRuntimeState.getMockImplementation()
    if (!realWrite) throw new Error('settings fake has no write implementation')
    let releaseParked: () => void = () => {}
    let parkedReached: () => void = () => {}
    const reached = new Promise<void>((resolve) => {
      parkedReached = resolve
    })
    let swapWrites = 0
    h.settings.writeDeviceRuntimeState
      .mockImplementationOnce(async (id, data) => {
        parkedReached()
        // Released by the swap's second row write (the race, unfixed) or by a
        // fallback timer (the drain waiting on it, fixed) — whichever first.
        await new Promise<void>((resolve) => {
          releaseParked = resolve
          setTimeout(resolve, 200)
        })
        await realWrite(id, data)
      })
      .mockImplementation(async (id, data) => {
        await realWrite(id, data)
        swapWrites += 1
        if (swapWrites === 2) releaseParked()
      })
    await h.setCapSlice(sourceId, 'battery', OLD_LATEST)
    await reached

    await h.provider.migrateDevice({ sourceId, targetId })
    await new Promise((resolve) => setTimeout(resolve, 250))

    // Each number wears the hardware now behind it — the parked write went to
    // the old box's row BEFORE the swap and travelled with it.
    expect(await h.settings.readDeviceRuntimeState(sourceId)).toEqual({ battery: NEW })
    expect(await h.settings.readDeviceRuntimeState(targetId)).toEqual({ battery: OLD_LATEST })
    expect(await h.capSlice(sourceId, 'battery')).toEqual(NEW)

    // And the writer is let go: the new box's next report reaches its row.
    const NEW_LATEST = { ...NEW, percentage: 89, lastUpdated: 4 }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await h.setCapSlice(sourceId, 'battery', NEW_LATEST)
      await vi.advanceTimersByTimeAsync(1_100)
      expect(await h.settings.readDeviceRuntimeState(sourceId)).toEqual({ battery: NEW_LATEST })
    } finally {
      vi.useRealTimers()
    }
  }, 10_000)

  it('a drain write that FAILS refuses the migration before any row moves — never rows swapped and state not', async () => {
    const h = await setup({ reloadableProviders: ['provider-hikvision', 'provider-reolink'] })
    const sourceId = await registerCamera(h, 'provider-hikvision', 'cam-old')
    const targetId = await registerCamera(h, 'provider-reolink', 'cam-new')
    const OLD = { percentage: 10, charging: 'none', sleeping: false, lastUpdated: 1 }
    await h.settings.writeDeviceRuntimeState(sourceId, { battery: OLD })
    await h.provider.loadRuntimeState({ deviceId: sourceId })
    await h.provider.loadRuntimeState({ deviceId: targetId })

    // A change still in its debounce window when the migration starts; the
    // drain's write of it fails.
    await h.setCapSlice(sourceId, 'battery', { ...OLD, percentage: 11, lastUpdated: 3 })
    h.settings.writeDeviceRuntimeState.mockImplementationOnce(async () => {
      throw new Error('sqlite busy')
    })

    // The operator had notifications off on the source before any of this.
    h.priorOff.set(sourceId, ['notifications'])

    await expect(h.provider.migrateDevice({ sourceId, targetId })).rejects.toThrow(
      new RegExp(`runtime state of device ${sourceId} could not be drained .*sqlite busy`),
    )

    expect((await h.provider.loadMeta({ deviceId: sourceId }))?.stableId).toBe('cam-old')
    expect((await h.provider.loadMeta({ deviceId: targetId }))?.stableId).toBe('cam-new')
    const drainLines = vi
      .mocked(h.logger.warn)
      .mock.calls.filter(([message]) => message.includes('migration drain'))
    expect(drainLines.map(([, o]) => o?.tags)).toEqual([{ deviceId: sourceId }])

    // Ruling I-1: nothing moved, so both cameras are back EXACTLY as they were
    // — every switch on again except the one the operator had off.
    const ups = h.switchCalls.filter((c) => c.enabled)
    const expectedUps = (deviceId: number, off: readonly string[]): SwitchCall[] =>
      CAMERA_SWITCH_ORDER.filter((id) => id !== 'stream-broker' && !off.includes(id)).map(
        (switchId) => ({ deviceId, switchId, enabled: true }),
      )
    expect(ups).toEqual([...expectedUps(sourceId, ['notifications']), ...expectedUps(targetId, [])])
    expect((await h.provider.loadMeta({ deviceId: sourceId }))?.disabled).toBe(false)
    expect((await h.provider.loadMeta({ deviceId: targetId }))?.disabled).toBe(false)
    const restoredLines = vi
      .mocked(h.logger.warn)
      .mock.calls.filter(([message]) => message.includes('switches restored'))
    expect(restoredLines.map(([, o]) => o?.tags)).toEqual([
      { deviceId: sourceId },
      { deviceId: targetId },
    ])
  })

  it('a swapHardwareState failure leaves both OFF, raises an ERROR per device — and the writer is still let go', async () => {
    const h = await setup({ reloadableProviders: ['provider-hikvision', 'provider-reolink'] })
    const sourceId = await registerCamera(h, 'provider-hikvision', 'cam-old')
    const targetId = await registerCamera(h, 'provider-reolink', 'cam-new')
    const OLD = { percentage: 10, charging: 'none', sleeping: false, lastUpdated: 1 }
    await h.settings.writeDeviceRuntimeState(sourceId, { battery: OLD })
    await h.provider.loadRuntimeState({ deviceId: sourceId })
    await h.provider.loadRuntimeState({ deviceId: targetId })
    // Only `swapHardwareState` clears a device store.
    h.settings.clearDeviceStore.mockRejectedValueOnce(new Error('device store unavailable'))

    await expect(h.provider.migrateDevice({ sourceId, targetId })).rejects.toThrow(
      /device store unavailable/,
    )

    // Rows DID move — and nothing was switched back on over crossed identities.
    expect((await h.provider.loadMeta({ deviceId: sourceId }))?.stableId).toBe('cam-new')
    expect(h.switchCalls.some((c) => c.enabled)).toBe(false)
    const alarms = vi
      .mocked(h.logger.error)
      .mock.calls.filter(([message]) => message.includes('operator must intervene'))
    expect(alarms.map(([, o]) => o?.tags)).toEqual([{ deviceId: sourceId }, { deviceId: targetId }])
    expect(alarms[0]?.[1]?.meta).toMatchObject({ phase: 'swapHardwareState', sourceId, targetId })

    // M-1: the hold is released on this throw path too — a later report persists.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const LATER = { ...OLD, percentage: 55, lastUpdated: 9 }
      await h.setCapSlice(sourceId, 'battery', LATER)
      await vi.advanceTimersByTimeAsync(1_100)
      expect(await h.settings.readDeviceRuntimeState(sourceId)).toMatchObject({ battery: LATER })
    } finally {
      vi.useRealTimers()
    }
  })
})
