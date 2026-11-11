/**
 * What a `device-becomes` trigger hands the run (#499): the device, the value
 * it changed to and the value it had before — named in the one trigger-variable
 * list, carried by the watch, and substituted in a step argument.
 */
import { describe, expect, it } from 'vitest'
import {
  type AutomationWhen,
  type BecomesEffect,
  BecomesWatch,
  triggerVariablesOf,
} from '../index.js'

const names = (when: AutomationWhen) => triggerVariablesOf(when).map((v) => v.name)

const becomes: AutomationWhen = {
  kind: 'device-becomes',
  deviceId: 5,
  cap: 'switch',
  fieldPath: 'on',
  becomes: true,
}

function watch(spec: ConstructorParameters<typeof BecomesWatch>[0]) {
  const effects: BecomesEffect[] = []
  let now = 0
  const timers: (() => void)[] = []
  const w = new BecomesWatch(spec, {
    timers: {
      set: (fn) => {
        timers.push(fn)
        return setTimeout(() => undefined, 0)
      },
      clear: (handle) => clearTimeout(handle),
      now: () => now,
    },
    read: async () => ({ ok: false }),
    emit: (effect) => effects.push(effect),
  })
  return {
    w,
    effects,
    fires: () => effects.filter((e) => e.kind === 'fire'),
    advance: (ms: number) => {
      now += ms
    },
    runTimers: async () => {
      for (const fn of timers.splice(0)) fn()
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
  }
}

describe('device-becomes variables', () => {
  it('names deviceId, from and to', () => {
    expect(names(becomes)).toEqual(['deviceId', 'from', 'to'])
  })

  it('shares only deviceId with a detection row', () => {
    expect(
      names({
        kind: 'any',
        children: [becomes, { kind: 'detection', deviceIds: [7], subjects: [{ macro: 'person' }] }],
      }),
    ).toEqual(['deviceId'])
  })

  it('a name two kinds describe differently is described for both, the same one keeps its own', () => {
    const detection: AutomationWhen = {
      kind: 'detection',
      deviceIds: [7],
      subjects: [{ macro: 'person' }],
    }
    expect(triggerVariablesOf(becomes)[0]).toMatchObject({ hintKey: 'becomesDeviceId' })
    expect(triggerVariablesOf({ kind: 'any', children: [becomes, detection] })).toEqual([
      {
        name: 'deviceId',
        description: 'the device that started the run',
        hintKey: 'triggerDeviceId',
      },
    ])
    expect(
      triggerVariablesOf({
        kind: 'any',
        children: [detection, { kind: 'stationary', deviceIds: [7], phase: 'appeared' }],
      })[0],
    ).toEqual({ name: 'deviceId', description: 'the camera that saw it' })
  })

  it('a fire carries the value before the change', () => {
    const h = watch({})
    h.w.observe('idle') // seed: not a transition
    h.w.observe('heating')
    h.w.observe('heating') // a re-report: no fire
    h.w.observe('cooling')
    expect(h.fires()).toEqual([
      { kind: 'fire', value: 'heating', from: 'idle' },
      { kind: 'fire', value: 'cooling', from: 'heating' },
    ])
  })

  it('a held fire still names the value before the episode began', async () => {
    const h = watch({ becomes: true, hold: { ms: 1_000, mode: 'held' } })
    h.w.observe(false)
    h.w.observe(true)
    h.w.observe(true) // re-reports during the hold do not move `from`
    h.advance(1_000)
    await h.runTimers()
    expect(h.fires()).toMatchObject([{ kind: 'fire', value: true, from: false }])
  })
})
