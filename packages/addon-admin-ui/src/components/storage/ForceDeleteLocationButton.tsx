/**
 * The forced delete of a storage location (D49). The table's Delete keeps the occupancy refusal; a
 * location the check could not read (a pulled disk, another node, a remote provider) answers
 * "unknown" forever, and a refusal nobody can override is its own failure. This is the separate,
 * explicit action, behind a confirmation that says what it strands.
 */
import { IconButton, useAddonsCustom, useConfirm } from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { ShieldOff } from 'lucide-react'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { HOLDER_QUERY_KEY } from '../instances/use-instances-data'
import type { InstanceRow } from '../instances/instances-model'
import { pushToast } from '../ui/toast-bus'

export const FORCE_DELETE_ACTION = 'forceDeleteLocation'

export function ForceDeleteLocationButton({ row }: { readonly row: InstanceRow }): ReactElement {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const queryClient = useQueryClient()
  const custom = useAddonsCustom()

  const run = async (): Promise<void> => {
    const ok = await confirm({
      title: t('system.storage.forceDeleteTitle', 'Force delete "{{name}}"?', { name: row.name }),
      message: t(
        'system.storage.forceDeleteNote',
        'Removes the record only, without checking what is on the location. Anything still stored there becomes unreachable — index rows naming it stop resolving, and playback of those segments goes silently black rather than erroring.',
      ),
      confirmLabel: t('system.storage.forceDelete', 'Force delete'),
      variant: 'danger',
    })
    if (!ok) return
    try {
      await custom.mutateAsync({
        addonId: row.addonId,
        action: FORCE_DELETE_ACTION,
        input: { id: row.id },
      })
      await queryClient.invalidateQueries({ queryKey: [HOLDER_QUERY_KEY] })
      await queryClient.invalidateQueries({ queryKey: [['storage', 'listLocations']] })
    } catch (err: unknown) {
      pushToast({
        title: t('providerInstances.deleteFailed', 'Could not delete'),
        message: `${row.name}: ${err instanceof Error ? err.message : String(err)}`,
        severity: 'critical',
      })
    }
  }

  return (
    <IconButton
      icon={ShieldOff}
      variant="ghost"
      size="sm"
      disabled={custom.isPending}
      aria-label={t('system.storage.forceDeleteRow', 'Force delete {{name}}', { name: row.name })}
      onClick={() => void run()}
    />
  )
}
