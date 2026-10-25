/**
 * SettingsPanel — shared visual shell for every editable configuration
 * section in the Pipeline page. One layout rules them all: a title +
 * optional description on top-left, Save + (optional) Reset buttons
 * on top-right, and the caller's form rendered underneath.
 *
 * Consumed by:
 *  - `OrchestratorSettingsEditor` (global orchestrator sections)
 *  - any future capability-binding editors that want the same chrome.
 *
 * Rules:
 *  - Save button is always visible. Disabled when `!dirty || isSaving`.
 *  - Reset button is visible only if `onReset` is passed. Disabled when
 *    `!canReset || isSaving` so the affordance disappears gracefully
 *    when there's nothing to reset.
 *  - The panel is pure presentation — the caller owns the form state,
 *    mutations, and dirty tracking.
 */
import type { ReactNode } from 'react'
import { Save, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export interface SettingsPanelProps {
  readonly title?: string
  readonly description?: ReactNode
  readonly dirty: boolean
  readonly isSaving?: boolean
  readonly onSave: () => void
  /** When provided, renders a Reset button. */
  readonly onReset?: () => void
  /** Controls whether the Reset button is enabled. Ignored when `onReset` is not set. */
  readonly canReset?: boolean
  /** Label for the reset button (e.g. "Reset defaults", "Reset to Global"). */
  readonly resetLabel?: string
  readonly children: ReactNode
}

export function SettingsPanel({
  title,
  description,
  dirty,
  isSaving = false,
  onSave,
  onReset,
  canReset = true,
  resetLabel = 'Reset defaults',
  children,
}: SettingsPanelProps) {
  const { t } = useTranslation()
  return (
    <section className="space-y-3">
      <header className="flex items-start justify-between gap-4">
        {(title || description) && (
          <div className="min-w-0">
            {title && <h3 className="text-sm font-semibold text-foreground">{title}</h3>}
            {description && (
              <p className="text-[11px] text-foreground-subtle mt-0.5">{description}</p>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 shrink-0">
          {onReset && (
            <button
              type="button"
              onClick={onReset}
              disabled={!canReset || isSaving}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium text-foreground-subtle hover:text-foreground hover:bg-surface-hover border border-border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <RotateCcw className="h-3 w-3" />
              {resetLabel}
            </button>
          )}
          <button
            type="button"
            onClick={onSave}
            disabled={!dirty || isSaving}
            className="inline-flex items-center gap-1 rounded px-2.5 py-1 text-[10px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Save className="h-3 w-3" />
            {isSaving ? t('pipeline.settingsPanel.saving', 'Saving…') : t('common.save', 'Save')}
          </button>
        </div>
      </header>

      <div>{children}</div>
    </section>
  )
}
