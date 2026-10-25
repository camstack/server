import { useTranslation } from 'react-i18next'
/**
 * FormSaveBar — sticky-bottom Save/Discard bar for any FormBuilder-based
 * surface. Callers own the save routing (per-addon, device-batch, custom);
 * this component just renders the floating control + pending-changes count
 * consistently across NodeDetail, DeviceDetail, and any future aggregator.
 *
 * Usage:
 *   <div className="... overflow-y-auto">   // scroll parent the bar sticks to
 *     <FormBuilder ... />
 *     <FormSaveBar
 *       pendingCount={dirtyCount}
 *       onSave={() => flush()}
 *       onDiscard={() => reset()}
 *       saving={mutation.isPending}
 *     />
 *   </div>
 */

interface FormSaveBarProps {
  /** How many fields are pending. When 0 the bar hides itself. */
  readonly pendingCount: number
  /** Fires when the operator clicks Save. Implementer routes to the right
   *  mutation (per-addon, device-batch, etc). */
  readonly onSave: () => void
  /** Fires when the operator clicks Discard — implementer resets local
   *  edits without touching the server. */
  readonly onDiscard: () => void
  /** Disables both buttons while a save is in flight; the Save button
   *  shows "Saving…" instead of "Save". */
  readonly saving?: boolean
  /** Optional override for the save label (e.g. "Apply", "Run"). */
  readonly saveLabel?: string
  /** Optional override for the discard label. */
  readonly discardLabel?: string
}

export function FormSaveBar({
  pendingCount,
  onSave,
  onDiscard,
  saving = false,
  saveLabel = 'Save',
  discardLabel = 'Discard',
}: FormSaveBarProps) {
  const { t } = useTranslation()
  if (pendingCount <= 0) return null

  return (
    <div className="sticky bottom-0 -mb-3 flex items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 shadow-sm z-10">
      <span className="text-xs text-foreground">
        {t('formBuilder.saveBar.unsavedChanges', { count: pendingCount })}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onDiscard}
          disabled={saving}
          className="inline-flex items-center rounded-md border border-border px-2.5 py-1 text-xs text-foreground-subtle hover:bg-surface-hover disabled:opacity-50"
        >
          {discardLabel}
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="inline-flex items-center rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? t('formBuilder.formSaveBar.saving', 'Saving…') : saveLabel}
        </button>
      </div>
    </div>
  )
}
