/**
 * Discard-leftovers control on a frozen location row.
 *
 * The start RPC returns immediately; this polls status every 2 s so the
 * browser never sits on the 60 s UDS deadline. High/mid on the same
 * volume are not a code path — the server wipe only names the class
 * subtree.
 *
 * Renders nothing when the row is not eligible, so LocationCard tests
 * that omit siblings do not need to mock `addons.custom`.
 */

import type { StorageLocation } from '@camstack/types'
import { useAddonsCustom, useConfirm } from '@camstack/ui-library'
import { Eraser, Loader2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  DISCARD_CANCEL_ACTION,
  DISCARD_START_ACTION,
  DISCARD_STATUS_ACTION,
  type DiscardStatus,
  discardAddonForType,
  discardEligible,
  discardProgressPct,
  parseDiscardStatus,
} from './location-discard'
import { useTranslation } from 'react-i18next'

const POLL_MS = 2_000

export interface LocationDiscardControlProps {
  readonly location: StorageLocation
  readonly siblings: readonly StorageLocation[]
}

export function LocationDiscardControl({ location, siblings }: LocationDiscardControlProps) {
  if (!discardEligible(location, siblings)) return null
  return <ArmedDiscard location={location} />
}

function ArmedDiscard({ location }: { readonly location: StorageLocation }) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const custom = useAddonsCustom()
  const addonId = discardAddonForType(location.type)
  const [status, setStatus] = useState<DiscardStatus | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    if (addonId === null) return
    let cancelled = false
    const tick = async (): Promise<void> => {
      try {
        const raw = await custom.mutateAsync({
          addonId,
          action: DISCARD_STATUS_ACTION,
          input: {},
        })
        if (cancelled) return
        setStatus(parseDiscardStatus(raw))
      } catch {
        /* a status poll that fails is retried; the last snapshot stays */
      }
    }
    void tick()
    const id = setInterval(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
    // Poll is keyed on the addon + location, not on the mutation object.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [addonId, location.id])

  if (addonId === null) return null

  const mine = status !== null && status.locationId === location.id
  const running = mine && status.running
  const showBar = mine && status.phase !== 'idle'

  const start = async (): Promise<void> => {
    const ok = await confirm({
      title: t(
        'storage.locationDiscardControl.discardLeftoversOn',
        'Discard leftovers on "{{displayName}}"?',
        { displayName: location.displayName },
      ),
      message: t(
        'storage.locationDiscardControl.permanentlyDeletesLeftoverFilesAnd',
        'Permanently deletes leftover files and records on this location. Other locations are not affected. This cannot be undone and may take hours.',
      ),
      confirmLabel: t('storage.locationDiscardControl.discardLeftovers', 'Discard leftovers'),
      variant: 'danger',
    })
    if (!ok) return
    setActionError(null)
    setStarting(true)
    try {
      await custom.mutateAsync({
        addonId,
        action: DISCARD_START_ACTION,
        input: { locationId: location.id },
      })
      const raw = await custom.mutateAsync({
        addonId,
        action: DISCARD_STATUS_ACTION,
        input: {},
      })
      setStatus(parseDiscardStatus(raw))
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  const cancel = async (): Promise<void> => {
    try {
      await custom.mutateAsync({
        addonId,
        action: DISCARD_CANCEL_ACTION,
        input: {},
      })
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex flex-col gap-1 min-w-[9rem] max-w-[16rem]">
      {running ? (
        <button
          type="button"
          onClick={() => void cancel()}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium text-danger border border-danger/40 hover:bg-danger/10"
        >
          <X className="h-3 w-3" />
          {t('common.cancel', 'Cancel')}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void start()}
          disabled={starting}
          title={t(
            'storage.locationDiscardControl.permanentlyDeleteLeftoverFilesOn',
            'Permanently delete leftover files on this location. Other locations are not affected.',
          )}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium text-danger border border-danger/40 hover:bg-danger/10 disabled:opacity-50"
        >
          {starting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eraser className="h-3 w-3" />}
          {t('storage.locationDiscardControl.discardLeftovers', 'Discard leftovers')}
        </button>
      )}
      {showBar && status !== null && (
        <div className="space-y-0.5">
          <div className="h-1 rounded bg-border overflow-hidden">
            <div
              className="h-full bg-primary transition-[width] duration-300"
              style={{ width: `${discardProgressPct(status)}%` }}
            />
          </div>
          <p className="text-[10px] text-foreground-subtle leading-tight">
            {status.phase}
            {status.camerasTotal > 0
              ? ` · ${t('storage.locationDiscardControl.camsProgress', { done: status.camerasDone, total: status.camerasTotal })}`
              : ''}
            {status.dbRowsDeleted > 0
              ? ` · ${t('storage.locationDiscardControl.rowsDeleted', { count: status.dbRowsDeleted })}`
              : ''}
            {status.detail ? ` · ${status.detail}` : ''}
          </p>
        </div>
      )}
      {(actionError || (mine && status?.error)) && (
        <p className="text-[10px] text-danger leading-tight">{actionError ?? status?.error}</p>
      )}
    </div>
  )
}
