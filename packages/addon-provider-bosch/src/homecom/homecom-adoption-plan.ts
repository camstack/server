import type { HomeComDiscoverableDevice } from './homecom-gateway.js'
import { homeComStableId } from './homecom-gateway.js'

/** A HomeCom row already in the registry, matched by {@link homeComStableId}. */
export interface HomeComAdoptedRow {
  readonly id: number
  readonly stableId: string
  readonly parentDeviceId: number | null
}

export interface PlannedHomeComCreate {
  readonly nativeId: string
  readonly name: string
  readonly kind: HomeComDiscoverableDevice['kind']
  readonly circuitId: string | undefined
  /** Null for the pick itself. A child names the heat pump's native id. */
  readonly parentNativeId: string | null
}

/** An existing top-level circuit or hot-water row that must not be duplicated. */
export interface PlannedHomeComSkip {
  readonly nativeId: string
  readonly deviceId: number
}

export interface HomeComAdoptionPlan {
  readonly create: readonly PlannedHomeComCreate[]
  /** Already adopted with no parent. Left where they are. */
  readonly stayedTopLevel: readonly PlannedHomeComSkip[]
  /** Already adopted under some parent. Not created again. */
  readonly alreadyPresent: readonly PlannedHomeComSkip[]
}

function createOf(
  device: HomeComDiscoverableDevice,
  parentNativeId: string | null,
): PlannedHomeComCreate {
  return {
    nativeId: device.nativeId,
    name: device.name,
    kind: device.kind,
    circuitId: device.circuitId,
    parentNativeId,
  }
}

/**
 * The devices one pick creates. A heat pump also creates its children, except
 * a circuit or hot-water row that already exists: a top-level one is reported
 * so the caller can log why it stayed there, and any existing row is not
 * created again.
 */
export function planHomeComAdoption(
  device: HomeComDiscoverableDevice,
  integrationId: string,
  adopted: readonly HomeComAdoptedRow[],
): HomeComAdoptionPlan {
  const root = createOf(device, null)
  if (device.kind !== 'heat-pump') {
    return { create: [root], stayedTopLevel: [], alreadyPresent: [] }
  }
  const byStableId = new Map(adopted.map((row) => [row.stableId, row]))
  const create: PlannedHomeComCreate[] = [root]
  const stayedTopLevel: PlannedHomeComSkip[] = []
  const alreadyPresent: PlannedHomeComSkip[] = []
  for (const child of device.children ?? []) {
    const existing = byStableId.get(homeComStableId(integrationId, child.nativeId))
    if (existing === undefined) {
      create.push(createOf(child, device.nativeId))
      continue
    }
    const skip = { nativeId: child.nativeId, deviceId: existing.id }
    if (existing.parentDeviceId === null) stayedTopLevel.push(skip)
    else alreadyPresent.push(skip)
  }
  return { create, stayedTopLevel, alreadyPresent }
}
