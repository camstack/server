/**
 * Adapts `BaseAddon.deviceState` (protected, so it can only be reached
 * from inside the addon class) into the `BindingsHandle` the manager
 * consumes. Keeping this seam means `OsdManager` never touches a store.
 */
import type { ZodType } from 'zod'
import type { BindingsHandle, OsdDeviceBindings } from './bindings-store.js'
import { EMPTY_BINDINGS, OSD_BINDINGS_KEY, OsdDeviceBindingsSchema } from './bindings-store.js'

export interface DurableStateLike<T> {
  get(): Promise<T>
  set(next: T): Promise<void>
  update(fn: (prev: T) => T): Promise<void>
}

export type DeviceStateFactory = <T>(
  deviceId: number,
  key: string,
  schema: ZodType<T>,
  fallback: T,
) => DurableStateLike<T>

export class OsdBindingsStore {
  private readonly handles = new Map<number, BindingsHandle>()

  constructor(private readonly factory: DeviceStateFactory) {}

  forDevice(deviceId: number): BindingsHandle {
    const existing = this.handles.get(deviceId)
    if (existing !== undefined) return existing
    const handle = this.factory<OsdDeviceBindings>(
      deviceId,
      OSD_BINDINGS_KEY,
      OsdDeviceBindingsSchema,
      EMPTY_BINDINGS,
    )
    this.handles.set(deviceId, handle)
    return handle
  }
}
