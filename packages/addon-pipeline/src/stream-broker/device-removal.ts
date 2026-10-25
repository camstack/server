/**
 * The broker's half of an operator's device DELETE.
 *
 * Since D685 this subscription is the fast path of a removal: providers no
 * longer retract their streams from `removeDevice()`, because that hook also
 * runs on every runner restart. The backstop for a dropped event is the
 * catalog poll's departed-device sweep (`StreamBrokerManager`,
 * `sweepDepartedDevices`). Extracted from `addon.ts` so the registration the
 * addon performs is the one a test drives.
 */
import {
  EventCategory,
  errMsg,
  type EventFilter,
  type IScopedLogger,
  type SystemEvent,
} from '@camstack/types'
import type { RetractDeviceOptions } from './stream-broker/stream-broker-manager.js'

/** The addon's `subscribe`, narrowed to what this wiring needs. */
export type SubscribeFn = (filter: EventFilter, handler: (event: SystemEvent) => void) => void

export interface DeviceRemovalDeps {
  readonly retractDevice: (deviceId: number, opts: RetractDeviceOptions) => Promise<void>
  readonly logger: IScopedLogger
}

/** A PERMANENT removal: retract every stream AND purge the slot assignments. */
export async function retractRemovedDevice(
  deviceId: number,
  deps: DeviceRemovalDeps,
): Promise<void> {
  try {
    await deps.retractDevice(deviceId, { preserveAssignments: true, purgeAssignments: true })
  } catch (err: unknown) {
    deps.logger.warn('device retract failed', {
      tags: { deviceId },
      meta: { error: errMsg(err) },
    })
  }
}

/** Retract a device the moment the device-manager says it was deleted. */
export function subscribeDeviceRemoval(
  subscribe: SubscribeFn,
  deps: () => DeviceRemovalDeps,
): void {
  subscribe({ category: EventCategory.DeviceUnregistered }, (event) => {
    const deviceId = event.data['deviceId']
    if (typeof deviceId === 'number') void retractRemovedDevice(deviceId, deps())
  })
}
