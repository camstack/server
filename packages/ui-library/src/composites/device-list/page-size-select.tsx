/**
 * <PageSizeSelect> — the "Per page" control under a paginated list.
 *
 * One control for both list modes (the device table and the generic table),
 * so the two never drift in look or wording. `PAGE_SIZE_ALL` renders as "All".
 */
import { type ReactNode } from 'react'
import { defaultUiText, useUiText, type UiTextFn } from '../../contexts/ui-text'
import { PAGE_SIZE_ALL } from '../../hooks/use-persisted-page-size'

export interface PageSizeSelectProps {
  readonly value: number
  readonly options: readonly number[]
  readonly onChange: (size: number) => void
  /** Accessible name — names what is being paged ("Devices per page"). */
  readonly ariaLabel: string
}

export function pageSizeLabel(size: number, t: UiTextFn = defaultUiText): string {
  return size === PAGE_SIZE_ALL ? t('uiLibrary.pageSizeSelect.all', 'All') : String(size)
}

export function PageSizeSelect({
  value,
  options,
  onChange,
  ariaLabel,
}: PageSizeSelectProps): ReactNode {
  const t = useUiText()
  return (
    <div className="inline-flex items-center gap-1.5">
      <span aria-hidden="true">{t('uiLibrary.pageSizeSelect.perPage', 'Per page')}</span>
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(Number.parseInt(e.target.value, 10))}
        className="h-7 px-1.5 rounded-md border border-border bg-surface text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {pageSizeLabel(opt, t)}
          </option>
        ))}
      </select>
    </div>
  )
}
