/**
 * `LocationCard` — single row inside `LocationGroup`.
 *
 * Typed declaration lists keep this card stack (documented exception to the
 * DataTable managed-list rule): each row owns mode, capacity, drain and
 * protection controls. Add/edit open state lives on the parent via
 * `useItemFormUrl`, not here.
 *
 * Renders a registered `StorageLocation`: provider chip, displayName, config
 * summary (today: `basePath`), the volume's capacity bar, the four-way state
 * selector (D385/D386 — it replaced the Enabled and Read-only switches, which
 * an operator had to multiply together to know what a disk was doing), plus
 * Edit / Delete.
 *
 * The card paints; every derivation lives in `location-capacity-bar.ts`,
 * `location-mode.ts`, `location-protection.ts` and `drain-progress.ts`.
 */

import type { StorageLocation, StorageLocationDeclaration } from '@camstack/types'
import { Pencil, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { DrainProgressLine } from './DrainProgressLine'
import type { DrainDisplay } from './drain-progress'
import { LocationCapacityBar } from './LocationCapacityBar'
import { LocationDiscardControl } from './LocationDiscardControl'
import { LocationModeChoices, LocationModeTrigger } from './LocationModeSelector'
import { type LocationMode, type LocationModeReasons, resolveLocationMode } from './location-mode'
import { useTranslation } from 'react-i18next'
import { Button } from '@camstack/ui-library'

export interface LocationCardProps {
  readonly location: StorageLocation
  /**
   * Cardinality of the location's declared type. `'single'` types
   * cannot be deleted (only one instance allowed; editing it is the
   * only operation). Passed down from `LocationGroup`, which gets it
   * from the addon declaration.
   */
  readonly cardinality: StorageLocationDeclaration['cardinality']
  readonly onEdit: (location: StorageLocation) => void
  readonly onDelete: (location: StorageLocation) => void
  /**
   * Move the location to another state. The whole location is handed back, not
   * its id: `upsertLocation` REPLACES the record, so the caller has to rebuild
   * it from the row it read (`toLocationUpsertInput`) or it silently drops
   * `nodeId`. Confirming `disabled` — the one state that hides footage — is the
   * caller's job (`modeRequiresConfirmation`).
   */
  readonly onSetMode: (location: StorageLocation, next: LocationMode) => void
  /** Per-mode refusal reasons from the group (the last-writable guard). */
  readonly blockedReasons: LocationModeReasons
  /** Policy from the group: unique / only-enabled / single-cardinality hide delete. */
  readonly canDelete: boolean
  /**
   * Other locations of the same type (the card's group). Needed so the
   * leftover-discard button only appears when a writable sibling still
   * exists — the last disk of a class is never wiped from here.
   */
  readonly siblings?: readonly StorageLocation[]
  /**
   * Bytes CamStack holds on this location's volume, when a measured figure
   * exists. Absent means the inner share segment is omitted — never zero.
   */
  readonly ownedBytes?: number | null
  /**
   * Derived drain state for this location — see `describeDrain`. Absent means
   * the group had nothing to derive from, and the card draws no drain line
   * rather than a fabricated one.
   */
  readonly drain?: DrainDisplay
}

function summarizeConfig(config: Readonly<Record<string, unknown>>): string {
  // Today every storage-provider lands `basePath` in its config (the
  // filesystem driver, plus the future SFTP/S3/WebDAV ones each emit
  // a `basePath` line as their headline summary). Render a short
  // compatible string when present, fall back to the raw key list
  // otherwise so unknown providers still show something useful.
  const basePath = config['basePath']
  if (typeof basePath === 'string' && basePath.length > 0) return basePath
  const keys = Object.keys(config)
  if (keys.length === 0) return ''
  return keys.join(', ')
}

export function LocationCard({
  location,
  onEdit,
  onDelete,
  onSetMode,
  blockedReasons,
  canDelete,
  siblings = [],
  drain,
  ownedBytes,
}: LocationCardProps) {
  const { t } = useTranslation()
  // The state choices are laid out BY THE CARD, full width under the row: as a
  // popover anchored to a button at the right edge they were clipped off a
  // phone viewport, unreadable and covering the rows below.
  const [modeOpen, setModeOpen] = useState<boolean>(false)
  const summary = summarizeConfig(location.config)
  const mode = resolveLocationMode(location)
  return (
    // Responsive: identity chips + actions WRAP on narrow viewports instead of
    // forcing a horizontal scroll on the whole page (operator ask, 2026-07-29).
    <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2 border-t border-border first:border-t-0 hover:bg-primary/5">
      <div className="flex items-start gap-2 min-w-0 flex-1 basis-72">
        {/* A FIXED slot, not an intrinsic one. The badge's text length varies
            with the data (`FILESYSTEM-STORAGE` is eighteen characters,
            `SMB-STORAGE` eleven), and the rest of the row follows it on the
            same flex line — so an SMB row began ~85 px left of its neighbours
            and its `w-full` bar ended short too, which read as a staircase
            rather than a scale (operator screenshot, 2026-09-10).

            The badge keeps its own size inside the slot: stretching a short
            one to eighteen characters draws a box mostly made of air. And the
            reservation is `sm:` only — on a phone the row wraps anyway, and
            128 px of label column is 40% of a 320 px viewport. */}
        <div className="shrink-0 sm:w-32" data-testid="location-badge-slot">
          <span className="inline-block text-[10px] uppercase tracking-wide text-foreground-subtle bg-background border border-border rounded px-1.5 py-0.5 font-mono">
            {location.providerId}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-foreground truncate">{location.displayName}</div>
          {summary && (
            <div className="text-[10px] text-foreground-subtle truncate font-mono">{summary}</div>
          )}
          {/* The bar gets its own line: sharing one with the path squeezed it
              into a corner and wrapped its numbers onto three lines. */}
          <LocationCapacityBar location={location} ownedBytes={ownedBytes ?? null} />
          {drain !== undefined && <DrainProgressLine drain={drain} />}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1 shrink-0">
        <LocationDiscardControl location={location} siblings={siblings} />
        <LocationModeTrigger
          mode={mode}
          open={modeOpen}
          onToggle={() => {
            setModeOpen((open) => !open)
          }}
        />
        <Button
          variant="unstyled"
          onClick={() => onEdit(location)}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium text-foreground-subtle border border-border hover:text-foreground hover:bg-primary/10"
        >
          <Pencil className="h-3 w-3" />
          {t('common.edit', 'Edit')}
        </Button>
        {canDelete && (
          <Button
            variant="unstyled"
            onClick={() => onDelete(location)}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium text-danger hover:bg-danger/10"
            title={t('storage.locationCard.deleteLocation', 'Delete location')}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        )}
      </div>
      {modeOpen && (
        <LocationModeChoices
          mode={mode}
          blockedReasons={blockedReasons}
          onSelect={(next) => onSetMode(location, next)}
          onDismiss={() => {
            setModeOpen(false)
          }}
        />
      )}
    </div>
  )
}
