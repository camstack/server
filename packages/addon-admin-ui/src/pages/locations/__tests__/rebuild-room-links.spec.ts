/**
 * What the per-room link rebuild would write.
 *
 * The fixtures are the shapes measured on the live fleet 2026-09-24: the
 * Hall holds a Homematic `container` whose children are one `cover` plus
 * six auxiliaries (buttons, two signal readings, duty cycle, temperature,
 * firmware). That is the case the rule exists for — contributing all seven
 * gave the operator a dozen rows for one appliance, none of which WAS the
 * appliance.
 */
import { describe, expect, it } from 'vitest'
import { linkedDevicesSlotWrite, planRoomLinkRebuild } from '../rebuild-room-links'
import type { SiteDevice } from '../site-locations'

function dev(p: Partial<SiteDevice> & { id: number; type: string }): SiteDevice {
  return {
    name: `d${p.id}`,
    location: 'Hall',
    isCamera: false,
    parentDeviceId: null,
    online: true,
    stableId: `s${p.id}`,
    ...p,
  }
}

const CAMERA = dev({ id: 104, type: 'camera', isCamera: true, name: 'Camera hall' })
const CONTAINER = dev({ id: 1452, type: 'container', name: 'Tapparella hall' })
const COVER = dev({ id: 4595, type: 'cover', parentDeviceId: 1452, name: 'Tapparella hall' })
const AUX = [
  dev({ id: 4596, type: 'event-emitter', parentDeviceId: 1452, name: 'Buttons' }),
  dev({ id: 4597, type: 'sensor', parentDeviceId: 1452, name: 'Signal (device)' }),
  dev({ id: 4600, type: 'sensor', parentDeviceId: 1452, name: 'Temperature' }),
]
const LIGHT = dev({ id: 3519, type: 'switch', name: 'Faretti hall 1' })
const ELSEWHERE = dev({ id: 9000, type: 'switch', location: 'Kitchen', name: 'Luce kitchen' })

const FLEET = [CAMERA, CONTAINER, COVER, ...AUX, LIGHT, ELSEWHERE]

describe('planRoomLinkRebuild', () => {
  it('links the room, and only the room', () => {
    const { entries } = planRoomLinkRebuild('Hall', FLEET)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.deviceId).toBe(104)
    expect(entries[0]?.ids).toContain(3519)
    expect(entries[0]?.ids).not.toContain(9000)
  })

  it('stands a container up as ONE child, never as seven', () => {
    // The whole point of the rule. `4595` is the cover; the buttons, the
    // signal readings and the temperature are not the appliance.
    const ids = planRoomLinkRebuild('Hall', FLEET).entries[0]?.ids ?? []
    expect(ids).toContain(4595)
    for (const aux of AUX) expect(ids).not.toContain(aux.id)
    // And never the container itself — a container is not a thing to operate.
    expect(ids).not.toContain(1452)
  })

  it('never links the camera to itself', () => {
    expect(planRoomLinkRebuild('Hall', FLEET).entries[0]?.ids).not.toContain(104)
  })

  it('never reaches a camera that has no room', () => {
    // Measured live: `Camera sala da pranzo` has `location: null`, and an
    // empty resolve written as an empty list would cost it every link it has
    // (D391's silent drop). The protection is that a null location matches no
    // room NAME — so the plan must be empty for every room, including the
    // degenerate ones a caller could pass.
    const roomless = dev({ id: 111, type: 'camera', isCamera: true, location: null })
    const fleet = [...FLEET, roomless]
    for (const room of ['Hall', 'Kitchen', '', 'null', 'undefined']) {
      expect(planRoomLinkRebuild(room, fleet).entries.map((e) => e.deviceId)).not.toContain(111)
    }
  })

  it('answers nothing for a room with no camera', () => {
    expect(planRoomLinkRebuild('Kitchen', FLEET).entries).toHaveLength(0)
  })
})

describe('the rebuild writes through the linked-devices slot (D655)', () => {
  it('one setSlot per camera, routed to the device manager, the picks only', () => {
    expect(linkedDevicesSlotWrite({ deviceId: 104, name: 'Hall', ids: [4595, 12] })).toEqual({
      deviceId: 104,
      slotRef: 'device-manager:linked-devices',
      // No `trackedDeviceIds`: absent leaves the tracked-event opt-in untouched.
      value: { slot: 'linked-devices', deviceIds: [4595, 12] },
    })
  })
})
