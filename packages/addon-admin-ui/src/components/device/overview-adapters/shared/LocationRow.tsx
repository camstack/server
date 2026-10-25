/**
 * Location row with autocomplete combobox. Click to expand → input
 * with suggestions from `deviceManager.listLocations`. Allows
 * selecting an existing label OR typing a new one (no separate
 * "create" call — `setLocation` with a brand-new string IS the
 * create). Empty string → clear (`null`).
 */
import { useState, useEffect, useRef, useMemo } from 'react'
import { Check, X, Pencil, MapPin } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useDeviceManagerListLocations, useDeviceManagerSetLocation } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import { InfoRow } from './overview-primitives'

export function LocationRow({
  deviceId,
  initialLocation,
  label = 'Location',
  layout = 'inline',
  onError,
  onSaved,
  onCancel,
  bound,
}: {
  readonly deviceId: number
  readonly initialLocation: string | null
  /** The row's label; the Overview keeps the English default. */
  readonly label?: string
  /** Forwarded to `InfoRow` — Customize IdentityRow uses `stacked`. */
  readonly layout?: 'inline' | 'stacked'
  /** Told the owner's refusal when a save fails; absent = the row keeps editing open silently (Overview). */
  readonly onError?: (message: string) => void
  /** Told when an edit ends without a refusal: saved, or nothing to save. */
  readonly onSaved?: () => void
  /** Told when the operator abandons the edit. */
  readonly onCancel?: () => void
  /** Modal draft: edits wait for the modal's one Save. */
  readonly bound?: {
    readonly value: string
    readonly onChange: (value: string) => void
  }
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(initialLocation ?? '')
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Pre-fetch the existing location list so the popover renders without a flash.
  const { data } = useDeviceManagerListLocations(undefined, {
    enabled: editing || bound !== undefined,
  })
  const locations: readonly string[] = (data as readonly string[] | undefined) ?? []

  useEffect(() => {
    if (!editing) setDraft(initialLocation ?? '')
  }, [initialLocation, editing])

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const setLocationMutation = useDeviceManagerSetLocation({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [['deviceManager', 'getDevice']] })
      void queryClient.invalidateQueries({ queryKey: [['deviceManager', 'listAll']] })
      void queryClient.invalidateQueries({ queryKey: [['deviceManager', 'getDeviceAggregate']] })
      void queryClient.invalidateQueries({ queryKey: [['deviceManager', 'listLocations']] })
    },
  })

  // Filter suggestions by what the operator's typed (case-insensitive
  // substring). Existing labels that already match exactly aren't
  // re-suggested.
  const filtered = useMemo(() => {
    const q = draft.trim().toLowerCase()
    if (q.length === 0) return locations
    return locations.filter((l) => l.toLowerCase() !== q && l.toLowerCase().includes(q))
  }, [locations, draft])

  const isNew =
    draft.trim().length > 0 &&
    !locations.some((l) => l.toLowerCase() === draft.trim().toLowerCase())

  const commit = async (override?: string) => {
    const raw = override ?? draft
    const trimmed = raw.trim()
    const next = trimmed.length === 0 ? null : trimmed
    if (next === (initialLocation ?? null)) {
      setEditing(false)
      onSaved?.()
      return
    }
    setSaving(true)
    try {
      await setLocationMutation.mutateAsync({ deviceId, location: next })
      setEditing(false)
      onSaved?.()
    } catch (err: unknown) {
      // Keep editing open for retry; say why.
      onError?.(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const cancel = () => {
    setDraft(initialLocation ?? '')
    setEditing(false)
    onCancel?.()
  }

  if (bound !== undefined) {
    const query = bound.value.trim().toLowerCase()
    const suggestions =
      query.length === 0
        ? []
        : locations.filter(
            (loc) => loc.toLowerCase() !== query && loc.toLowerCase().includes(query),
          )
    return (
      <InfoRow
        label={label}
        layout={layout}
        value={
          <div className="relative">
            <input
              type="text"
              value={bound.value}
              aria-label={label}
              onChange={(e) => bound.onChange(e.target.value)}
              placeholder={t(
                'shared.locationRow.roomAreaOrLeaveEmpty',
                'Room / area (or leave empty to clear)',
              )}
              className="flex-1 min-w-0 w-full px-1.5 py-0.5 text-[11px] bg-background border border-border rounded focus:outline-none focus:border-primary"
            />
            {suggestions.length > 0 && (
              <div className="absolute z-10 left-0 right-0 mt-0.5 max-h-40 overflow-y-auto rounded-md border border-border bg-surface shadow-md">
                {suggestions.map((loc) => (
                  // ui-check-ok: suggestion row, same control as the inline location editor
                  <button
                    key={loc}
                    type="button"
                    onClick={() => bound.onChange(loc)}
                    className="w-full flex items-center gap-2 px-2 py-1 text-left text-[11px] hover:bg-surface-hover"
                  >
                    <MapPin className="h-3 w-3 text-foreground-subtle flex-shrink-0" />
                    <span className="truncate">{loc}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        }
      />
    )
  }

  if (!editing) {
    return (
      <InfoRow
        label={label}
        layout={layout}
        value={
          <div className="flex items-center gap-2 group">
            {initialLocation ? (
              <span className="truncate">{initialLocation}</span>
            ) : (
              <span className="italic text-foreground-subtle">{t('common.unset')}</span>
            )}
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="p-0.5 rounded text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
              aria-label={t('inlineEdit.editLocation')}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </div>
        }
      />
    )
  }

  return (
    <InfoRow
      label={label}
      layout={layout}
      value={
        <div className="relative">
          <div className="flex items-center gap-1">
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commit()
                else if (e.key === 'Escape') cancel()
              }}
              disabled={saving}
              placeholder={t(
                'shared.locationRow.roomAreaOrLeaveEmpty',
                'Room / area (or leave empty to clear)',
              )}
              className="flex-1 min-w-0 px-1.5 py-0.5 text-[11px] bg-background border border-border rounded focus:outline-none focus:border-primary"
            />
            <button
              type="button"
              onClick={() => void commit()}
              disabled={saving}
              className="p-0.5 rounded hover:bg-success/10 text-success disabled:opacity-50"
              aria-label={t('inlineEdit.save')}
            >
              <Check className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={saving}
              className="p-0.5 rounded hover:bg-danger/10 text-danger disabled:opacity-50"
              aria-label={t('inlineEdit.cancel')}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          {(filtered.length > 0 || isNew) && (
            <div className="absolute z-10 left-0 right-0 mt-0.5 max-h-40 overflow-y-auto rounded-md border border-border bg-surface shadow-md">
              {filtered.map((loc) => (
                <button
                  key={loc}
                  type="button"
                  onClick={() => {
                    setDraft(loc)
                    void commit(loc)
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1 text-left text-[11px] hover:bg-surface-hover"
                >
                  <MapPin className="h-3 w-3 text-foreground-subtle flex-shrink-0" />
                  <span className="truncate">{loc}</span>
                </button>
              ))}
              {isNew && (
                <button
                  type="button"
                  onClick={() => void commit()}
                  className="w-full flex items-center gap-2 px-2 py-1 text-left text-[11px] hover:bg-surface-hover border-t border-border"
                >
                  <span className="text-foreground-subtle">
                    {t('shared.locationRow.create', 'Create')}
                  </span>
                  <span className="font-medium truncate">"{draft.trim()}"</span>
                </button>
              )}
            </div>
          )}
        </div>
      }
    />
  )
}
