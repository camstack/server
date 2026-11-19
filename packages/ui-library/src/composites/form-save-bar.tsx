import { type JSX } from 'react'
import { useUiText } from '../contexts/ui-text'
import { Button } from '../primitives/button'

/**
 * FormSaveBar — the sticky Save / Discard bar of every form that saves on
 * request. Callers own the save routing; this renders the bar and the
 * pending-changes count, and hides itself at zero.
 *
 * The bar sits over scrolled content (a modal body, a long form), so its
 * background is an OPAQUE surface token: a tinted, see-through fill lets the
 * rows underneath show through. The primary tint is the border only.
 *
 *   <div className="... overflow-y-auto">   // scroll parent the bar sticks to
 *     <FormBuilder ... />
 *     <FormSaveBar pendingCount={dirtyCount} onSave={flush} onDiscard={reset} saving={busy} />
 *   </div>
 */
export interface FormSaveBarProps {
  /** How many changes are pending. At 0 the bar hides itself. */
  readonly pendingCount: number
  readonly onSave: () => void
  /** Resets the local edits without touching the server. */
  readonly onDiscard: () => void
  /** Disables both buttons while a save is in flight and shows "Saving…". */
  readonly saving?: boolean
  /** Override for the save label (e.g. "Apply"). */
  readonly saveLabel?: string
  /** Override for the discard label. */
  readonly discardLabel?: string
}

export function FormSaveBar({
  pendingCount,
  onSave,
  onDiscard,
  saving = false,
  saveLabel,
  discardLabel,
}: FormSaveBarProps): JSX.Element | null {
  const t = useUiText()
  if (pendingCount <= 0) return null

  return (
    <div className="sticky bottom-0 z-10 -mb-3 flex items-center justify-between gap-3 rounded-lg border border-primary/40 bg-surface px-3 py-2 shadow-sm">
      <span className="text-xs text-foreground">
        {t(
          'uiLibrary.formSaveBar.unsavedChanges',
          { one: '{{count}} unsaved change', other: '{{count}} unsaved changes' },
          { count: pendingCount },
        )}
      </span>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" type="button" onClick={onDiscard} disabled={saving}>
          {discardLabel ?? t('uiLibrary.formSaveBar.discard', 'Discard')}
        </Button>
        <Button variant="primary" size="sm" type="button" onClick={onSave} disabled={saving}>
          {saving
            ? t('uiLibrary.formSaveBar.saving', 'Saving…')
            : (saveLabel ?? t('uiLibrary.formSaveBar.save', 'Save'))}
        </Button>
      </div>
    </div>
  )
}
