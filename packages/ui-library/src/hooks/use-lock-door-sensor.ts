/**
 * useLockDoorSensor: the door contact a lock's Customize links (D984), and what
 * that contact itself reads. The link is found only through the lock's stored
 * customization (`lockDoorLinkOfComposition`); the open/closed reading is the
 * sensor's own `contact` slice, never inferred from the lock state.
 */
import { useEffect, useState } from 'react'
import type { CompositionCustomizationRead, DeviceInfo } from '@camstack/types'
import { coreBlockComposition, lockDoorLinkOfComposition } from '@camstack/types'
import { useDeviceState, type UseDeviceProxyTrpc } from './use-device-proxy'

interface QueryFn<I, O> {
  query(input: I): Promise<O>
}

/** The three reads the link lookup needs; a client without them shows no door row. */
export interface LockDoorLookupTrpc extends UseDeviceProxyTrpc {
  readonly deviceManager: UseDeviceProxyTrpc['deviceManager'] & {
    readonly getDevice: QueryFn<{ deviceId: number }, DeviceInfo | null>
    readonly listAll: QueryFn<{ addonId: string; projection: 'slim' }, readonly DeviceInfo[]>
  }
  readonly coreBlocks: {
    readonly getCustomization: QueryFn<
      { addonId: string; stableId: string },
      CompositionCustomizationRead
    >
  }
}

/**
 * A tRPC client is a Proxy: `in` finds nothing on it, a property read does. So the
 * presence of a member is a read that answers something.
 */
function hasMember(value: object, key: string): boolean {
  return Reflect.get(value, key) != null
}

function canLookUpDoor(trpc: UseDeviceProxyTrpc): trpc is LockDoorLookupTrpc {
  const blocks: unknown = Reflect.get(trpc, 'coreBlocks')
  return (
    (typeof blocks === 'object' || typeof blocks === 'function') &&
    blocks !== null &&
    hasMember(blocks, 'getCustomization') &&
    hasMember(trpc.deviceManager, 'getDevice') &&
    hasMember(trpc.deviceManager, 'listAll')
  )
}

interface LinkedSensor {
  readonly id: number
  readonly name: string
}

async function findLinkedSensor(
  trpc: LockDoorLookupTrpc,
  lockDeviceId: number,
): Promise<LinkedSensor | null> {
  const lock = await trpc.deviceManager.getDevice.query({ deviceId: lockDeviceId })
  if (lock === null) return null
  const custom = await trpc.coreBlocks.getCustomization.query({
    addonId: lock.addonId,
    stableId: lock.stableId,
  })
  if (custom.state !== 'loaded' || custom.view === null) return null
  const link = lockDoorLinkOfComposition(coreBlockComposition(custom.view.block))
  if (link === null) return null
  const sensors = await trpc.deviceManager.listAll.query({
    addonId: link.sensor.addonId,
    projection: 'slim',
  })
  const sensor = sensors.find((d) => d.stableId === link.sensor.stableId)
  return sensor === undefined ? null : { id: sensor.id, name: sensor.name }
}

export type LockDoorReading = 'open' | 'closed' | 'unknown'

export interface LockDoorSensor {
  readonly name: string
  readonly reading: LockDoorReading
}

/** The linked door contact with its own reading, or `null` while unknown or when none is linked. */
export function useLockDoorSensor(
  trpc: UseDeviceProxyTrpc,
  deviceId: number,
): LockDoorSensor | null {
  const [sensor, setSensor] = useState<LinkedSensor | null>(null)
  useEffect(() => {
    if (!canLookUpDoor(trpc)) return
    let cancelled = false
    findLinkedSensor(trpc, deviceId).then(
      (found) => {
        if (!cancelled) setSensor(found)
      },
      () => {
        if (!cancelled) setSensor(null)
      },
    )
    return () => {
      cancelled = true
    }
  }, [trpc, deviceId])
  const contact = useDeviceState(trpc, sensor?.id ?? null, (s) => s.contact)
  if (sensor === null) return null
  // A slice that has not carried a reading yet is unknown, never closed.
  const reading: LockDoorReading =
    typeof contact?.entryOpen !== 'boolean' ? 'unknown' : contact.entryOpen ? 'open' : 'closed'
  return { name: sensor.name, reading }
}
