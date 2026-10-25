/**
 * D692 Task 15 — the status of a grouped rule and the tester's group of one, on the REAL
 * centre: `ruleStatusFor` reports the open windows with what is still pending, and
 * `nc.testRule`'s injection closes AT ONCE as a group of one WITHOUT touching the shared
 * buffer (C11), so a live window is neither joined nor opened by a test, and a test never
 * lends its bypasses to a live subject.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { isGroupV2 } from '../grouped/grouped-payload.js'
import { planRuleTest } from '../rule-test-plan.js'
import { NcTestEventInputSchema } from '../test-event.js'
import {
  boot,
  CALLER,
  DEVICE,
  event,
  type Harness,
  makeHarness,
  outboxIds,
  rule,
  payloads,
  T0,
} from './grouped-harness.js'

async function ruleOf(h: Harness, ruleId: string) {
  const { rule: stored } = await h.center.buildProvider().getRule({ ruleId })
  if (stored === null) throw new Error('rule not stored')
  return stored
}

/** What `nc.testRule` injects for the rule, minus the live photograph the harness lacks. */
async function testInputOf(h: Harness, ruleId: string) {
  const plan = planRuleTest({ rule: await ruleOf(h, ruleId), now: T0, fallbackDeviceId: DEVICE })
  return { ...plan.input, still: 'none' as const }
}

describe('grouped rule status and the tester (D692 Task 15)', () => {
  let h: Harness
  afterEach(async () => {
    await h.center.stop()
  })

  it('1. the status of a grouped rule lists the open window and what it still waits for', async () => {
    h = makeHarness()
    const ruleId = await boot(h)
    h.center.onObjectEventPersisted(event({ trackId: 'trk-1' }))
    await h.settle()

    const status = await h.center.ruleStatusFor(await ruleOf(h, ruleId))
    expect(status.kind).toBe('grouped')
    if (status.kind !== 'grouped') return
    expect(status.groupingSec).toBe(20)
    expect(status.openWindows).toHaveLength(1)
    expect(status.openWindows?.[0]).toMatchObject({
      deviceId: DEVICE,
      openedAt: T0,
      closesAt: T0 + 20_000,
      members: 1,
      pending: 1,
    })
  })

  it('1b. a member whose outlook is final is not pending', async () => {
    h = makeHarness()
    const ruleId = await boot(h)
    h.outlooks.set('trk-1', { final: true })
    h.center.onObjectEventPersisted(event({ trackId: 'trk-1' }))
    await h.settle()

    const status = await h.center.ruleStatusFor(await ruleOf(h, ruleId))
    expect(status).toMatchObject({ kind: 'grouped', openWindows: [{ members: 1, pending: 0 }] })
  })

  it('1c. a grouped rule with no window open reports an empty list, not "none"', async () => {
    h = makeHarness()
    const ruleId = await boot(h)
    const status = await h.center.ruleStatusFor(await ruleOf(h, ruleId))
    expect(status).toEqual({ kind: 'grouped', groupingSec: 20, openWindows: [] })
  })

  it('1d. a centre that does not evaluate reports UNKNOWN windows, never an empty list (D315)', async () => {
    h = makeHarness()
    const ruleId = await boot(h)
    await h.center.stop()
    await h.center.start({ evaluation: false })

    const status = await h.center.ruleStatusFor(await ruleOf(h, ruleId))
    expect(status).toMatchObject({ kind: 'grouped', groupingSec: 20, openWindows: null })
    expect(status.kind === 'grouped' ? status.reason : undefined).toMatch(
      /does not run rule evaluation/,
    )
  })

  it('2. the tester sends ONE row at once: a group of one, closed as `test`', async () => {
    h = makeHarness()
    const ruleId = await boot(h)
    const result = await h.center.injectTestEvent(await testInputOf(h, ruleId))

    // The row is the close pass's, so the outcome's `enqueued: 0` is not "matched, nothing sent".
    expect(result.notes.filter((n) => n.startsWith('the rule matched but no row'))).toEqual([])
    expect(outboxIds(h.world)).toHaveLength(1)
    const group = payloads(h.world)[0]?.group
    expect(group !== undefined && isGroupV2(group)).toBe(true)
    if (group === undefined || !isGroupV2(group)) return
    expect(group.closeReason).toBe('test')
    expect(group.members).toHaveLength(1)
    expect(h.center.groupedOpenWindows()).toHaveLength(0)
  })

  it('2c. a grouped test on a rule with NO target says the rule matched but nothing was enqueued', async () => {
    h = makeHarness()
    const ruleId = await boot(h, rule({ targets: [], targetUsers: ['someone'] }))
    const result = await h.center.injectTestEvent(await testInputOf(h, ruleId))

    expect(outboxIds(h.world)).toHaveLength(0)
    expect(result.outcomes[0]?.matched).toBe(true)
    expect(result.notes.filter((n) => n.startsWith('the rule matched but no row'))).toHaveLength(1)
  })

  it('2d. a plain rule that matched and enqueued nothing keeps its note beside a grouped test', async () => {
    h = makeHarness()
    const groupedId = await boot(h, rule({ targets: [], targetUsers: ['someone'] }))
    await h.center.buildProvider().createRule({
      rule: rule({
        name: 'plain, no target',
        groupingSec: undefined,
        targets: [],
        targetUsers: ['someone'],
      }),
      caller: CALLER,
    })
    const input = await testInputOf(h, groupedId)
    const { onlyRuleId: _only, ...everyRule } = input
    const result = await h.center.injectTestEvent(everyRule)

    expect(result.outcomes.map((o) => o.ruleName).sort()).toEqual([
      'persone su uscio',
      'plain, no target',
    ])
    expect(result.notes.filter((n) => n.startsWith('the rule matched but no row'))).toHaveLength(1)
  })

  it('2b. `nc.injectTestEvent` without the flag closes at once too (absent means on)', async () => {
    h = makeHarness()
    await boot(h)
    await h.center.injectTestEvent(
      NcTestEventInputSchema.parse({
        trigger: 'object-event',
        deviceId: DEVICE,
        classNames: ['person'],
        zones: [],
        still: 'none',
      }),
    )
    const group = payloads(h.world)[0]?.group
    expect(group !== undefined && isGroupV2(group) ? group.closeReason : undefined).toBe('test')
    expect(h.center.groupedOpenWindows()).toHaveLength(0)
  })

  it('2e. an operator cannot opt out of the close-at-once: the field is not part of the input', async () => {
    h = makeHarness()
    await boot(h)
    const input = NcTestEventInputSchema.parse({
      trigger: 'object-event',
      deviceId: DEVICE,
      classNames: ['person'],
      zones: [],
      still: 'none',
      closeWindowImmediately: false,
    })
    expect('closeWindowImmediately' in input).toBe(false)
    const result = await h.center.injectTestEvent(input)
    expect(result.outcomes.some((o) => o.matched)).toBe(true)
    expect(outboxIds(h.world)).toHaveLength(1)
    expect(h.center.groupedOpenWindows()).toHaveLength(0)
  })

  it('3. a live window is open, then a test: the test is ONE member and the live window keeps only its own', async () => {
    h = makeHarness()
    const ruleId = await boot(h)
    h.center.onObjectEventPersisted(event({ trackId: 'trk-live' }))
    await h.settle()
    await h.center.injectTestEvent(await testInputOf(h, ruleId))

    const rows = payloads(h.world)
    expect(rows).toHaveLength(1)
    const group = rows[0]?.group
    expect(group !== undefined && isGroupV2(group) ? group.members : []).toHaveLength(1)
    const windows = h.center.groupedOpenWindows()
    expect(windows).toHaveLength(1)
    expect(windows[0]?.members.map((m) => m.trackId)).toEqual(['trk-live'])
    expect(windows[0]?.flags.bypassCooldown).toBe(false)
    expect(windows[0]?.flags.bypassMute).toBe(false)
  })

  it('4. a test first, then a live event: the live event opens its OWN window and inherits no bypass', async () => {
    h = makeHarness()
    const ruleId = await boot(h)
    await h.center.injectTestEvent(await testInputOf(h, ruleId))
    h.center.onObjectEventPersisted(event({ trackId: 'trk-live' }))
    await h.settle()

    const windows = h.center.groupedOpenWindows()
    expect(windows).toHaveLength(1)
    expect(windows[0]?.members.map((m) => m.trackId)).toEqual(['trk-live'])
    expect(windows[0]?.origin).toBe('pipeline')
    expect(windows[0]?.flags.bypassCooldown).toBe(false)
    expect(windows[0]?.flags.bypassMute).toBe(false)
  })

  it('4b. a MUTED camera: the test bypasses the mute, a live event opens no window', async () => {
    h = makeHarness()
    const ruleId = await boot(h)
    await h.center.buildProvider().setDeviceMuted({ deviceId: DEVICE, muted: true })
    await h.center.injectTestEvent(await testInputOf(h, ruleId))
    expect(outboxIds(h.world)).toHaveLength(1)

    h.center.onObjectEventPersisted(event({ trackId: 'trk-live' }))
    await h.settle()
    expect(h.center.groupedOpenWindows()).toHaveLength(0)
    expect(outboxIds(h.world)).toHaveLength(1)
  })
})
