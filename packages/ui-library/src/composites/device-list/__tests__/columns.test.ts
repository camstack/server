import { describe, it, expect } from 'vitest'
import {
  DEVICE_COLUMNS,
  columnsForContext,
  COLUMN_PRIORITY,
  COLUMN_BREAKPOINT_CLASS,
} from '../columns'

describe('columnsForContext', () => {
  it('devices context shows name + icon + type + manufacturer + features + previewActions', () => {
    const cols = columnsForContext('devices')
    expect(cols).toEqual(['name', 'icon', 'type', 'manufacturer', 'features', 'previewActions'])
  })

  it('integration-detail hides icon + type but keeps manufacturer', () => {
    expect(columnsForContext('integration-detail')).toEqual([
      'name',
      'manufacturer',
      'features',
      'previewActions',
    ])
  })

  it('manufacturer is enabled in BOTH device-table contexts (all 3 target screens)', () => {
    expect(columnsForContext('devices')).toContain('manufacturer')
    expect(columnsForContext('integration-detail')).toContain('manufacturer')
  })

  it('every catalog id has a responsive priority', () => {
    for (const id of DEVICE_COLUMNS) {
      expect(COLUMN_PRIORITY[id]).toBeTypeOf('number')
    }
  })

  it('name always has priority 0 (sticky, never dropped)', () => {
    expect(COLUMN_PRIORITY.name).toBe(0)
  })

  it('manufacturer is wide-screen-only: highest priority number + xl breakpoint', () => {
    // Drops FIRST as width shrinks (highest priority number among all columns).
    for (const id of DEVICE_COLUMNS) {
      if (id === 'manufacturer') continue
      expect(COLUMN_PRIORITY.manufacturer).toBeGreaterThan(COLUMN_PRIORITY[id])
    }
    expect(COLUMN_BREAKPOINT_CLASS.manufacturer).toBe('hidden xl:table-cell')
  })
})

describe('COLUMN_PRIORITY convention (lower number = kept longer)', () => {
  it('previewActions outranks both optional columns', () => {
    expect(COLUMN_PRIORITY.previewActions).toBeLessThan(COLUMN_PRIORITY.features)
    expect(COLUMN_PRIORITY.previewActions).toBeLessThan(COLUMN_PRIORITY.type)
  })

  it('optional columns drop manufacturer → type → features (manufacturer > type > features)', () => {
    // `manufacturer` is now the LEAST important optional column (highest number
    // → drops first), then `type`, then `features` survives longest.
    expect(COLUMN_PRIORITY.manufacturer).toBeGreaterThan(COLUMN_PRIORITY.type)
    expect(COLUMN_PRIORITY.type).toBeGreaterThan(COLUMN_PRIORITY.features)
  })
})

describe('COLUMN_BREAKPOINT_CLASS (priority-derived, single th/td source)', () => {
  it('name + previewActions carry no hide class (always visible)', () => {
    expect(COLUMN_BREAKPOINT_CLASS.name).toBe('')
    expect(COLUMN_BREAKPOINT_CLASS.previewActions).toBe('')
  })

  it('icon has no standalone cell breakpoint (rendered inside the name cell)', () => {
    expect(COLUMN_BREAKPOINT_CLASS.icon).toBe('')
  })

  it('features is kept longer than type (hidden below md vs below lg)', () => {
    expect(COLUMN_BREAKPOINT_CLASS.features).toBe('hidden md:table-cell')
    expect(COLUMN_BREAKPOINT_CLASS.type).toBe('hidden lg:table-cell')
  })

  it('breakpoint width order matches the priority order (type drops before features)', () => {
    // The more-important optional column (lower priority number) must survive to
    // a NARROWER breakpoint than the less-important one. `features` (md) is
    // narrower than `type` (lg), so `type` disappears first as width shrinks.
    const widthRank: Record<string, number> = {
      '': 0,
      'hidden md:table-cell': 2,
      'hidden lg:table-cell': 3,
    }
    expect(widthRank[COLUMN_BREAKPOINT_CLASS.type]).toBeGreaterThan(
      widthRank[COLUMN_BREAKPOINT_CLASS.features] ?? 0,
    )
    expect(COLUMN_PRIORITY.type).toBeGreaterThan(COLUMN_PRIORITY.features)
  })
})
