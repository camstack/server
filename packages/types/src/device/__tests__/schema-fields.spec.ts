import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { enumerateItemArrayFields, enumerateSchemaFields } from '../schema-fields.js'

const Tank = z.object({
  level: z.number().nullable(),
  status: z.enum(['ok', 'low', 'full']).nullable(),
})
const Vacuum = z.object({
  state: z.string(),
  batteryLevel: z.number().nullable(),
  cleanWater: Tank.nullable(),
  fanSpeed: z.string().optional(),
})

describe('enumerateSchemaFields', () => {
  it('flattens nested/nullable/optional into dotted leaf paths with kinds', () => {
    const fields = enumerateSchemaFields(Vacuum)
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f]))
    expect(byPath['state']?.kind).toBe('string')
    expect(byPath['batteryLevel']?.kind).toBe('number')
    expect(byPath['cleanWater.level']?.kind).toBe('number')
    expect(byPath['cleanWater.status']?.kind).toBe('enum')
    expect(byPath['cleanWater.status']?.enumValues).toEqual(['ok', 'low', 'full'])
    expect(byPath['fanSpeed']?.kind).toBe('string')
  })
  it('returns [] for a non-object schema', () => {
    expect(enumerateSchemaFields(z.string())).toEqual([])
  })
  it('handles a boolean leaf', () => {
    const fields = enumerateSchemaFields(z.object({ charging: z.boolean() }))
    expect(fields[0]).toMatchObject({ path: 'charging', kind: 'boolean' })
  })
})

describe('enumerateItemArrayFields', () => {
  const Item = z.object({
    key: z.string().min(1),
    label: z.string().min(1),
    level: z.number().min(0).max(100).nullable(),
    status: z.enum(['ok', 'replace']).nullable(),
    resettable: z.boolean(),
  })

  it('emits per-item leaf fields tagged item:true, excluding the keyField', () => {
    const fields = enumerateItemArrayFields({ keyField: 'key', itemSchema: Item })
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f]))
    expect(byPath['key']).toBeUndefined()
    expect(byPath['label']).toMatchObject({ path: 'label', kind: 'string', item: true })
    expect(byPath['level']).toMatchObject({ path: 'level', kind: 'number', item: true })
    expect(byPath['status']).toMatchObject({ path: 'status', kind: 'enum', item: true })
    expect([...(byPath['status']!.enumValues ?? [])]).toEqual(['ok', 'replace'])
    expect(byPath['resettable']).toMatchObject({ path: 'resettable', kind: 'boolean', item: true })
  })

  it('returns [] when the item schema is not an object', () => {
    expect(enumerateItemArrayFields({ keyField: 'key', itemSchema: z.string() })).toEqual([])
  })
})
