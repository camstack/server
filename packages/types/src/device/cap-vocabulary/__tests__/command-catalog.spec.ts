import { describe, expect, it } from 'vitest'
import {
  kebabToCamel,
  objectInputDeclaresRequiredDeviceId,
} from '../../../capabilities/cap-router-predicates.js'
import { resolveMethodAuth } from '../../../capabilities/cap-router-predicates.js'
import { ALL_CAPABILITY_DEFINITIONS } from '../../../generated/capability-router-map.js'
import { METHOD_ACCESS_MAP } from '../../../generated/method-access-map.js'
import { allVocabActions } from '../action-index.js'
import { auditedFields, commandEffect, isCommand } from '../command-catalog.js'
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
