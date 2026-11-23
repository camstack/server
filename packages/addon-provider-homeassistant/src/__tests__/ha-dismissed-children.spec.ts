import { describe, expect, it } from 'vitest'
import {
  childDeviceIdsByEntity,
  dismissDeletedChildren,
  withoutDismissed,
} from '../ha-dismissed-children.js'

const ENTITIES = [{ entityId: 'light.desk' }, { entityId: 'sensor.desk_power' }]

describe('a container child the operator deleted stays deleted', () => {
  it('maps live children to their entity through the parent stableId prefix', () => {
    expect(
      childDeviceIdsByEntity('ha:b:dev:d1', [
        { id: 3403, stableId: 'ha:b:dev:d1-light.desk' },
        { id: 9, stableId: 'ha:b:dev:other-light.x' },
      ]),
    ).toEqual({ 'light.desk': 3403 })
  })

  it('dismisses the entity whose child id is tombstoned and keeps the rest', () => {
    const result = dismissDeletedChildren(
      {
        entities: ENTITIES,
        childDeviceIds: { 'light.desk': 3403, 'sensor.desk_power': 3404 },
        dismissedEntityIds: [],
      },
      new Set([3403]),
    )
    expect(result?.dismissed).toEqual(['light.desk'])
    expect(result?.entities).toEqual([{ entityId: 'sensor.desk_power' }])
    expect(result?.dismissedEntityIds).toEqual(['light.desk'])
    expect(result?.childDeviceIds).toEqual({ 'sensor.desk_power': 3404 })
  })

  it('writes nothing when no recorded child was deleted', () => {
    expect(
      dismissDeletedChildren(
        { entities: ENTITIES, childDeviceIds: { 'light.desk': 3403 }, dismissedEntityIds: [] },
        new Set([77]),
      ),
    ).toBeNull()
  })

  it('a sync never brings a dismissed entity back', () => {
    expect(withoutDismissed(ENTITIES, ['light.desk'])).toEqual([{ entityId: 'sensor.desk_power' }])
    expect(withoutDismissed(ENTITIES, [])).toEqual(ENTITIES)
  })
})
