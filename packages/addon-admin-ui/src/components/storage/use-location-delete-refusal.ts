/**
 * The storage table's answer to a refused delete: explain why, offer Force delete, and only after
 * a second confirmation that names what it strands call the orchestrator's `forceDeleteLocation`
 * (D49). Returns `true` when the refusal was handled here, `false` for an error the generic
 * delete failure toast must report.
 */
import { useAddonsCustom, useConfirm } from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { HOLDER_QUERY_KEY } from '../instances/use-instances-data'
import type { InstanceRow } from '../instances/instances-model'
import { pushToast } from '../ui/toast-bus'
import { classifyDeleteRefusal } from './location-delete-refusal'

export const FORCE_DELETE_ACTION = 'forceDeleteLocation'

export function useLocationDeleteRefusal(): (row: InstanceRow, err: unknown) => Promise<boolean> {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const queryClient = useQueryClient()
  const custom = useAddonsCustom()

  return useCallback(
    async (row, err) => {
      const refusal = classifyDeleteRefusal(err)
      if (refusal === null) return false
      const reason =
        refusal === 'holds-data'
          ? t(
              'system.storage.deleteBlockedHoldsData',
              'This location still holds data. Drain it first (storage migration or relocate), or force the delete.',
            )
          : t(
              'system.storage.deleteBlockedUnverifiable',
              'What is stored on this location could not be checked (unreachable provider, another node or an unmounted root). Force the delete only if you are sure it is empty or no longer needed.',
            )
      const wantsForce = await confirm({
        title: t('system.storage.deleteBlockedTitle', 'Cannot delete {{name}}', { name: row.name }),
        message: reason,
        confirmLabel: t('system.storage.forceDelete', 'Force delete'),
        variant: 'danger',
      })
      if (!wantsForce) return true
      const sure = await confirm({
        title: t('system.storage.forceDeleteTitle', 'Force delete "{{name}}"?', { name: row.name }),
        message: t(
          'system.storage.forceDeleteStrands',
          'Recordings and media stored on this location will be stranded: the record is deleted, the files stay on disk, and playback of the segments on it stops working.',
        ),
        confirmLabel: t('system.storage.forceDeleteConfirm', 'Delete and strand data'),
        variant: 'danger',
      })
      if (!sure) return true
      try {
        await custom.mutateAsync({
          addonId: row.addonId,
          action: FORCE_DELETE_ACTION,
          input: { id: row.id },
        })
        await queryClient.invalidateQueries({ queryKey: [HOLDER_QUERY_KEY] })
        await queryClient.invalidateQueries({ queryKey: [['storage', 'listLocations']] })
      } catch (forceErr: unknown) {
        pushToast({
          title: t('providerInstances.deleteFailed', 'Could not delete'),
          message: `${row.name}: ${forceErr instanceof Error ? forceErr.message : String(forceErr)}`,
          severity: 'critical',
        })
      }
      return true
    },
    [confirm, custom, queryClient, t],
  )
}
