/**
 * The API explorer's schema → input-control mapping (planning#595): which
 * control each field of a method's JSON Schema gets, and the values the form
 * starts from.
 */
import { describe, expect, it } from 'vitest'
import { formSeed, inputFieldsOf, withField } from '../api-input-fields'

const SCHEMA = {
  type: 'object',
  properties: {
    deviceId: { type: 'integer', minimum: 1 },
    targetDeviceIds: { type: 'array', items: { type: 'integer' } },
    mode: { type: 'string', enum: ['on', 'off'] },
    level: { type: 'integer', minimum: 0, maximum: 100, default: 50 },
    enabled: { type: 'boolean', default: true },
    note: { type: ['string', 'null'] },
    kind: { anyOf: [{ const: 'a' }, { const: 'b' }] },
    maybeLimit: { anyOf: [{ type: 'number', minimum: 1 }, { type: 'null' }] },
    filter: { $ref: '#/$defs/Filter' },
    pair: { type: 'object', properties: { x: { type: 'number' } } },
  },
  required: ['deviceId', 'mode'],
  $defs: { Filter: { type: 'string', enum: ['x', 'y'] } },
}

function field(key: string) {
  const found = inputFieldsOf(SCHEMA)?.find((f) => f.key === key)
  if (found === undefined) throw new Error(`no field ${key}`)
  return found
}

describe('inputFieldsOf', () => {
  it('is null for a schema that is not an object with properties', () => {
    expect(inputFieldsOf(null)).toBeNull()
    expect(inputFieldsOf({ type: 'integer' })).toBeNull()
    expect(inputFieldsOf({ type: 'object' })).toBeNull()
  })

  it('maps a deviceId field to the device picker and a deviceIds array to the list picker', () => {
    expect(field('deviceId').control).toEqual({ type: 'device' })
    expect(field('targetDeviceIds').control).toEqual({ type: 'deviceList' })
  })

  it('maps enums and const unions to a select, resolving $ref', () => {
    expect(field('mode').control).toEqual({ type: 'select', options: ['on', 'off'] })
    expect(field('kind').control).toEqual({ type: 'select', options: ['a', 'b'] })
    expect(field('filter').control).toEqual({ type: 'select', options: ['x', 'y'] })
  })

  it('maps numbers to a bounded number input, unwrapping a nullable branch', () => {
    expect(field('level').control).toEqual({ type: 'number', integer: true, min: 0, max: 100 })
    expect(field('maybeLimit').control).toEqual({ type: 'number', integer: false, min: 1 })
  })

  it('maps booleans to a switch, strings to text and anything else to JSON', () => {
    expect(field('enabled').control).toEqual({ type: 'switch' })
    expect(field('note').control).toEqual({ type: 'text' })
    expect(field('pair').control).toEqual({ type: 'json' })
  })

  it('carries required and default', () => {
    expect(field('deviceId').required).toBe(true)
    expect(field('level')).toMatchObject({ required: false, defaultValue: 50 })
  })
})

describe('formSeed', () => {
  it('fills required fields and pre-fills the defaults of optional ones', () => {
    expect(formSeed(SCHEMA)).toEqual({ deviceId: 1, mode: 'on', level: 50, enabled: true })
  })

  it('is undefined without a schema', () => {
    expect(formSeed(null)).toBeUndefined()
  })
})

describe('withField', () => {
  it('sets a value without mutating and removes the key for undefined', () => {
    const base = { a: 1, b: 2 }
    expect(withField(base, 'a', 5)).toEqual({ a: 5, b: 2 })
    expect(withField(base, 'b', undefined)).toEqual({ a: 1 })
    expect(base).toEqual({ a: 1, b: 2 })
  })
})
