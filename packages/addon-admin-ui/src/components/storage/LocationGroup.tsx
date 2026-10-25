/**
 * `LocationGroup` — section listing every registered `StorageLocation` of a
 * given declared location (`type === declaration.id`).
 *
 * The Storage page renders one of these per declaration so operators
 * see every declared location up-front (even when no instances are
 * registered yet — empty groups still render the header + Add button
 * so a missing location is obvious). The group's `cardinality` comes
 * straight from the addon declaration — `'single'` hides the Add
 * button (one instance only), `'multi'` shows it.
 *
 * Chrome is `SectionCard`. Rows stay as `LocationCard` (typed stack —
 * mode / capacity / drain / protection do not fit a DataTable cleanly).
 *
 * Enabled locations (writes) first, then standby, then by displayName.
 */

import type { StorageLocation, StorageLocationDeclaration } from '@camstack/types'
import { Button, SECTION_BODY, SectionCard } from '@camstack/ui-library'
import { HardDrive, Plus } from 'lucide-react'
import { useMemo } from 'react'
import { type DrainProgressRow, describeDrain, isLocationDraining } from './drain-progress'
import { LocationCard } from './LocationCard'
import { locationDeletable } from './location-enabled'
import {
  type LocationMode,
  modeAcceptsWrites,
  modeBlockedReasons,
  resolveLocationMode,
} from './location-mode'
import { useTranslation } from 'react-i18next'

export interface LocationGroupProps {
  /** Declared location id (`StorageLocationDeclaration.id`). */
  readonly type: string
  readonly displayName: string
  readonly description?: string
  readonly cardinality: StorageLocationDeclaration['cardinality']
  readonly locations: readonly StorageLocation[]
  readonly onAdd: (type: string) => void
  readonly onEdit: (location: StorageLocation) => void
  readonly onDelete: (location: StorageLocation) => void
  /** Move one location to another state; confirming `disabled` is the caller's job. */
  readonly onSetMode: (location: StorageLocation, next: LocationMode) => void
  /**
   * Measured CamStack usage per location id. A location missing from the map
   * has no measured figure and its share segment is omitted.
   */
  readonly ownedBytesById?: ReadonlyMap<string, number>
  /** Drain progress per location id, for the ones set to drain. */
  readonly drainById?: ReadonlyMap<string, DrainProgressRow>
}

export function LocationGroup({
  type,
  displayName,
  description,
  cardinality,
  locations,
  onAdd,
  onEdit,
  onDelete,
  onSetMode,
  ownedBytesById,
  drainById,
}: LocationGroupProps) {
  const { t } = useTranslation()
  const sorted = useMemo<readonly StorageLocation[]>(() => {
    const copy: StorageLocation[] = [...locations]
    copy.sort((a, b) => {
      const aOn = modeAcceptsWrites(resolveLocationMode(a))
      const bOn = modeAcceptsWrites(resolveLocationMode(b))
      if (aOn !== bOn) return aOn ? -1 : 1
      return a.displayName.localeCompare(b.displayName)
    })
    return copy
  }, [locations])

  return (
    <SectionCard
      headingId={`storage-location-${type}`}
      title={displayName}
      icon={HardDrive}
      testId={`storage-location-group-${type}`}
      actions={
        cardinality === 'multi' ? (
          <Button size="sm" type="button" onClick={() => onAdd(type)}>
            <Plus className="h-3 w-3" />
            {t('common.add', 'Add')}
          </Button>
        ) : undefined
      }
    >
      <div className={`${SECTION_BODY} space-y-2`}>
        <div className="space-y-0.5">
          <span className="text-[10px] uppercase tracking-wide text-foreground-subtle bg-background border border-border rounded px-1.5 py-0.5 font-mono">
            {type}
          </span>
          {description !== undefined && description !== '' && (
            <p className="text-[11px] leading-relaxed text-foreground-subtle">{description}</p>
          )}
          {cardinality === 'single' && (
            <p className="text-[10px] text-foreground-subtle italic">
              {t(
                'storage.locationGroup.singleOneLocationPerType',
                "Single — one location per type. Edit the existing entry; it can't be split.",
              )}
            </p>
          )}
        </div>
        {sorted.length === 0 && (
          <div className="py-2 text-center text-[11px] text-foreground-subtle italic">
            {cardinality === 'multi'
              ? t(
                  'storage.locationGroup.noLocationRegisteredClickAdd',
                  'No location registered. Click "Add" to register one.',
                )
              : t(
                  'storage.locationGroup.noLocationRegisteredYetShould',
                  'No location registered yet — should be auto-seeded at next boot.',
                )}
          </div>
        )}
      </div>
      {sorted.length > 0 && (
        <div className="border-t border-border">
          {sorted.map((loc) => (
            <LocationCard
              key={loc.id}
              location={loc}
              cardinality={cardinality}
              canDelete={locationDeletable(loc, sorted, cardinality)}
              onEdit={onEdit}
              onDelete={onDelete}
              onSetMode={onSetMode}
              blockedReasons={modeBlockedReasons(loc, sorted)}
              ownedBytes={ownedBytesById?.get(loc.id) ?? null}
              drain={describeDrain(isLocationDraining(loc), drainById?.get(loc.id))}
              siblings={sorted}
            />
          ))}
        </div>
      )}
    </SectionCard>
  )
}
