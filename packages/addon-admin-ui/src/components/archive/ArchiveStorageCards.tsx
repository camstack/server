/**
 * Archive overview → storage cards, one per location: class, state (the typed
 * mode, D385), occupancy and who writes there. The detail — change state,
 * delete, drain progress — is the existing locations table, opened from the card.
 */
import type { StorageLocation } from '@camstack/types'
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  EmptyState,
} from '@camstack/ui-library'
import { HardDrive } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { DrainProgressLine } from '../storage/DrainProgressLine'
import { LocationCapacityBar } from '../storage/LocationCapacityBar'
import { StorageLocationsTable } from '../storage/StorageLocationsTable'
import {
  locationModeChoice,
  resolveLocationMode,
  type LocationMode,
} from '../storage/location-mode'
import { useStorageLocationFacts } from '../storage/use-storage-location-facts'

const MODE_VARIANT: Readonly<Record<LocationMode, 'success' | 'default' | 'warning' | 'danger'>> = {
  active: 'success',
  readonly: 'default',
  drain: 'warning',
  disabled: 'danger',
}

export function ArchiveStorageCards(): ReactElement {
  const { t } = useTranslation()
  const facts = useStorageLocationFacts()
  const [opened, setOpened] = useState<StorageLocation | null>(null)

  if (facts.locations.length === 0) {
    return (
      <EmptyState
        icon={HardDrive}
        title={t('archive.storage.none', 'No storage locations')}
        description={t(
          'archive.storage.noneHint',
          'Add a location to start storing footage and events.',
        )}
      />
    )
  }

  return (
    <>
      <div
        className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3"
        data-testid="archive-storage-cards"
      >
        {facts.locations.map((location) => {
          const mode = resolveLocationMode(location)
          return (
            <div
              key={location.id}
              className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">
                    {location.displayName}
                  </div>
                  <div className="text-[11px] text-foreground-subtle">
                    {location.type}
                    {location.nodeId === undefined ? '' : ` · ${location.nodeId}`}
                  </div>
                </div>
                <Badge variant={MODE_VARIANT[mode]}>{locationModeChoice(mode).label}</Badge>
              </div>
              <LocationCapacityBar
                location={location}
                ownedBytes={facts.ownedBytesById.get(location.id) ?? null}
              />
              <DrainProgressLine drain={facts.drainOf(location)} />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-foreground-subtle">
                  {mode === 'active'
                    ? t('archive.storage.writing', 'Taking new writes')
                    : t('archive.storage.notWriting', 'Not taking new writes')}
                </span>
                <Button variant="ghost" onClick={() => setOpened(location)}>
                  {t('archive.storage.manage', 'Manage')}
                </Button>
              </div>
            </div>
          )
        })}
      </div>
      {opened !== null && (
        <Dialog open onOpenChange={(next) => !next && setOpened(null)}>
          <DialogContent width="xl" placement="sheet-on-mobile" scroll="body">
            <DialogHeader>
              <DialogTitle>{opened.displayName}</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <StorageLocationsTable kinds={[opened.type]} />
            </DialogBody>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
