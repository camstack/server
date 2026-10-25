import { EventCategory } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CAMERA_101,
  createDoorbellCompositionFixture,
  INITIAL_DOORBELL,
} from './doorbell-composition-fixture.js'

const EDGE_AT = 1_790_588_000_000

describe('camera 101 doorbell composition acceptance', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createDoorbellCompositionFixture>>> = []
  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.shutdown()
  })

  async function createFixture(
    options: Parameters<typeof createDoorbellCompositionFixture>[0] = {},
  ) {
    const fixture = await createDoorbellCompositionFixture(options)
    fixtures.push(fixture)
    return fixture
  }

  it('does not adopt the camera native stamp when the source proves no ring', async () => {
    const fixture = await createFixture({ seededDoorbellSlice: INITIAL_DOORBELL })
    expect(await fixture.effective()).toEqual({ lastPressedAt: null, pressCountSinceStart: 0 })
    expect(fixture.events()).toEqual([])
  })

  it('emits from camera 101 before a held owned-field RPC, then writes count 3', async () => {
    const fixture = await createFixture({ seededDoorbellSlice: INITIAL_DOORBELL })
    const claim = fixture.holdNextClaim()

    await fixture.sourceSwitch({ on: true, changedAt: EDGE_AT })
    await fixture.flushRuntime()

    expect(claim.started()).toBe(true)
    expect(claim.settled()).toBe(false)
    expect(fixture.events()).toEqual([
      expect.objectContaining({
        category: EventCategory.DoorbellOnPressed,
        source: { type: 'device', id: CAMERA_101.id, deviceId: CAMERA_101.id },
        data: { deviceId: CAMERA_101.id, timestamp: EDGE_AT },
      }),
    ])
    expect(
      fixture.timeline().indexOf('doorbell-event'),
      JSON.stringify(fixture.timeline()),
    ).toBeLessThan(fixture.timeline().indexOf('held-owned-field-rpc'))

    claim.resolve()
    await fixture.idle()
    expect(claim.settled()).toBe(true)
    expect(await fixture.effective()).toEqual({
      lastPressedAt: EDGE_AT,
      pressCountSinceStart: 1,
    })
  })

  it('does not emit or increment again for the same high level', async () => {
    const fixture = await createFixture({ seededDoorbellSlice: INITIAL_DOORBELL })
    await fixture.sourceSwitch({ on: true, changedAt: EDGE_AT })
    await fixture.idle()
    await fixture.sourceSwitch({ on: true, changedAt: EDGE_AT })
    await fixture.idle()

    expect(fixture.events()).toHaveLength(1)
    expect(await fixture.effective()).toEqual({
      lastPressedAt: EDGE_AT,
      pressCountSinceStart: 1,
    })
  })

  it('debounces multiple sources on the output field clock', async () => {
    const fixture = await createFixture({
      secondarySource: true,
      seededDoorbellSlice: INITIAL_DOORBELL,
    })
    await fixture.sourceSwitch({ on: true, changedAt: EDGE_AT })
    await fixture.idle()
    await fixture.sourceSwitch({
      source: 'secondary',
      on: true,
      changedAt: EDGE_AT + 1_999,
    })
    await fixture.idle()
    expect(fixture.events()).toHaveLength(1)

    await fixture.sourceSwitch({
      source: 'secondary',
      on: false,
      changedAt: EDGE_AT + 1_999,
    })
    await fixture.idle()
    await fixture.sourceSwitch({
      source: 'secondary',
      on: true,
      changedAt: EDGE_AT + 2_000,
    })
    await fixture.idle()

    expect(fixture.events()).toHaveLength(2)
    expect(fixture.events()[1]?.data).toEqual({
      deviceId: CAMERA_101.id,
      timestamp: EDGE_AT + 2_000,
    })
    expect(await fixture.effective()).toEqual({
      lastPressedAt: EDGE_AT + 2_000,
      pressCountSinceStart: 2,
    })
  })

  it('does not duplicate an emitted event after the following owned write fails', async () => {
    const fixture = await createFixture({ seededDoorbellSlice: INITIAL_DOORBELL })
    fixture.failNextOwnedWrite()
    await fixture.sourceSwitch({ on: true, changedAt: EDGE_AT })
    await fixture.idle()
    expect(fixture.events()).toHaveLength(1)

    await fixture.sourceSwitch({ on: false, changedAt: EDGE_AT + 1 })
    await fixture.idle()
    expect(fixture.events()).toHaveLength(1)
    expect(await fixture.effective()).toEqual({
      lastPressedAt: EDGE_AT,
      pressCountSinceStart: 1,
    })
  })

  it('retains the accumulator across source capability loss', async () => {
    const fixture = await createFixture({
      secondarySource: true,
      seededDoorbellSlice: INITIAL_DOORBELL,
    })
    await fixture.sourceSwitch({ on: true, changedAt: EDGE_AT })
    await fixture.idle()
    await fixture.sourceSwitch({
      source: 'secondary',
      on: true,
      changedAt: EDGE_AT + 2_000,
    })
    await fixture.idle()
    expect(await fixture.effective()).toMatchObject({ pressCountSinceStart: 2 })

    fixture.unregisterSource('secondary')
    fixture.lifecycleBindingsChanged()
    await fixture.idle()

    expect(await fixture.effective()).toMatchObject({ pressCountSinceStart: 2 })
  })

  // D713 — camera 101, 2026-10-06 08:10:56: HA was redeployed, its switch cap
  // unregistered, and the composer wrote `lastPressedAt: null` over the
  // restored stamp (`fresh → unavailable … the provider unregistered switch`);
  // the slice changed twice and the doorbell notified. The stamp is history:
  // the outage changes nothing on 101, and the provider coming back with the
  // same state is not a press.
  it('a source provider redeploy changes nothing on 101: no null, no state change, no press', async () => {
    const fixture = await createFixture({ seededDoorbellSlice: INITIAL_DOORBELL })
    await fixture.sourceSwitch({ on: true, changedAt: EDGE_AT })
    await fixture.idle()
    await fixture.sourceSwitch({ on: false, changedAt: EDGE_AT + 1_000 })
    await fixture.idle()
    const pressed = { lastPressedAt: EDGE_AT, pressCountSinceStart: 1 }
    expect(await fixture.effective()).toEqual(pressed)
    const changesBefore = fixture.doorbellStateChanges().length

    fixture.unregisterSource('primary')
    fixture.lifecycleBindingsChanged()
    await fixture.idle()
    expect(await fixture.effective()).toEqual(pressed)

    fixture.reregisterSource('primary')
    await fixture.sourceSwitch({ on: false, changedAt: EDGE_AT + 1_000 })
    fixture.lifecycleBindingsChanged()
    await fixture.idle()

    expect(await fixture.effective()).toEqual(pressed)
    expect(fixture.doorbellStateChanges().slice(changesBefore)).toEqual([])
    expect(fixture.events()).toHaveLength(1)

    const next = EDGE_AT + 60_000
    await fixture.sourceSwitch({ on: true, changedAt: next })
    await fixture.idle()
    expect(fixture.events()).toHaveLength(2)
    expect(await fixture.effective()).toEqual({ lastPressedAt: next, pressCountSinceStart: 2 })
  })

  it('restarts from the persisted composition and runtime seed without replaying a press', async () => {
    const first = await createFixture({ seededDoorbellSlice: INITIAL_DOORBELL })
    await first.sourceSwitch({ on: true, changedAt: EDGE_AT })
    await first.idle()
    await first.flushDurable()
    const persisted = await first.persisted()

    const restarted = await createFixture({
      from: persisted,
      sourceInitial: { on: true, lastChangedAt: EDGE_AT },
    })

    expect(restarted.events()).toEqual([])
    expect(await restarted.effective()).toEqual({
      lastPressedAt: EDGE_AT,
      pressCountSinceStart: 1,
    })
    expect(await restarted.composerBound()).toBe(true)
  })
  // 2026-09-29, camera 101: no doorbell slice existed when its customization was applied.
  // The count read the composition's OWN lastPressedAt through the hub's
  // effective slice, which exists only once the composer's claim lands, and the
  // claim waited for the count: nothing was served for 12 h, and the first
  // press was swallowed as the count's seed.
  describe('a camera with no doorbell slice before its customization', () => {
    it('serves { null, 0 } right after apply: the claim lands with no press', async () => {
      const fixture = await createFixture()
      expect(await fixture.effective()).toEqual({ lastPressedAt: null, pressCountSinceStart: 0 })
      expect(fixture.events()).toEqual([])
      expect(await fixture.composerBound()).toBe(true)
    })

    it('counts the first press: { EDGE_AT, 1 }, one event, ONE state change', async () => {
      const fixture = await createFixture()
      const before = fixture.doorbellStateChanges().length
      await fixture.sourceSwitch({ on: true, changedAt: EDGE_AT })
      await fixture.idle()

      expect(fixture.events()).toHaveLength(1)
      expect(await fixture.effective()).toEqual({
        lastPressedAt: EDGE_AT,
        pressCountSinceStart: 1,
      })
      // One press is one state change on 101 (Q2: two changes 7 ms apart
      // raced the debounced marker and shipped a notification without a still).
      expect(fixture.doorbellStateChanges().slice(before)).toHaveLength(1)
    })

    it('keeps the lifetime count across a restart and counts the next press on top', async () => {
      const first = await createFixture()
      await first.sourceSwitch({ on: true, changedAt: EDGE_AT })
      await first.idle()
      await first.flushDurable()

      const restarted = await createFixture({
        from: await first.persisted(),
        sourceInitial: { on: false, lastChangedAt: EDGE_AT + 500 },
      })
      expect(restarted.events()).toEqual([])
      expect(await restarted.effective()).toEqual({
        lastPressedAt: EDGE_AT,
        pressCountSinceStart: 1,
      })

      const next = Date.now()
      await restarted.sourceSwitch({ on: true, changedAt: next })
      await restarted.idle()
      expect(restarted.events()).toHaveLength(1)
      expect(await restarted.effective()).toEqual({
        lastPressedAt: next,
        pressCountSinceStart: 2,
      })
    })
  })
})
