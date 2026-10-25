/**
 * D651 fix round: a gallery re-embed pass starts only on a target model read
 * successfully TWICE IN A ROW, and the two reads agree. Not a timer wait: a
 * second read. One mid-boot or failed read, or one read that disagrees with
 * the one before it, changes nothing (D49). A pass that moves the gallery into
 * the wrong space costs one pass to undo and leaves recognition blind for it.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ClusterPinRead } from '../cluster-model-pin.js'
import { ClusterPinConfirmer, PERSISTENT_REFUSAL_ESCALATE_AFTER } from '../face-reembed-trigger.js'

function reads(...sequence: ClusterPinRead[]) {
  const queue = [...sequence]
  return vi.fn(async (): Promise<ClusterPinRead> => {
    const next = queue.shift()
    if (next === undefined) throw new Error('read called more times than scripted')
    return next
  })
}
const known = (modelId: string): ClusterPinRead => ({ kind: 'known', modelId })
const NOT_READY: ClusterPinRead = { kind: 'unknown', reason: 'owner-not-ready' }
const NOT_STORED: ClusterPinRead = { kind: 'not-stored', defaultModelId: 'auraface-r100' }

function logger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
}

describe('ClusterPinConfirmer', () => {
  it('an owner that never wrote its store gives no target, and reads only once', async () => {
    const read = reads(NOT_READY)
    const c = new ClusterPinConfirmer({ readPin: read, label: 'test', logger: logger() })
    expect(await c.confirm()).toEqual({ kind: 'refused', reason: 'owner-not-ready' })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('a second read that disagrees with the first gives no target', async () => {
    const c = new ClusterPinConfirmer({
      readPin: reads(known('auraface-r100'), known('arcface-r100')),
      label: 'test',
      logger: logger(),
    })
    expect(await c.confirm()).toEqual({ kind: 'refused', reason: 'reads-disagree' })
  })

  it('a second read that fails gives no target', async () => {
    const c = new ClusterPinConfirmer({
      readPin: reads(known('auraface-r100'), NOT_READY),
      label: 'test',
      logger: logger(),
    })
    expect(await c.confirm()).toEqual({ kind: 'refused', reason: 'owner-not-ready' })
  })

  it('two agreeing successful reads confirm the target', async () => {
    const read = reads(known('arcface-r100'), known('arcface-r100'))
    const c = new ClusterPinConfirmer({ readPin: read, label: 'test', logger: logger() })
    expect(await c.confirm()).toEqual({
      kind: 'confirmed',
      modelId: 'arcface-r100',
      byAbsence: false,
    })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('an install that never STORED a row: two not-stored reads confirm the default BY ABSENCE', async () => {
    const c = new ClusterPinConfirmer({
      readPin: reads(NOT_STORED, NOT_STORED),
      label: 'test',
      logger: logger(),
    })
    expect(await c.confirm()).toEqual({
      kind: 'confirmed',
      modelId: 'auraface-r100',
      byAbsence: true,
    })
  })

  it('a stored choice and an absence do not agree', async () => {
    const c = new ClusterPinConfirmer({
      readPin: reads(known('auraface-r100'), NOT_STORED),
      label: 'test',
      logger: logger(),
    })
    expect(await c.confirm()).toEqual({ kind: 'refused', reason: 'reads-disagree' })
  })

  it('logs once per state change, not once per tick', async () => {
    const log = logger()
    const c = new ClusterPinConfirmer({
      readPin: reads(
        NOT_READY,
        NOT_READY,
        NOT_READY,
        known('a'),
        known('a'),
        known('a'),
        known('a'),
      ),
      label: 'test',
      logger: log,
    })
    await c.confirm()
    await c.confirm()
    await c.confirm()
    expect(log.info).toHaveBeenCalledTimes(1)
    await c.confirm()
    await c.confirm()
    expect(log.info).toHaveBeenCalledTimes(2)
  })

  it('a recovery logs, and a relapse into the SAME refusal logs again — an answer is an outcome', async () => {
    const log = logger()
    const c = new ClusterPinConfirmer({
      readPin: reads(NOT_READY, NOT_READY, known('a'), known('a'), NOT_READY),
      label: 'test',
      logger: log,
    })
    await c.readFirst()
    await c.readFirst()
    expect(log.info).toHaveBeenCalledTimes(1) // the refusal, once
    await c.readFirst()
    await c.readFirst()
    expect(log.info).toHaveBeenCalledTimes(2) // the recovery, once
    expect(log.info.mock.calls[1]?.[1]).toMatchObject({ meta: { answer: 'stored:a' } })
    await c.readFirst()
    expect(log.info).toHaveBeenCalledTimes(3) // the relapse — not "still owner-not-ready"
    expect(log.info.mock.calls[2]?.[1]).toMatchObject({ meta: { reason: 'owner-not-ready' } })
  })

  it('a confirmation followed by steady first reads of the same answer logs nothing more', async () => {
    const log = logger()
    const c = new ClusterPinConfirmer({
      readPin: reads(known('a'), known('a'), known('a'), known('a'), known('a'), known('a')),
      label: 'test',
      logger: log,
    })
    await c.confirm()
    expect(log.info).toHaveBeenCalledTimes(1)
    await c.readFirst()
    await c.readFirst()
    await c.confirm()
    expect(log.info).toHaveBeenCalledTimes(1)
  })

  it('readFirst returns the answer WITHOUT a second read — the steady state reads once', async () => {
    const read = reads(known('auraface-r100'))
    const c = new ClusterPinConfirmer({ readPin: read, label: 'test', logger: logger() })
    expect(await c.readFirst()).toEqual({ kind: 'answer', answer: known('auraface-r100') })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('a refusal that persists escalates to ONE warn, with the reason, after the named count', async () => {
    const log = logger()
    const n = PERSISTENT_REFUSAL_ESCALATE_AFTER
    const invalid: ClusterPinRead = { kind: 'unknown', reason: 'invalid-stored' }
    const c = new ClusterPinConfirmer({
      readPin: reads(...Array.from({ length: n + 5 }, () => invalid)),
      label: 'test',
      logger: log,
    })
    for (let i = 0; i < n - 1; i++) await c.confirm()
    expect(log.warn).not.toHaveBeenCalled()
    await c.confirm()
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn.mock.calls[0]?.[1]).toMatchObject({
      meta: { reason: 'invalid-stored', consecutive: n },
    })
    for (let i = 0; i < 5; i++) await c.confirm()
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('a successful read resets the streak: a refusal that comes and goes never escalates', async () => {
    const log = logger()
    const n = PERSISTENT_REFUSAL_ESCALATE_AFTER
    const seq: ClusterPinRead[] = []
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < n - 1; j++) seq.push(NOT_READY)
      seq.push(known('a'))
    }
    const c = new ClusterPinConfirmer({ readPin: reads(...seq), label: 'test', logger: log })
    for (let i = 0; i < seq.length; i++) await c.readFirst()
    expect(log.warn).not.toHaveBeenCalled()
  })
})
