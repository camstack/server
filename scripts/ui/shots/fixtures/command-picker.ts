/**
 * Invented fleet for the Device command dialog: a hub with two children, a
 * feeder, and the bindings those devices offer. `deviceManager.search` honours
 * `requires.actions` the same way the server does (vocabulary action ids).
 */
import { vocabularyActionsForDevice } from '@camstack/types'
import { defineFixtures } from './_define'

interface FleetDevice {
  readonly id: number
  readonly name: string
  readonly type: string
  readonly location: string
  readonly integrationId: string
  readonly integrationLabel: string
  readonly parentDeviceId: number | null
  readonly caps: readonly string[]
}

const FLEET: readonly FleetDevice[] = [
  {
    id: 100,
    name: 'Living room hub',
    type: 'container',
    location: 'Living room',
    integrationId: 'hue',
    integrationLabel: 'Hue',
    parentDeviceId: null,
    caps: [],
  },
  {
    id: 1,
    name: 'Kitchen blind',
    type: 'cover',
    location: 'Kitchen',
    integrationId: 'hue',
    integrationLabel: 'Hue',
    parentDeviceId: 100,
    caps: ['cover'],
  },
  {
    id: 2,
    name: 'Porch lamp',
    type: 'light',
    location: 'Porch',
    integrationId: 'hue',
    integrationLabel: 'Hue',
    parentDeviceId: 100,
    caps: ['switch'],
  },
  {
    id: 3,
    name: 'Patio feeder',
    type: 'pet-feeder',
    location: 'Garden',
    integrationId: 'mqtt',
    integrationLabel: 'MQTT',
    parentDeviceId: null,
    caps: ['pet-feeder', 'switch'],
  },
]

function listRow(device: FleetDevice) {
  return {
    id: device.id,
    name: device.name,
    addonId: 'provider-example',
    stableId: `example.${device.id}`,
    location: device.location,
    type: device.type,
    parentDeviceId: device.parentDeviceId,
    disabled: false,
    online: true,
    integrationId: device.integrationId,
  }
}

function binding(capName: string) {
  return {
    capName,
    kind: 'native' as const,
    providerAddonId: 'provider-example',
    providerNodeId: 'hub',
    nativeAddonId: 'provider-example',
  }
}

interface SearchInput {
  readonly ids?: readonly number[]
  readonly text?: string
  readonly requires?: { readonly actions?: readonly string[]; readonly mode?: 'any' | 'all' }
  readonly filters?: {
    readonly locations?: readonly string[]
    readonly integrationIds?: readonly string[]
    readonly types?: readonly string[]
  }
}

function offers(device: FleetDevice, input: SearchInput): boolean {
  const actions = input.requires?.actions ?? []
  if (actions.length === 0) return true
  const ids = new Set(
    vocabularyActionsForDevice(device.caps, device.type).map((action) => action.id),
  )
  return input.requires?.mode === 'all'
    ? actions.every((id) => ids.has(id))
    : actions.some((id) => ids.has(id))
}

function selected(have: readonly string[] | undefined, value: string | null): boolean {
  if (have === undefined || have.length === 0) return true
  return value !== null && have.includes(value)
}

function searchItem(device: FleetDevice, compatible: boolean) {
  return {
    id: device.id,
    name: device.name,
    type: device.type,
    location: device.location,
    integrationId: device.integrationId,
    integrationLabel: device.integrationLabel,
    online: true,
    disabled: false,
    compatible,
    values: [],
  }
}

function search(input: SearchInput) {
  if (input.ids !== undefined) {
    const items = input.ids
      .map((id) => FLEET.find((device) => device.id === id))
      .filter((device): device is FleetDevice => device !== undefined)
      .map((device) => searchItem(device, offers(device, input)))
    return {
      items,
      nextCursor: null,
      total: items.length,
      compatibleTotal: items.filter((item) => item.compatible).length,
      fleetTotal: FLEET.length,
      hiddenIncompatible: 0,
      facets: { locations: [], integrations: [], types: [] },
      suggested: [],
      missingIds: input.ids.filter((id) => !FLEET.some((device) => device.id === id)),
    }
  }
  const text = (input.text ?? '').trim().toLowerCase()
  const textPass = FLEET.filter((device) => device.name.toLowerCase().includes(text))
  const compatible = textPass.filter((device) => offers(device, input))
  const filters = input.filters
  const listed = compatible.filter(
    (device) =>
      selected(filters?.locations, device.location) &&
      selected(filters?.integrationIds, device.integrationId) &&
      selected(filters?.types, device.type),
  )
  const count = (key: (device: FleetDevice) => string) => {
    const out = new Map<string, number>()
    for (const device of compatible) out.set(key(device), (out.get(key(device)) ?? 0) + 1)
    return [...out.entries()].map(([value, n]) => ({ value, count: n }))
  }
  return {
    items: listed.map((device) => searchItem(device, true)),
    nextCursor: null,
    total: listed.length,
    compatibleTotal: listed.length,
    fleetTotal: FLEET.length,
    hiddenIncompatible: textPass.length - compatible.length,
    facets: {
      locations: count((device) => device.location),
      integrations: [
        ...new Map(compatible.map((device) => [device.integrationId, device])).entries(),
      ].map(([id, device]) => ({
        id,
        label: device.integrationLabel,
        count: compatible.filter((row) => row.integrationId === id).length,
      })),
      types: count((device) => device.type),
    },
    suggested: [],
    missingIds: [],
  }
}

export default defineFixtures({
  area: 'command-picker',
  description: 'Device command dialog over an invented hub, blind, lamp and feeder',
  handlers: {
    'deviceManager.listAll': FLEET.map(listRow),
    'deviceManager.listSiteZones': [],
    'deviceManager.getBindingsBatch': (input: { deviceIds?: readonly number[] }) =>
      (input.deviceIds ?? []).map((deviceId) => ({
        deviceId,
        entries: (FLEET.find((device) => device.id === deviceId)?.caps ?? []).map(binding),
      })),
    'deviceManager.search': (input: SearchInput) => search(input),
  },
})
