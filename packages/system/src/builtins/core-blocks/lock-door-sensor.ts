/**
 * Which door sensor a lock's Customize links (D984): the source the stored
 * `lock-control.state` override reads as its `x` binding. Read from the STORED
 * composition, never kept as a second copy (D676); asked only when a refusal
 * has to name the sensor.
 */
import {
  type CompositionSourceRef,
  type CoreBlock,
  coreBlockComposition,
  type IScopedLogger,
  type LockDoorLink,
  lockDoorLinkOfComposition,
} from '@camstack/types'

export type { LockDoorLink }

export function lockDoorLinkOf(block: Pick<CoreBlock, 'source'>): LockDoorLink | null {
  return lockDoorLinkOfComposition(coreBlockComposition(block))
}

export interface DeviceNames {
  /** The device's id and name for a source ref, or null when it cannot be found. */
  readonly find: (ref: CompositionSourceRef) => Promise<{ id: number; name: string } | null>
}

/** The linked sensor's name for the lock `deviceId`, or null when none is linked or it cannot be read. */
export async function doorSensorOf(
  blocks: readonly Pick<CoreBlock, 'source'>[],
  deviceId: number,
  names: DeviceNames,
): Promise<string | null> {
  for (const block of blocks) {
    const link = lockDoorLinkOf(block)
    if (link === null) continue
    const lock = await names.find(link.lock)
    if (lock === null || lock.id !== deviceId) continue
    const sensor = await names.find(link.sensor)
    return sensor?.name ?? `${link.sensor.stableId}`
  }
  return null
}

export interface SeedLockDoorsDeps {
  readonly blocks: readonly Pick<CoreBlock, 'source'>[]
  readonly names: DeviceNames
  /** The lock's CURRENT merged `lock-control.state` (the hub mirror), or null when it holds none. Throws when it cannot be read. */
  readonly readState: (deviceId: number) => Promise<string | null>
  /** Hand the state to the gate, exactly as a `device.state-changed` would. */
  readonly apply: (deviceId: number, state: string) => void
  readonly logger: IScopedLogger
  /** Locks whose failed read was already logged; one line per lock, not per retry. */
  readonly failedLogged: Set<number>
}

/**
 * Seed the gate with each linked lock's current state, once, off the command
 * path (D49): a hub restart must not leave an open door "unknown" until the
 * next event. A read that fails changes nothing and is logged once.
 */
export async function seedLockDoors(deps: SeedLockDoorsDeps): Promise<void> {
  for (const block of deps.blocks) {
    const link = lockDoorLinkOf(block)
    if (link === null) continue
    const lock = await deps.names.find(link.lock).catch(() => null)
    if (lock === null) continue
    try {
      const state = await deps.readState(lock.id)
      if (state !== null) {
        deps.apply(lock.id, state)
        deps.failedLogged.delete(lock.id)
      }
    } catch (err: unknown) {
      if (deps.failedLogged.has(lock.id)) continue
      deps.failedLogged.add(lock.id)
      deps.logger.warn('lock: the door state could not be read at startup, it stays unknown', {
        tags: { deviceId: lock.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }
}
