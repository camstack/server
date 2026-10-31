import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ALL_CAPABILITY_DEFINITIONS } from '../../../generated/capability-router-map.js'
import { actionEffect, allVocabActions, vocabActionIdFor } from '../action-index.js'

function statusShape(cap: string): Readonly<Record<string, z.ZodType>> | undefined {
  const def = ALL_CAPABILITY_DEFINITIONS.find((d) => d.name === cap)
  if (def?.status?.schema instanceof z.ZodObject) return def.status.schema.shape
  return def?.runtimeState?.shape
}

describe('the effect catalogue', () => {
  const withEffect = allVocabActions().filter(({ action }) => action.effect !== undefined)

  it('has an effect for the actions that lead to a state, and none where they do not', () => {
    expect(withEffect.length).toBeGreaterThan(40)
    const ids = new Set(withEffect.map(({ action }) => action.id))
    for (const id of [
      'switch.on',
      'cover.open',
      'cover.close',
      'lock.lock',
      'brightness.set',
      'climate.target',
    ]) {
      expect(ids.has(id), id).toBe(true)
    }
    for (const id of ['cover.stop', 'button.press', 'valve.stop', 'alarm.trigger', 'lock.open']) {
      expect(ids.has(id), id).toBe(false)
    }
  })

  it('names, for every effect, a status field its cap declares and a value the field can hold', () => {
    for (const { cap, action } of withEffect) {
      const effect = action.effect
      const field = statusShape(cap)?.[effect?.field ?? '']
      expect(field, `${action.id}: ${cap} has no status field ${effect?.field}`).toBeDefined()
      if (effect !== undefined && 'value' in effect) {
        expect(
          field?.safeParse(effect.value).success,
          `${action.id}: value ${String(effect.value)}`,
        ).toBe(true)
      }
    }
  })

  it('action ids are unique across caps', () => {
    const all = allVocabActions().map(({ action }) => action.id)
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('actionEffect', () => {
  it('a literal effect resolves to cap, field and value', () => {
    expect(actionEffect('cover.open', {})).toEqual({
      cap: 'cover',
      field: 'state',
      value: 'open',
    })
    expect(actionEffect('switch.off', undefined)).toEqual({
      cap: 'switch',
      field: 'on',
      value: false,
    })
  })

  it('an effect that copies an arg reads it, and is null while the arg is missing', () => {
    expect(actionEffect('brightness.set', { level: 35 })).toEqual({
      cap: 'brightness',
      field: 'level',
      value: 35,
    })
    expect(actionEffect('humidifier.target', { humidity: 55 })).toEqual({
      cap: 'humidifier',
      field: 'targetHumidity',
      value: 55,
    })
    expect(actionEffect('brightness.set', {})).toBeNull()
  })

  it('an action with no effect, or an unknown one, is null', () => {
    expect(actionEffect('cover.stop', {})).toBeNull()
    expect(actionEffect('button.press', {})).toBeNull()
    expect(actionEffect('nope.nope', {})).toBeNull()
  })
})

describe('vocabActionIdFor', () => {
  it('tells a baked-arg action from a free one, and prefers the most specific', () => {
    expect(vocabActionIdFor('climate-control', 'setMode', { mode: 'heat' })).toBe('climate.heat')
    expect(vocabActionIdFor('climate-control', 'setMode', { mode: 'dry' })).toBe('climate.mode')
    expect(vocabActionIdFor('cover', 'open', undefined)).toBe('cover.open')
  })
})
