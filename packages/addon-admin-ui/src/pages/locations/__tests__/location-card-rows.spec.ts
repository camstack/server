/**
 * The row model behind the room card's table: members in order, and an
 * accessory row only under a member the operator opened.
 */
import { describe, expect, it } from 'vitest'
import { buildLocationCardRows, locationCardRowKey } from '../location-card-rows'
import type { SiteDevice } from '../site-locations'

const dev = (over: Partial<SiteDevice> & Pick<SiteDevice, 'id' | 'name'>): SiteDevice => ({
  type: 'sensor',
  isCamera: false,
  online: true,
  location: 'Front door',
  parentDeviceId: null,
  role: null,
  ...over,
})

const CONTACT = dev({ id: 4127, name: 'Contatto porta', type: 'container' })
const BATTERY = dev({ id: 4128, name: 'Batteria', parentDeviceId: 4127 })
const TAMPER = dev({ id: 4129, name: 'Manomissione', parentDeviceId: 4127 })
const CAMERA = dev({ id: 104, name: 'Camera', type: 'camera', isCamera: true })
// A child CAMERA is not an accessory of the card (mirrors `linkedChildren`).
const CHILD_CAM = dev({
  id: 591,
  name: 'Camera figlia',
  type: 'camera',
  isCamera: true,
  parentDeviceId: 104,
})
const FLEET = [CONTACT, BATTERY, TAMPER, CAMERA, CHILD_CAM]

const shape = (rows: ReturnType<typeof buildLocationCardRows>) =>
  rows.map((r) => `${r.kind}:${r.device.name}`)

describe('buildLocationCardRows', () => {
  it('closed: one row per member, in the incoming order, accessories counted not drawn', () => {
    const rows = buildLocationCardRows([CONTACT, CAMERA], FLEET, new Set())
    expect(shape(rows)).toEqual(['member:Contatto porta', 'member:Camera'])
    const head = rows[0]
    expect(head?.kind === 'member' && head.accessories.length).toBe(2)
    expect(head?.kind === 'member' && head.open).toBe(false)
  })

  it('open: the accessories follow their member, and only that member', () => {
    const rows = buildLocationCardRows([CONTACT, CAMERA], FLEET, new Set([4127]))
    expect(shape(rows)).toEqual([
      'member:Contatto porta',
      'accessory:Batteria',
      'accessory:Manomissione',
      'member:Camera',
    ])
    const battery = rows[1]
    expect(battery?.kind === 'accessory' && battery.parent.id).toBe(4127)
  })

  it('an open member with no accessories stays one row — a child camera is not an accessory', () => {
    expect(shape(buildLocationCardRows([CAMERA], FLEET, new Set([104])))).toEqual(['member:Camera'])
  })

  it('row keys never collide between a member and an accessory with the same id space', () => {
    const rows = buildLocationCardRows([CONTACT], FLEET, new Set([4127]))
    const keys = rows.map(locationCardRowKey)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys[0]).toBe('member:4127')
  })
})
