import { describe, it, expect } from 'vitest'
import {
  EventCategory,
  isOwnerOnlyEventCategory,
  OWNER_ONLY_EVENT_CATEGORIES,
  publicEventCategories,
} from '../event-category.js'

describe('EventCategory', () => {
  it('exposes DeviceReady with the canonical wire value', () => {
    expect(EventCategory.DeviceReady).toBe('device.ready')
  })
})

describe('owner-only categories (D224, D663)', () => {
  it('the native shadow is owner-only; the public state change is not', () => {
    expect(isOwnerOnlyEventCategory(EventCategory.DeviceNativeShadowChanged)).toBe(true)
    expect(isOwnerOnlyEventCategory(EventCategory.DeviceStateChanged)).toBe(false)
  })

  it('every owner-only category is a real enum value', () => {
    const values = new Set<string>(Object.values(EventCategory))
    for (const c of OWNER_ONLY_EVENT_CATEGORIES) expect(values.has(c)).toBe(true)
  })

  it('publicEventCategories() is the enum minus the owner-only set, unique and sorted — what a picker may offer', () => {
    const pub = publicEventCategories()
    expect(pub).not.toContain(EventCategory.DeviceNativeShadowChanged)
    expect(pub).toContain(EventCategory.DeviceStateChanged)
    expect(pub).toEqual([...pub].sort())
    expect(new Set(pub).size).toBe(pub.length)
    const values = new Set<string>(Object.values(EventCategory))
    expect(pub.length).toBe(values.size - OWNER_ONLY_EVENT_CATEGORIES.size)
  })
})
