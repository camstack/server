import { describe, expect, it } from 'vitest'
import {
  kebabToCamel,
  objectInputDeclaresRequiredDeviceId,
} from '../../../capabilities/cap-router-predicates.js'
import { resolveMethodAuth } from '../../../capabilities/cap-router-predicates.js'
import { ALL_CAPABILITY_DEFINITIONS } from '../../../generated/capability-router-map.js'
import { METHOD_ACCESS_MAP } from '../../../generated/method-access-map.js'
import { actionEffect, allVocabActions } from '../action-index.js'
import {
  auditedFields,
  commandEffect,
  commandEffects,
  commandHoldMs,
  isCommand,
} from '../command-catalog.js'
import { ONE_SHOT_HOLD_MS } from '../hold-limits.js'
import { CAP_VOCABULARY_BY_NAME } from '../vocabulary.js'

describe('the command catalogue', () => {
  it('names a vocabulary action as a command, and a read or an unknown method as none', () => {
    expect(isCommand('switch', 'setState')).toBe(true)
    expect(isCommand('switch', 'getState')).toBe(false)
    expect(isCommand('no-such-cap', 'setState')).toBe(false)
  })

  it('resolves the effect of a literal action and of an argument-carried one', () => {
    expect(commandEffect('switch', 'setState', { on: true })).toEqual({ field: 'on', value: true })
    expect(commandEffect('switch', 'setState', { on: false })).toEqual({
      field: 'on',
      value: false,
    })
    expect(commandEffect('brightness', 'setBrightness', { level: 30 })).toEqual({
      field: 'level',
      value: 30,
    })
  })

  it('has no effect for a command that leads to no state (stop) and for a missing argument', () => {
    expect(commandEffect('cover', 'stop', {})).toBeNull()
    expect(commandEffect('brightness', 'setBrightness', {})).toBeNull()
  })

  it('lists a side effect only while its condition holds on the current slice (D1061)', () => {
    // A purifier in Auto: a speed set also leaves the preset.
    expect(
      commandEffects('fan-control', 'setPercentage', { speed: 40 }, { speed: 20, preset: 'auto' }),
    ).toEqual([
      { field: 'speed', value: 40, tolerance: 1 },
      { field: 'preset', value: '' },
    ])
    // Already manual: the speed alone.
    expect(
      commandEffects('fan-control', 'setPercentage', { speed: 40 }, { speed: 20, preset: '' }),
    ).toEqual([{ field: 'speed', value: 40, tolerance: 1 }])
    expect(commandEffects('fan-control', 'setPreset', { preset: 'sleep' }, undefined)).toEqual([
      { field: 'preset', value: 'sleep' },
    ])
    expect(commandEffects('cover', 'stop', {}, undefined)).toEqual([])
  })

  it('lends a copied number the step of its arg as the tolerance (D1061)', () => {
    expect(commandEffects('brightness', 'setBrightness', { level: 37 }, undefined)).toEqual([
      { field: 'level', value: 37, tolerance: 1 },
    ])
    expect(commandEffects('climate-control', 'setTarget', { target: 21.5 }, undefined)).toEqual([
      { field: 'target', value: 21.5, tolerance: 0.5 },
    ])
    // A literal value names no arg, and so no tolerance.
    expect(commandEffects('brightness', 'setBrightness', { level: 0 }, undefined)).toEqual([
      { field: 'level', value: 0 },
    ])
  })

  it('a toggle leads to the opposite of what the person saw, held values included', () => {
    expect(commandEffects('switch', 'toggle', {}, { on: false })).toEqual([
      { field: 'on', value: true },
    ])
    // The device still reports off, the person sees the held on: a second toggle turns it off.
    expect(commandEffects('switch', 'toggle', {}, { on: false }, { on: true })).toEqual([
      { field: 'on', value: false },
    ])
    expect(commandEffects('switch', 'toggle', {}, undefined)).toEqual([])
  })

  it.each([
    ['media-player', 'setMute', { muted: true }, { field: 'isMuted', value: true }],
    ['media-player', 'setRepeat', { repeat: 'all' }, { field: 'repeat', value: 'all' }],
    ['media-player', 'play', {}, { field: 'state', value: 'playing' }],
    ['media-player', 'pause', {}, { field: 'state', value: 'paused' }],
    [
      'media-player',
      'setVolume',
      { volumeLevel: 40 },
      { field: 'volumeLevel', value: 40, tolerance: 1 },
    ],
    ['pet-feeder', 'setChildLock', { on: true }, { field: 'childLock', value: true }],
    ['pet-feeder', 'setFeedSound', { on: false }, { field: 'feedSound', value: false }],
    ['pet-feeder', 'setIndicatorLight', { on: true }, { field: 'indicatorLight', value: true }],
    ['pet-feeder', 'setVolume', { level: 3 }, { field: 'volume', value: 3, tolerance: 1 }],
    ['pet-fountain', 'setPump', { on: true }, { field: 'pumpRunning', value: true }],
    ['pump-cycle', 'setEnabled', { on: false }, { field: 'enabled', value: false }],
    ['script-runner', 'stop', {}, { field: 'isRunning', value: false }],
    ['automation-control', 'enable', {}, { field: 'enabled', value: true }],
    ['automation-control', 'disable', {}, { field: 'enabled', value: false }],
  ])('%s.%s leads to its state (D1061)', (cap, method, args, effect) => {
    expect(commandEffects(cap, method, args, undefined)).toEqual([effect])
  })

  it('audits the fields an action effect names and the boolean state fields', () => {
    expect(auditedFields('switch').has('on')).toBe(true)
    expect(auditedFields('brightness').has('level')).toBe(true)
    expect(auditedFields('temperature-sensor').size).toBe(0)
    expect(auditedFields('no-such-cap').size).toBe(0)
  })

  it('knows every vocabulary action as a command', () => {
    for (const { cap, action } of allVocabActions()) {
      expect(isCommand(cap, action.method), `${cap}.${action.method}`).toBe(true)
    }
  })

  it('every operate mutation with a required deviceId is in the catalogue or excused', () => {
    const missing: string[] = []
    for (const def of ALL_CAPABILITY_DEFINITIONS) {
      if (def.scope !== 'device') continue
      const entry = CAP_VOCABULARY_BY_NAME[def.name]
      const excuses =
        entry !== undefined && typeof entry.notOperatorFacing === 'object'
          ? entry.notOperatorFacing
          : {}
      for (const [name, method] of Object.entries(def.methods)) {
        if (method.kind !== 'mutation') continue
        if (!objectInputDeclaresRequiredDeviceId(method.input)) continue
        if (METHOD_ACCESS_MAP[`${kebabToCamel(def.name)}.${name}`]?.access === 'view') continue
        if (resolveMethodAuth(def, method) === 'admin') continue
        if (isCommand(def.name, name)) continue
        if (typeof excuses[name] === 'string' && excuses[name].length > 0) continue
        missing.push(`${def.name}.${name}`)
      }
    }
    expect(missing).toEqual([])
  })
})

describe('an action that declares how it is held (D1061)', () => {
  it('holds a lock as locking / unlocking, never as the final state', () => {
    expect(commandEffects('lock-control', 'lock', {}, { state: 'unlocked' })).toEqual([
      { field: 'state', value: 'locking' },
    ])
    expect(commandEffects('lock-control', 'unlock', {}, { state: 'locked' })).toEqual([
      { field: 'state', value: 'unlocking' },
    ])
  })

  it('holds nothing when the lock is already where it was told to go', () => {
    expect(commandEffects('lock-control', 'lock', {}, { state: 'locked' })).toEqual([])
    expect(commandEffects('lock-control', 'unlock', {}, { state: 'unlocked' })).toEqual([])
  })

  it('holds an alarm panel as arming / disarming', () => {
    expect(commandEffects('alarm-panel', 'arm', { mode: 'away' }, { state: 'disarmed' })).toEqual([
      { field: 'state', value: 'arming' },
    ])
    expect(commandEffects('alarm-panel', 'disarm', {}, { state: 'armed_home' })).toEqual([
      { field: 'state', value: 'disarming' },
    ])
  })

  it('holds a one-shot as in progress, for the short limit it declares', () => {
    expect(commandEffects('pet-feeder', 'feed', { grams: 10 }, { feeding: false })).toEqual([
      { field: 'feeding', value: true },
    ])
    expect(commandHoldMs('pet-feeder', 'feed', { grams: 10 })).toBe(ONE_SHOT_HOLD_MS)
    expect(commandEffects('script-runner', 'run', {}, { isRunning: false })).toEqual([
      { field: 'isRunning', value: true },
    ])
    expect(commandHoldMs('script-runner', 'run', {})).toBe(ONE_SHOT_HOLD_MS)
    expect(commandHoldMs('switch', 'setState', { on: true })).toBeUndefined()
  })
})

describe('an effect whose arg is in another unit (D1061)', () => {
  it('holds a pump run time set in minutes as the seconds the slice reports', () => {
    expect(commandEffects('pump-cycle', 'setOnMinutes', { minutes: 2 }, undefined)).toEqual([
      { field: 'onTime', value: 120, tolerance: 60 },
    ])
    expect(commandEffects('pump-cycle', 'setOffMinutes', { minutes: 15 }, undefined)).toEqual([
      { field: 'offTime', value: 900, tolerance: 60 },
    ])
  })

  it('the action leads to the same scaled state', () => {
    expect(actionEffect('pumpCycle.onMinutes', { minutes: 3 })).toEqual({
      cap: 'pump-cycle',
      field: 'onTime',
      value: 180,
    })
  })
})
