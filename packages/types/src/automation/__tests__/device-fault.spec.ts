/**
 * The fault leaves: a device's WHOLE fault list is matched (not only the
 * principal code), "raised" fires once per appearance, and an unknown or failed
 * read never matches and never fires (D49, D315).
 */
import { describe, expect, it } from 'vitest'
import { ConditionMirror, collectWhenMirrorSources, evaluateWhenTree } from '../condition-eval.js'
import { generateAutomationBlock } from '../codegen.js'
import { FaultRaisedWatch, readFault } from '../device-fault.js'
import { AutomationWhenSchema, isEventLeaf, type AutomationWhen } from '../when.js'

const ERROR_CAP = 'error'

const fault = (code: string) => ({ code, label: code, severity: 'error' as const })

function slice(code: string | null, faults?: readonly string[]) {
  return {
    active: code !== null,
    code,
    label: null,
    severity: null,
    since: null,
    ...(faults === undefined ? {} : { faults: faults.map(fault) }),
    lastFetchedAt: 0,
  }
}

const isFault = (codes: readonly string[]): AutomationWhen => ({
  kind: 'device-fault-is',
  deviceId: 7,
  codes: [...codes],
})

function evaluate(when: AutomationWhen, value: unknown) {
  const mirror = new ConditionMirror(collectWhenMirrorSources(when))
  if (value !== undefined) mirror.apply(7, ERROR_CAP, value)
  return evaluateWhenTree(when, mirror, 0)
}

describe('device-fault-is', () => {
  it('reads the error cap of the device through the mirror', () => {
    expect(collectWhenMirrorSources(isFault(['unreachable']))).toEqual([
      { kind: 'device', deviceId: 7, cap: ERROR_CAP },
    ])
  })

  it('matches a SECONDARY fault of the list, not only the principal code', () => {
    const r = evaluate(
      isFault(['low-battery']),
      slice('unreachable', ['unreachable', 'low-battery']),
    )
    expect(r.pass).toBe(true)
    expect(r.nodes[0]).toMatchObject({ kind: 'device-fault-is', outcome: 'pass', deviceId: 7 })
  })

  it('falls back to the principal code when the provider publishes no list', () => {
    expect(evaluate(isFault(['unreachable']), slice('unreachable')).pass).toBe(true)
    expect(evaluate(isFault(['low-battery']), slice('unreachable')).pass).toBe(false)
  })

  it('an empty code list means any fault, and no fault never matches', () => {
    expect(evaluate(isFault([]), slice('unreachable')).pass).toBe(true)
    expect(evaluate(isFault([]), slice(null)).pass).toBe(false)
  })

  it('an unanswered read is unknown: it fails and says so, never "no fault"', () => {
    const missing = evaluate(isFault([]), undefined)
    expect(missing.pass).toBe(false)
    expect(missing.unknown).toBe(true)
    const cold = evaluate(isFault([]), { ...slice(null), active: null })
    expect(cold.unknown).toBe(true)
  })

  it('a not-leaf over an unknown reading stays unknown, never passes', () => {
    const r = evaluate({ kind: 'not', child: isFault(['unreachable']) }, undefined)
    expect(r.unknown).toBe(true)
  })
})

describe('FaultRaisedWatch', () => {
  const read = (code: string | null, faults?: readonly string[]) => {
    const s = slice(code, faults)
    return readFault(s.active, s.code, s.faults)
  }

  it('the first reading only seeds: a fault already raised is not a transition', () => {
    const watch = new FaultRaisedWatch(['unreachable'])
    expect(watch.observe(read('unreachable'))).toBeUndefined()
  })

  it('fires once when a wanted fault appears, and not again while it stays', () => {
    const watch = new FaultRaisedWatch(['unreachable'])
    watch.observe(read(null))
    expect(watch.observe(read('unreachable'))).toEqual({
      code: 'unreachable',
      codes: ['unreachable'],
    })
    expect(watch.observe(read('unreachable'))).toBeUndefined()
  })

  it('fires again after the fault clears and returns', () => {
    const watch = new FaultRaisedWatch(['unreachable'])
    watch.observe(read(null))
    watch.observe(read('unreachable'))
    watch.observe(read(null))
    expect(watch.observe(read('unreachable'))?.code).toBe('unreachable')
  })

  it('fires on a secondary fault that appears next to the principal', () => {
    const watch = new FaultRaisedWatch(['low-battery'])
    watch.observe(read('unreachable', ['unreachable']))
    expect(watch.observe(read('unreachable', ['unreachable', 'low-battery']))?.code).toBe(
      'low-battery',
    )
  })

  it('ignores a fault it was not asked about, and fires for any fault when asked for none', () => {
    const named = new FaultRaisedWatch(['unreachable'])
    named.observe(read(null))
    expect(named.observe(read('low-battery'))).toBeUndefined()
    const any = new FaultRaisedWatch([])
    any.observe(read(null))
    expect(any.observe(read('low-battery'))?.code).toBe('low-battery')
  })

  it('an unknown reading never fires and does not forget what was seen', () => {
    const watch = new FaultRaisedWatch(['unreachable'])
    watch.observe(read(null))
    expect(watch.observe(undefined)).toBeUndefined()
    expect(watch.observe(readFault(null, null, undefined))).toBeUndefined()
    expect(watch.observe(read('unreachable'))?.code).toBe('unreachable')
  })

  it('an unknown reading while a fault is raised does not re-arm it', () => {
    const watch = new FaultRaisedWatch(['unreachable'])
    watch.observe(read(null))
    watch.observe(read('unreachable'))
    watch.observe(undefined)
    expect(watch.observe(read('unreachable'))).toBeUndefined()
  })
})

describe('the fault leaves in a recipe', () => {
  const raised: AutomationWhen = {
    kind: 'device-fault-raised',
    deviceId: 7,
    codes: ['unreachable'],
  }

  it('parses; raised is an event, "is" a state', () => {
    expect(AutomationWhenSchema.parse(raised)).toEqual(raised)
    expect(isEventLeaf(raised)).toBe(true)
    expect(isEventLeaf(isFault([]))).toBe(false)
  })

  it('a code outside any catalog still parses and round-trips', () => {
    const odd: AutomationWhen = isFault(['vendor-specific-9'])
    expect(AutomationWhenSchema.parse(odd)).toEqual(odd)
  })

  it('the generated block watches the whole fault list through FaultRaisedWatch', () => {
    const code = generateAutomationBlock({
      name: 'Gateway recovery',
      recipe: {
        when: raised,
        actions: [{ kind: 'wait', seconds: 1 }],
        runMode: { mode: 'cooldown', minutes: 60 },
      },
    })
    expect(code).toContain('new FaultRaisedWatch(["unreachable"])')
    expect(code).toContain("readCapSlice(7, 'error')")
  })
})
