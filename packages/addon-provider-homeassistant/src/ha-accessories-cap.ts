import {
  accessoriesCapability,
  type DeviceContext,
  EventCategory,
  type InferNativeProvider,
} from '@camstack/types'

export interface AccessoriesCapHandle {
  setChildren(ids: readonly number[]): void
}

export interface AccessoriesCapOptions {
  /** Persisted hidden set at construction time. */
  readonly initialHidden: readonly number[]
  /** Optional: persist a changed hidden set (the placeholder wires this to
   *  config.set('hiddenChildIds', ...); parent-mode child devices may omit it). */
  readonly onHiddenChange?: (hidden: readonly number[]) => void | Promise<void>
}

/**
 * Registers the `accessories` capability on the given device context and
 * returns a handle so the owning device can push a fresh child list.
 *
 * Reusable across `HaPlaceholderDevice` and future per-domain device
 * classes that also act as accessory parents.
 */
export function attachAccessoriesCap(
  ctx: DeviceContext,
  deviceId: number,
  opts: AccessoriesCapOptions,
): AccessoriesCapHandle {
  let childIds: readonly number[] = []
  const hidden = new Set<number>(opts.initialHidden)

  const provider: InferNativeProvider<typeof accessoriesCapability> = {
    getStatus: async () => ({
      childDeviceIds: childIds,
      hiddenChildIds: [...hidden],
    }),
    setChildHidden: async ({ childDeviceId, hidden: shouldHide }) => {
      const before = hidden.has(childDeviceId)
      if (shouldHide === before) return
      if (shouldHide) hidden.add(childDeviceId)
      else hidden.delete(childDeviceId)
      await opts.onHiddenChange?.([...hidden])
      ctx.eventBus.emit({
        id: `acc-vis-${deviceId}-${childDeviceId}-${Date.now()}`,
        timestamp: new Date(),
        source: { type: 'device', id: deviceId },
        category: EventCategory.AccessoriesChildVisibilityChanged,
        data: { deviceId, childDeviceId, hidden: shouldHide },
      })
    },
  }

  ctx.registerNativeCap(accessoriesCapability, provider)

  const handle: AccessoriesCapHandle = {
    setChildren(ids: readonly number[]): void {
      childIds = [...ids]
      ctx.eventBus.emit({
        id: `acc-chg-${deviceId}-${Date.now()}`,
        timestamp: new Date(),
        source: { type: 'device', id: deviceId },
        category: EventCategory.AccessoriesChanged,
        data: {
          deviceId,
          childDeviceIds: childIds,
          hiddenChildIds: [...hidden],
        },
      })
    },
  }

  return handle
}
