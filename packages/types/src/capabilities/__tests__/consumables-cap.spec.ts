/**
 * P2b — consumables as an item-array wiring target. The cap must declare
 * `status.empty` (synthesize seed) and `status.itemArray` (grouping
 * descriptor) and both must be coherent with the runtime schemas:
 *  - `empty` validates against the status schema;
 *  - `itemArray.path` addresses the array field, `keyField` a string field
 *    of the item schema;
 *  - an `emptyItem` seeded with an itemKey (key + label defaulted from the
 *    key, per `labelField`) validates against `ConsumableItemSchema`.
 */
import { describe, it, expect } from 'vitest'
import {
  ConsumableItemSchema,
  ConsumablesStatusSchema,
  consumablesCapability,
} from '../consumables.cap.js'

describe('consumables cap — item-array wiring declaration', () => {
  it('declares status.empty that validates against the status schema', () => {
    const empty = consumablesCapability.status.empty
    expect(empty).toBeDefined()
    expect(ConsumablesStatusSchema.safeParse(empty).success).toBe(true)
  })

  it('declares status.itemArray addressing items by key', () => {
    const itemArray = consumablesCapability.status.itemArray
    expect(itemArray).toBeDefined()
    expect(itemArray.path).toBe('items')
    expect(itemArray.keyField).toBe('key')
    expect(itemArray.labelField).toBe('label')
  })

  it('emptyItem seeded with an itemKey validates against ConsumableItemSchema', () => {
    const { emptyItem, keyField, labelField } = consumablesCapability.status.itemArray
    const seeded = {
      ...emptyItem,
      [keyField]: 'main-brush',
      ...(labelField ? { [labelField]: 'main-brush' } : {}),
    }
    const parsed = ConsumableItemSchema.safeParse(seeded)
    expect(parsed.success).toBe(true)
  })

  it('itemArray.itemSchema is the ConsumableItemSchema', () => {
    expect(consumablesCapability.status.itemArray.itemSchema).toBe(ConsumableItemSchema)
  })
})
