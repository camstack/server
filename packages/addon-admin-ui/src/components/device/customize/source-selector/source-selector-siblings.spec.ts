/**
 * Every Customize extension's source selector suggests the host's SIBLINGS that
 * fit (D951): one generic function over the candidates the destination already
 * accepts, with no extension-specific branch. A suggestion is a presentation,
 * never a link (D356).
 */
import { describe, expect, it } from 'vitest'
import {
  type SourceCandidateDevice,
  type SourceDestination,
  partitionSourceDevices,
} from './source-selector-model'
import { siblingSuggestions } from './source-selector-siblings'

function row(id: number, overrides: Partial<SourceCandidateDevice> = {}): SourceCandidateDevice {
  return {
    id,
    name: `Device ${id}`,
    type: 'sensor',
    location: null,
    parentDeviceId: null,
    addonId: 'provider-x',
    stableId: `dev-${id}`,
    caps: ['power-meter'],
    ...overrides,
  }
}

const CONTAINER = row(1, { name: 'Desk plug', type: 'container', caps: [] })
const HOST = row(2, {
  name: 'Plug switch',
  type: 'switch',
  parentDeviceId: 1,
  caps: ['switch'],
})
const WATTS: SourceDestination = {
  cap: 'power-meter',
  targetId: 'watts',
  title: 'Watts',
}

function suggest(fleet: readonly SourceCandidateDevice[], destination = WATTS) {
  const { compatible } = partitionSourceDevices(fleet, destination, HOST.id)
  return siblingSuggestions(compatible, fleet, HOST.id)
}

describe('siblingSuggestions', () => {
  it('suggests the sensors of the same container that fit, named after the container', () => {
    const power = row(3, { name: 'Power', parentDeviceId: 1 })
    const energy = row(4, { name: 'Energy', parentDeviceId: 1 })
    const result = suggest([CONTAINER, HOST, power, energy])
    expect(result?.container).toBe('Desk plug')
    expect(result?.devices.map((d) => d.id)).toEqual([4, 3])
  })

  it('leaves out a sibling that does not fit the destination', () => {
    const power = row(3, { parentDeviceId: 1 })
    const motion = row(4, { parentDeviceId: 1, caps: ['motion'] })
    expect(suggest([CONTAINER, HOST, power, motion])?.devices.map((d) => d.id)).toEqual([3])
  })

  it('leaves out a fitting device that lives in another container', () => {
    const other = row(5, { name: 'Other plug', type: 'container', caps: [] })
    const stranger = row(6, { parentDeviceId: 5 })
    const power = row(3, { parentDeviceId: 1 })
    expect(suggest([CONTAINER, other, HOST, power, stranger])?.devices.map((d) => d.id)).toEqual([
      3,
    ])
  })

  it('ranks the host siblings before the devices under the host, then by name', () => {
    const underHost = row(7, { name: 'A child', parentDeviceId: 2 })
    const zeta = row(3, { name: 'Zeta', parentDeviceId: 1 })
    const alpha = row(4, { name: 'Alpha', parentDeviceId: 1 })
    expect(suggest([CONTAINER, HOST, underHost, zeta, alpha])?.devices.map((d) => d.id)).toEqual([
      4, 3, 7,
    ])
  })

  it('suggests nothing for a host that lives in no container', () => {
    const loose = row(2, { type: 'switch', caps: ['switch'] })
    const { compatible } = partitionSourceDevices([loose, row(3)], WATTS, 2)
    expect(siblingSuggestions(compatible, [loose, row(3)], 2)).toBeNull()
  })

  it('works for any destination, with no extension named', () => {
    const running: SourceDestination = {
      cap: 'running-state',
      targetId: 'running',
      title: 'Running',
    }
    const plug = row(3, { parentDeviceId: 1, caps: ['switch'] })
    expect(suggest([CONTAINER, HOST, plug], running)?.devices.map((d) => d.id)).toEqual([3])
  })
})
