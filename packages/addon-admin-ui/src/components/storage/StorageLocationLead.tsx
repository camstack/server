/**
 * The top of a storage location's edit dialog: what the form cannot say. The volume's capacity and
 * how far a drain has got, the location's one typed state (D385) with the last-writable guard and
 * the confirmation before `disabled` (the only state that takes footage off the timeline), and the
 * leftover discard. A state change is saved on its own, not with the form: it is a decision about
 * what the disk does now, not a field of its config.
 */
import { useConfirm, useIntegrationInstancesUpdateInstance } from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { HOLDER_QUERY_KEY } from '../instances/use-instances-data'
import type { InstanceRow } from '../instances/instances-model'
import { pushToast } from '../ui/toast-bus'
import { DrainProgressLine } from './DrainProgressLine'
import { LocationCapacityBar } from './LocationCapacityBar'
import { LocationDiscardControl } from './LocationDiscardControl'
import { LocationModeChoices, LocationModeTrigger } from './LocationModeSelector'
import {
  type LocationMode,
  locationModeChoice,
  modeBlockedReasons,
  modeRequiresConfirmation,
  resolveLocationMode,
} from './location-mode'
import { useStorageLocationFacts } from './use-storage-location-facts'

export function StorageLocationLead({ row }: { readonly row: InstanceRow }): ReactElement | null {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const queryClient = useQueryClient()
  const facts = useStorageLocationFacts()
  const [choicesOpen, setChoicesOpen] = useState(false)
  const update = useIntegrationInstancesUpdateInstance({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [HOLDER_QUERY_KEY] })
      void queryClient.invalidateQueries({ queryKey: [['storage', 'listLocations']] })
      setChoicesOpen(false)
    },
    onError: (err) =>
      pushToast({
        title: t('system.storage.modeFailed', 'Could not change the state'),
        message: `${row.name}: ${err.message}`,
        severity: 'critical',
      }),
  })
  const location = facts.locations.find((l) => l.id === row.id)
  if (location === undefined) return null
  const siblings = facts.locations.filter((l) => l.type === location.type)
  const mode = resolveLocationMode(location)
  const drain = facts.drainOf(location)

  const setMode = async (next: LocationMode): Promise<void> => {
    if (modeRequiresConfirmation(next)) {
      const ok = await confirm({
        title: t('system.storage.disable', 'Disable "{{displayName}}"?', {
          displayName: location.displayName,
        }),
        message: t(
          'system.storage.nothingIsDeletedSetThe',
          '{{consequence}} Nothing is deleted — set the location back to Read-only or Active to bring its footage back.',
          { consequence: locationModeChoice(next).consequence },
        ),
        confirmLabel: t('common.disable', 'Disable'),
        variant: 'danger',
      })
      if (!ok) return
    }
    update.mutate({ addonId: row.addonId, id: row.id, values: { mode: next } })
  }

  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border border-border bg-surface p-3">
      <div className="min-w-0 flex-1 basis-60">
        <LocationCapacityBar
          location={location}
          ownedBytes={facts.ownedBytesById.get(location.id) ?? null}
        />
        {drain.kind !== 'idle' && <DrainProgressLine drain={drain} />}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <LocationDiscardControl location={location} siblings={siblings} />
        <LocationModeTrigger
          mode={mode}
          open={choicesOpen}
          onToggle={() => setChoicesOpen((open) => !open)}
        />
      </div>
      {choicesOpen && (
        <LocationModeChoices
          mode={mode}
          blockedReasons={modeBlockedReasons(location, siblings)}
          onSelect={(next) => void setMode(next)}
          onDismiss={() => setChoicesOpen(false)}
        />
      )}
    </div>
  )
}
