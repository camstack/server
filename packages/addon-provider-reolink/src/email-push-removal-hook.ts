import type { DeviceRemovedResult, IDeviceRemovalHookProvider } from '@camstack/types'

/**
 * A removed camera leaves its `cam-<stableId>` recipient in the mailbox (D865). The addon holds
 * no per-device DATA for the intake (the mailbox is owned by the mail addon), so removal only
 * redeclares the recipient set without the camera. Driven by the tombstone, never by absence.
 */
export function createEmailPushRemovalHook(deps: {
  readonly resync: () => Promise<void>
}): IDeviceRemovalHookProvider {
  return {
    onDeviceRemoved: async (): Promise<DeviceRemovedResult> => {
      await deps.resync()
      return { counts: { 'mailbox-recipients': 0 } }
    },
    listDeviceData: async () => [],
  }
}
