import { DeviceType, type SavedDevice } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { findParentRow, planChildConfigHeal } from '../child-config-heal.js'

const HUB_CONFIG = {
  host: '192.168.10.161',
  port: 9000,
  username: 'admin',
  password: 'hunter2xy',
  transport: 'tcp',
  channelCount: 8,
}

const row = (over: Partial<SavedDevice> & Pick<SavedDevice, 'id' | 'stableId'>): SavedDevice => ({
  type: DeviceType.Camera,
  name: 'cam',
  location: null,
  disabled: false,
  parentDeviceId: null,
  config: {},
  ...over,
})

describe('planChildConfigHeal', () => {
  /**
   * The live case (2026-09-04): an Argus MagiCam under a Reolink Home Hub carried an
   * EMPTY blob and burned all four bounded restore attempts on `host`/`password` —
   * fields a hub-adopted child never dials, because it uses `parent.api`.
   */
  it('re-inherits every connection field an emptied child blob lost', () => {
    const { patch, missingKeys } = planChildConfigHeal({}, HUB_CONFIG)
    expect(patch).toEqual({
      host: '192.168.10.161',
      port: 9000,
      username: 'admin',
      password: 'hunter2xy',
      transport: 'tcp',
    })
    expect(new Set(missingKeys)).toEqual(
      new Set(['host', 'password', 'port', 'transport', 'username']),
    )
  })

  it('never overwrites a child that deliberately differs from its parent', () => {
    const child = {
      host: '192.168.10.200',
      port: 9001,
      username: 'child',
      password: 'own',
      transport: 'udp',
    }
    const { patch, missingKeys } = planChildConfigHeal(child, HUB_CONFIG)
    expect(patch).toEqual({})
    expect(missingKeys).toEqual([])
  })

  it('fills only the absent fields, leaving the present ones alone', () => {
    const { patch, missingKeys } = planChildConfigHeal({ host: '192.168.10.200' }, HUB_CONFIG)
    expect(patch).not.toHaveProperty('host')
    expect(patch).toMatchObject({ password: 'hunter2xy', port: 9000 })
    expect(missingKeys).not.toContain('host')
  })

  it('treats an empty string as absent — it is what a dropped field leaves behind', () => {
    const { missingKeys } = planChildConfigHeal({ host: '', password: '' }, HUB_CONFIG)
    expect([...missingKeys]).toContain('host')
    expect([...missingKeys]).toContain('password')
  })

  it('cannot invent a field the parent does not have either', () => {
    const { patch } = planChildConfigHeal({}, { host: '10.0.0.1' })
    expect(patch).toEqual({ host: '10.0.0.1' })
  })
})

describe('findParentRow', () => {
  const hub = row({
    id: 639,
    stableId: 'mac-ec71db72bbfe',
    type: DeviceType.Hub,
    config: HUB_CONFIG,
  })
  const child = row({
    id: 3825,
    stableId: 'mac-ec71db72bbfe-cam-9527000MSU931AUT',
    parentDeviceId: 639,
  })

  it('resolves a child to the row it names as parent', () => {
    expect(findParentRow(child, [hub, child])?.id).toBe(639)
  })

  it('returns nothing for a top-level device — it has nothing to inherit', () => {
    expect(findParentRow(hub, [hub, child])).toBeUndefined()
  })

  it('returns nothing when the named parent is absent from the set', () => {
    expect(findParentRow(child, [child])).toBeUndefined()
  })
})
