/**
 * Removable selection chip + the search-box shell shared by DevicePicker and
 * SearchableMultiSelectField (admin-ui). Lives here so addon MFEs can render
 * the same picker without importing admin-ui.
 */
import { useUiText } from '../../contexts/ui-text'
import { X } from 'lucide-react'
import { EventKindGlyph } from '../event-kind-visuals.js'
import { type JSX } from 'react'

/** The search box's shell — shared with multiselect fields that mirror this picker. */
export const INPUT_SHELL =
  'flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1.5 focus-within:border-primary focus-within:ring-1 focus-within:ring-primary/30'

export interface SelectedChipProps {
  readonly label: string
  readonly onRemove?: () => void
  /** A selection the hub no longer has — drawn in warning colour. */
  readonly warning?: boolean
  readonly iconId?: string
  /** Brand / raster icon URL (e.g. notifier kind icon). */
  readonly iconUrl?: string
  readonly testId?: string
}

/** One selected entry as a removable chip. */
export function SelectedChip({
  label,
  onRemove,
  warning = false,
  iconId,
  iconUrl,
  testId,
}: SelectedChipProps): JSX.Element {
  const t = useUiText()
  return (
    <span
      data-testid={testId}
      className={
        warning
          ? 'inline-flex items-center gap-1 rounded-md bg-warning/10 px-1.5 py-0.5 text-[11px] text-warning max-w-full'
          : 'inline-flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary max-w-full'
      }
    >
      {iconUrl !== undefined ? (
        <img src={iconUrl} alt="" className="h-3 w-3 shrink-0 rounded-sm object-contain" />
      ) : iconId !== undefined ? (
        <EventKindGlyph iconId={iconId} size={12} />
      ) : null}
      <span className="truncate">{label}</span>
      {onRemove !== undefined && (
        <button
          type="button"
          className="shrink-0 hover:text-danger"
          aria-label={t('uiLibrary.selectedChip.remove', 'Remove {{label}}', { label })}
          onClick={onRemove}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  )
}
