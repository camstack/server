/**
 * The admin UI's binding of `useDeviceRemoval`: the real `deviceManager.remove`
 * mutation, the devices-list refetch that releases a removed row, and the toast
 * that reports a failure. Every devices table mounts this ONE hook, so a
 * confirmed delete behaves the same on the Devices page, an integration's
 * device list and the batch toolbar.
 *
 * `deviceManager.remove` resolves after the hub's cascade has finished, so the
 * row stays pending exactly until the removal is done (see `useDeviceRemoval`).
 */
import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { type DeviceRemoval, useDeviceManagerRemove, useDeviceRemoval } from '@camstack/ui-library'
import { pushToast } from '../components/ui/toast-bus'

export function useAdminDeviceRemoval(): DeviceRemoval {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const removeMutation = useDeviceManagerRemove()
  const { mutateAsync } = removeMutation

  const remove = useCallback(
    (input: { readonly deviceId: number }) => mutateAsync({ deviceId: input.deviceId }),
    [mutateAsync],
  )
  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: [['deviceManager']] }),
    [queryClient],
  )
  const onError = useCallback(
    (_deviceId: number, message: string): void => {
      pushToast({
        severity: 'critical',
        title: t('devices.removeFailed.title', 'Could not remove the device'),
        message,
        duration: 8000,
      })
    },
    [t],
  )

  return useDeviceRemoval({ remove, refresh, onError })
}
