/**
 * Inline-editable Name row for the Device Info card. Click the label →
 * input + save/cancel. Persists via `deviceManager.setName`. Optimistic
 * UX with rollback on mutation failure.
 */
import { useState, useEffect, useRef } from 'react'
import { Check, X, Pencil } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useDeviceManagerSetName } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import { InfoRow } from './overview-primitives'

export function EditableNameRow({
  deviceId,
  initialName,
  label = 'Name',
  layout = 'inline',
  onError,
  onSaved,
  onCancel,
  bound,
}: {
  readonly deviceId: number
  readonly initialName: string
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
  /**
   * Modal draft: the row shows the field and reports edits. The modal's
   * one Save persists them. Absent = the row saves itself.
   */
  readonly bound?: {
    readonly value: string
    readonly onChange: (value: string) => void
  }
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(initialName)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset draft whenever the underlying name changes externally
  useEffect(() => {
    if (!editing) setDraft(initialName)
  }, [initialName, editing])

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const setNameMutation = useDeviceManagerSetName({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [['deviceManager', 'getDevice']] })
      void queryClient.invalidateQueries({ queryKey: [['deviceManager', 'listAll']] })
      void queryClient.invalidateQueries({ queryKey: [['deviceManager', 'getDeviceAggregate']] })
    },
  })

  const commit = async () => {
    const trimmed = draft.trim()
    if (trimmed.length === 0 || trimmed === initialName) {
      setEditing(false)
      setDraft(initialName)
      onSaved?.()
      return
    }
    setSaving(true)
    try {
      await setNameMutation.mutateAsync({ deviceId, name: trimmed })
      setEditing(false)
      onSaved?.()
    } catch (err: unknown) {
      // Keep editing open so the operator can retry without retyping; say why.
      onError?.(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const cancel = () => {
    setDraft(initialName)
    setEditing(false)
    onCancel?.()
  }

  if (bound !== undefined) {
    return (
      <InfoRow
        label={label}
        layout={layout}
        value={
          <input
            type="text"
            value={bound.value}
            aria-label={label}
            onChange={(e) => bound.onChange(e.target.value)}
            className="flex-1 min-w-0 w-full px-1.5 py-0.5 text-[11px] bg-background border border-border rounded focus:outline-none focus:border-primary"
          />
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
            <span className="truncate">{initialName}</span>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="p-0.5 rounded text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
              aria-label={t('inlineEdit.editName')}
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
      }
    />
  )
}
