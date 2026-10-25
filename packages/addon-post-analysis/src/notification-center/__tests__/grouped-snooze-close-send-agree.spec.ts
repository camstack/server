/**
 * D692 Task 11 (review T9a M-2) — the grouped CLOSE and the SEND gate judge a person+dog
 * window by the SAME member classes, on the real centre and the real dispatcher, so neither
 * side can drift from the other:
 *
 *  - a `person` class snooze does not cover the dog → the close writes the row AND the
 *    dispatcher delivers it;
 *  - `person` + `dog` snoozes cover every member class → the close writes NO row, and a
 *    row of that shape that exists anyway (written before the snooze) is suppressed at send.
 */

import { ncTable } from './support/nc-test-deps.js'
import { afterEach, describe, expect, it } from 'vitest'
import {
  boot,
  CALLER,
  DEVICE,
  event,
  type Harness,
  makeHarness,
  outboxIds,
  restart,
  rule,
  T0,
} from './grouped-harness.js'

type SnoozeInput = Parameters<Harness['center']['createSnooze']>[0]

function classSnooze(classes: readonly string[]): SnoozeInput {
  return {
    scope: 'device',
    deviceId: DEVICE,
    classes: [...classes],
    durationMinutes: 60,
    global: true,
    summary: false,
  }
}

async function openPersonAndDog(h: Harness): Promise<void> {
  await boot(h, rule({ conditions: { classes: ['person', 'dog'] } }))
  h.center.onObjectEventPersisted(event({ trackId: 'trk-1' }))
  h.center.onObjectEventPersisted(
    event({ trackId: 'trk-d', className: 'dog', timestamp: T0 + 500 }),
  )
  await h.settle()
}

describe('close says not covered, send agrees (review T9a M-2)', () => {
  let h: Harness
  afterEach(async () => {
    await h.center.stop()
  })

  it('a `person` class snooze: the row is written AND delivered', async () => {
    h = makeHarness()
    await openPersonAndDog(h)
    await h.center.createSnooze(classSnooze(['person']), CALLER)
    await h.tick(T0 + 20_000)
    await h.tick(T0 + 20_500)

    expect(outboxIds(h.world)).toHaveLength(1)
    expect(h.sends).toHaveLength(1)
    expect(h.linesOf('notification suppressed by snooze')).toHaveLength(0)
  })

  it('`person` + `dog` snoozes: NO row at close (the converse)', async () => {
    h = makeHarness()
    await openPersonAndDog(h)
    await h.center.createSnooze(classSnooze(['person']), CALLER)
    await h.center.createSnooze(classSnooze(['dog']), CALLER)
    await h.tick(T0 + 20_000)
    await h.tick(T0 + 20_500)

    expect(outboxIds(h.world)).toHaveLength(0)
    expect(h.sends).toHaveLength(0)
    expect(h.linesOf('grouped window closed with NO notification')).toHaveLength(1)
  })

  it('a row of that shape that already exists is suppressed at send once both are snoozed', async () => {
    h = makeHarness()
    await openPersonAndDog(h)
    await h.center.createSnooze(classSnooze(['person']), CALLER)
    await h.tick(T0 + 20_000)
    await h.tick(T0 + 20_500)
    expect(h.sends).toHaveLength(1)
    await h.center.createSnooze(classSnooze(['dog']), CALLER)
    await h.center.stop()

    // The same row, pending again, on a fresh centre over the same store: the real gate.
    const rows = ncTable(h.world, 'outbox')
    if (rows.size === 0) throw new Error('no outbox')
    for (const [id, data] of rows) {
      h.world.seed('outbox', { id, data: { ...data, status: 'pending', nextAttemptAt: 0 } })
    }
    h = makeHarness({ world: h.world, startAt: T0 + 30_000 })
    await restart(h)
    await h.tick(T0 + 31_000)

    expect(h.sends).toHaveLength(0)
    expect(h.linesOf('notification suppressed by snooze')).toHaveLength(1)
  })
})
