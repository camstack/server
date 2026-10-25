/**
 * Same-location suggestions on the Customize cards (D749): the room's devices
 * that are VALID for the card come first, a container contributes only the
 * child it stands for, and nothing is ever assigned on its own.
 */
import { compositionSourceKey } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { type CandidateDevice, sourceCandidates } from '../assignment-candidates'
import {
  roomSuggestionsOf,
  splitByRoom,
  suggestedCount,
  suggestionContainer,
} from '../room-suggestions'

const device = (
  over: Partial<CandidateDevice> & { id: number; name: string },
): CandidateDevice => ({
  addonId: 'provider-homeassistant',
  stableId: `ha:${over.id}`,
  type: 'sensor',
  location: 'Hall',
  isCamera: false,
  integration: 'Home Assistant',
  parentDeviceId: null,
  primaryChildEntityId: null,
  role: null,
  ...over,
})

const HOST = device({ id: 104, name: 'Camera hall', type: 'camera', isCamera: true })
const PIR = device({ id: 1, name: 'PIR hall' })
const LIGHT = device({ id: 2, name: 'Lampada hall', type: 'light' })
const ASSIGNED = device({ id: 3, name: 'Contatto finestra' })
const KITCHEN = device({ id: 4, name: 'PIR kitchen', location: 'Kitchen' })
// A door sensor container: its primary is the contact (role beats type); the
// battery reading is a motion-capable sibling only to prove it is NOT suggested.
const DOOR = device({ id: 10, name: 'Porta hall', type: 'container' })
const DOOR_CONTACT = device({
  id: 11,
  name: 'Contatto porta',
  parentDeviceId: 10,
  role: 'contact-sensor',
})
const DOOR_BATTERY = device({
  id: 12,
  name: 'Batteria porta',
  parentDeviceId: 10,
  role: 'battery-sensor',
})
// A container whose automatic primary (a light) is not valid for a sensor card.
const LAMP = device({ id: 20, name: 'Lampada terrazzo', type: 'container' })
const LAMP_LIGHT = device({ id: 21, name: 'Luce', type: 'light', parentDeviceId: 20 })
const LAMP_MOTION = device({ id: 22, name: 'Movimento', parentDeviceId: 20 })
// A container with no child.
const EMPTY = device({ id: 30, name: 'Gruppo vuoto', type: 'container' })

const FLEET = [
  HOST,
  PIR,
  LIGHT,
  ASSIGNED,
  KITCHEN,
  DOOR,
  DOOR_CONTACT,
  DOOR_BATTERY,
  LAMP,
  LAMP_LIGHT,
  LAMP_MOTION,
  EMPTY,
]

// Which source caps each device carries (the card's compatibility filter).
const CAP_INDEX = new Map<number, readonly string[]>([
  [PIR.id, ['motion']],
  [ASSIGNED.id, ['contact']],
  [KITCHEN.id, ['motion']],
  [DOOR_CONTACT.id, ['contact']],
  [DOOR_BATTERY.id, ['motion']],
  [LAMP_MOTION.id, ['motion']],
])

const keyOf = (d: CandidateDevice): string =>
  compositionSourceKey({ addonId: d.addonId, stableId: d.stableId })

/** The motion card's candidates: source caps, no cameras, not the host, not assigned. */
function motionCandidates(assigned: ReadonlySet<string> = new Set()) {
  return sourceCandidates({
    devices: FLEET,
    capIndex: CAP_INDEX,
    hostId: HOST.id,
    excludeCameras: true,
    assigned,
    preferredCap: null,
  })
}

describe('roomSuggestionsOf', () => {
  it('is absent until the fleet answered, and without a location', () => {
    expect(roomSuggestionsOf({ kind: 'pending' }, 'Hall')).toBeNull()
    expect(roomSuggestionsOf({ kind: 'known', value: FLEET }, null)).toBeNull()
  })
})

describe('splitByRoom over a card candidate list', () => {
  const room = roomSuggestionsOf({ kind: 'known', value: FLEET }, 'Hall')

  it('suggests the same-location devices, never a device elsewhere', () => {
    const split = splitByRoom(motionCandidates(), room, (c) => c.deviceId)
    const ids = split.suggested.map((c) => c.deviceId)
    expect(ids).toContain(PIR.id)
    expect(ids).not.toContain(KITCHEN.id)
    expect(split.others.map((c) => c.deviceId)).toContain(KITCHEN.id)
  })

  it('applies the card compatibility filter: a light is never suggested to a sensor card', () => {
    const ids = splitByRoom(motionCandidates(), room, (c) => c.deviceId).suggested.map(
      (c) => c.deviceId,
    )
    expect(ids).not.toContain(LIGHT.id)
  })

  it('excludes a device already assigned to the card', () => {
    const suggested = (assigned: ReadonlySet<string>) =>
      splitByRoom(motionCandidates(assigned), room, (c) => c.deviceId).suggested.map(
        (c) => c.deviceId,
      )
    expect(suggested(new Set())).toContain(ASSIGNED.id)
    expect(suggested(new Set([keyOf(ASSIGNED)]))).not.toContain(ASSIGNED.id)
  })

  it('a container contributes only its auto-selected primary child, never itself', () => {
    const ids = splitByRoom(motionCandidates(), room, (c) => c.deviceId).suggested.map(
      (c) => c.deviceId,
    )
    expect(ids).toContain(DOOR_CONTACT.id)
    expect(ids).not.toContain(DOOR_BATTERY.id)
    expect(ids).not.toContain(DOOR.id)
  })

  it('a container whose primary is not valid for the card suggests nothing; its children stay in the list', () => {
    const split = splitByRoom(motionCandidates(), room, (c) => c.deviceId)
    expect(split.suggested.map((c) => c.deviceId)).not.toContain(LAMP_MOTION.id)
    expect(split.others.map((c) => c.deviceId)).toContain(LAMP_MOTION.id)
  })

  it('a container without a child suggests nothing', () => {
    expect(room?.ids.has(EMPTY.id)).toBe(false)
    const types = [...(room?.ids ?? [])].map((id) => FLEET.find((d) => d.id === id)?.type)
    expect(types).not.toContain('container')
  })

  it('names a suggested child after its container', () => {
    expect(suggestionContainer(room, DOOR_CONTACT.id)).toBe('Porta hall')
    expect(suggestionContainer(room, PIR.id)).toBeNull()
  })

  it('without a room, everything stays in the normal list', () => {
    const all = motionCandidates()
    expect(splitByRoom(all, null, (c) => c.deviceId)).toEqual({ suggested: [], others: all })
  })
})

describe('the header count and the field cards', () => {
  const room = roomSuggestionsOf({ kind: 'known', value: FLEET }, 'Hall')

  it('counts only the answered candidates the room suggests', () => {
    expect(suggestedCount({ kind: 'pending' }, room, (c: { id: number }) => c.id)).toBe(0)
    const count = suggestedCount(
      { kind: 'known', value: motionCandidates() },
      room,
      (c) => c.deviceId,
    )
    // PIR, the unassigned contact, and the door container's primary.
    expect(count).toBe(3)
  })
})
