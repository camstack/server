import { DeviceType, type DiscoveredChildDevice } from '@camstack/types'
import { capsOfSpec, type EnpalSpec } from './enpal-catalog.js'

/** The `childNativeId` of a catalog entry on a box: namespaced so two boxes never collide. */
export function specNativeId(boxId: string, specId: string): string {
  return `${boxId}:${specId}`
}

/** The catalog entry id of a {@link specNativeId} value, or null. */
export function parseSpecNativeId(boxId: string, childNativeId: string): string | null {
  const prefix = `${boxId}:`
  if (!childNativeId.startsWith(prefix)) return null
  const id = childNativeId.slice(prefix.length)
  return id.length > 0 ? id : null
}

export interface BuildCandidatesInput {
  readonly boxId: string
  readonly boxName: string
  readonly specs: readonly EnpalSpec[]
  /** Adopted device id PER spec id, or null when not adopted. */
  readonly adoptedDeviceIdBySpec: Readonly<Record<string, number | null>>
  readonly online: boolean
}

/** One Sensor candidate per data group the box reported. Pure. */
export function buildCandidates(input: BuildCandidatesInput): readonly DiscoveredChildDevice[] {
  return input.specs.map((spec) => {
    const adoptedDeviceId = input.adoptedDeviceIdBySpec[spec.id] ?? null
    return {
      childNativeId: specNativeId(input.boxId, spec.id),
      name: `${input.boxName} ${spec.name}`,
      type: DeviceType.Sensor,
      status: input.online ? 'online' : 'offline',
      metadata: { manufacturer: 'Enpal', integration: 'enpal' },
      alreadyAdopted: adoptedDeviceId !== null,
      adoptedDeviceId,
      capabilities: capsOfSpec(spec),
    } satisfies DiscoveredChildDevice
  })
}
