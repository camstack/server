import { describe, expect, it } from 'vitest'
import {
  type CandidateDevice,
  capIndexOf,
  filterCandidates,
  MOTION_SENSOR_FILTERS,
  primarySourceCap,
  sourceCandidates,
} from '../assignment-candidates'

const DEVICES: readonly CandidateDevice[] = [
  {
    id: 103,
    name: 'Camera porch',
    addonId: 'provider-reolink',
    stableId: 'r-103',
    type: 'camera',
    location: 'Porch',
    isCamera: true,
    integration: 'Reolink',
  },
  {
    id: 3299,
    name: 'PIR porch',
    addonId: 'provider-homeassistant',
    stableId: 'ha:pir',
    type: 'sensor',
    location: 'Porch',
    isCamera: false,
    integration: 'Home Assistant',
  },
  {
    id: 3301,
    name: 'Contatto cancello',
    addonId: 'provider-zigbee',
    stableId: 'z:gate',
    type: 'sensor',
    location: 'Garden',
    isCamera: false,
    integration: 'Zigbee',
  },
  {
    id: 3400,
    name: 'Mangiatoia',
    addonId: 'provider-homeassistant',
    stableId: 'ha:feeder',
    type: 'container',
    location: 'Kitchen',
    isCamera: false,
    integration: 'Home Assistant',
  },
  {
    id: 101,
    name: 'Camera front door',
    addonId: 'provider-hikvision',
    stableId: 'mac-1',
    type: 'camera',
    location: 'Front door',
    isCamera: true,
    integration: null,
  },
  {
    id: 4000,
    name: 'Lampada',
    addonId: 'provider-homeassistant',
    stableId: 'ha:lamp',
    type: 'light',
    location: null,
    isCamera: false,
    integration: 'Home Assistant',
  },
]
const INDEX = new Map<number, readonly string[]>([
  [3299, ['motion']],
  [3301, ['contact']],
  [3400, ['motion']],
  [101, ['motion']],
])

describe('sourceCandidates', () => {
  it('a motion sensor is never the host, a camera (D672 rule 5) or a container (D356), and must carry a source cap', () => {
    const out = sourceCandidates({
      devices: DEVICES,
      capIndex: INDEX,
      hostId: 103,
      excludeCameras: true,
      assigned: new Set(),
      preferredCap: 'motion',
    })
    expect(out.map((c) => c.deviceId)).toEqual([3301, 3299])
    expect(out[1]).toEqual({
      deviceId: 3299,
      ref: { addonId: 'provider-homeassistant', stableId: 'ha:pir' },
      name: 'PIR porch',
      detail: 'Home Assistant · Porch',
      meta: 'motion',
      caps: ['motion'],
      value: { deviceId: 3299, cap: 'motion', path: 'detected' },
    })
    expect(out[0]?.value).toEqual({ deviceId: 3301, cap: 'contact', path: 'entryOpen' })
  })
  it('a doorbell may ring from another camera, never from itself or a container', () => {
    const out = sourceCandidates({
      devices: DEVICES,
      capIndex: INDEX,
      hostId: 103,
      excludeCameras: false,
      assigned: new Set(),
      preferredCap: null,
    })
    expect(out.map((c) => c.deviceId)).toEqual([101, 3301, 3299])
    expect(out[0]?.detail).toBe('Front door')
  })
  it('an already-assigned ref is not offered again', () => {
    const out = sourceCandidates({
      devices: DEVICES,
      capIndex: INDEX,
      hostId: 103,
      excludeCameras: true,
      assigned: new Set(['provider-homeassistant/ha:pir']),
      preferredCap: 'motion',
    })
    expect(out.map((c) => c.deviceId)).toEqual([3301])
  })
})

describe('primarySourceCap', () => {
  it('prefers the asked cap, else the catalogue order', () => {
    expect(primarySourceCap(['contact', 'motion'], 'motion')).toBe('motion')
    expect(primarySourceCap(['motion', 'contact'], null)).toBe('contact')
    expect(primarySourceCap([], null)).toBeNull()
  })
})

describe('filterCandidates', () => {
  const all = sourceCandidates({
    devices: DEVICES,
    capIndex: INDEX,
    hostId: 103,
    excludeCameras: true,
    assigned: new Set(),
    preferredCap: 'motion',
  })
  it('a chip keeps the devices carrying one of its caps', () => {
    const [motion, contact, everything] = MOTION_SENSOR_FILTERS
    expect(filterCandidates(all, '', motion ?? null).map((c) => c.deviceId)).toEqual([3299])
    expect(filterCandidates(all, '', contact ?? null).map((c) => c.deviceId)).toEqual([3301])
    expect(filterCandidates(all, '', everything ?? null)).toHaveLength(2)
  })
  it('the search matches name, integration and room — every token', () => {
    expect(filterCandidates(all, 'garden', null).map((c) => c.deviceId)).toEqual([3301])
    expect(filterCandidates(all, 'home porch', null).map((c) => c.deviceId)).toEqual([3299])
    expect(filterCandidates(all, 'nothing-like-this', null)).toEqual([])
  })
})

describe('capIndexOf — D315', () => {
  it('pending until every cap answered; one failure is unknown with its reason', () => {
    expect(capIndexOf([{ cap: 'motion', query: { status: 'pending' } }]).kind).toBe('pending')
    expect(
      capIndexOf([
        { cap: 'motion', query: { status: 'success', data: [1] } },
        { cap: 'contact', query: { status: 'error', error: { message: 'registry down' } } },
      ]),
    ).toEqual({ kind: 'unknown', reason: 'registry down' })
  })
  it('inverts cap → ids into id → caps', () => {
    const index = capIndexOf([
      { cap: 'motion', query: { status: 'success', data: [3299, 101] } },
      { cap: 'contact', query: { status: 'success', data: [3301, 3299] } },
    ])
    expect(index.kind === 'known' ? [...index.value.entries()] : []).toEqual([
      [3299, ['motion', 'contact']],
      [101, ['motion']],
      [3301, ['contact']],
    ])
  })
})
