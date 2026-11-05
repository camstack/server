/**
 * useDeviceRemoval — the shared pending state of a confirmed device delete.
 *
 * Every devices table (the Devices page, an integration's device list, the
 * batch toolbar) deletes through ONE of these, so a confirmed delete reads the
 * same everywhere: the row is `pending` from the confirm until the removal has
 * COMPLETED, disappears on its own once the list no longer holds the device,
 * and on failure is restored with the error.
 *
 * Completion signal: `deviceManager.remove` resolves only after the hub's
 * depth-first cascade — descendants, the live device teardown, the row DELETE
 * and the per-store cleanup — so `remove` settling IS the removal being done.
 * `refresh` (the list refetch) is awaited too, so the row is released only
 * after the list has answered without it: no flash of the old row, and no
 * timer anywhere deciding that "enough time has passed".
 */
import { useCallback, useMemo } from 'react'
import { type RowOperationState, useRowOperations } from './use-row-operations'

export interface UseDeviceRemovalOptions {
  /** Must resolve only once the removal has completed on the hub. */
  readonly remove: (input: { readonly deviceId: number }) => Promise<unknown>
  /** Awaited after `remove`: refetch the devices list the table renders. */
  readonly refresh?: () => Promise<unknown>
  /** A removal failed; the row is restored. Surface `message` (a toast). */
  readonly onError?: (deviceId: number, message: string) => void
}

export interface DeviceRemoval {
  /** Fire-and-track; has the shape of `DeviceListBatchActions.remove`. */
  readonly remove: (input: { readonly deviceId: number }) => void
  /** Awaitable form: `true` when the device was removed. */
  readonly removeAsync: (input: { readonly deviceId: number }) => Promise<boolean>
  /** The row's state for `<DeviceList rowOperation>`; undefined = idle. */
  readonly rowOperation: (device: { readonly id: number }) => RowOperationState | undefined
}

export function useDeviceRemoval(options: UseDeviceRemovalOptions): DeviceRemoval {
  const { remove, refresh, onError } = options
  const ops = useRowOperations<number>()
  const { run, stateOf } = ops

  const removeAsync = useCallback(
    (input: { readonly deviceId: number }): Promise<boolean> =>
      run(
        input.deviceId,
        async () => {
          await remove(input)
          if (refresh !== undefined) await refresh()
        },
        (message) => onError?.(input.deviceId, message),
      ),
    [run, remove, refresh, onError],
  )

  const removeTracked = useCallback(
    (input: { readonly deviceId: number }): void => {
      void removeAsync(input)
    },
    [removeAsync],
  )

  const rowOperation = useCallback(
    (device: { readonly id: number }): RowOperationState | undefined => stateOf(device.id),
    [stateOf],
  )

  return useMemo(
    () => ({ remove: removeTracked, removeAsync, rowOperation }),
    [removeTracked, removeAsync, rowOperation],
  )
}
