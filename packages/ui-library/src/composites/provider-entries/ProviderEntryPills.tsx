/**
 * ProviderEntryPills — one pill per credential entry (never a bare type).
 *
 * Visual language echoes the admin IntegrationHub strip: icon + name + status
 * dot, wrapping at every width. Selection is a button callback — the host
 * owns the URL (`?entry=`). Add is optional; when present it is a dashed
 * trailing control that opens the host's create dialog.
 */
import { Plus } from 'lucide-react'
import type { JSX } from 'react'

import { cn } from '../../lib/cn'
import { CHIP_ACTIVE, CHIP_BASE, CHIP_INACTIVE } from '../../lib/responsive'
import { useUiText } from '../../contexts/ui-text'

export type ProviderEntryStatus = 'ok' | 'warning' | 'error' | 'unknown'

export interface ProviderEntryPill {
  readonly entryId: string
  readonly name: string
  readonly typeId: string
  readonly iconUrl: string | null
  readonly status: ProviderEntryStatus
}

export interface ProviderEntryPillsProps {
  /** Names the strip for assistive tech ("Training providers"). */
  readonly label: string
  readonly entries: readonly ProviderEntryPill[]
  readonly selectedEntryId: string | null
  readonly onSelect: (entryId: string) => void
  readonly onAdd?: () => void
  readonly addLabel?: string
}

const PILL_BASE = cn(
  CHIP_BASE,
  'min-w-0 max-w-full gap-1.5 py-1 pl-1 pr-2.5 text-xs font-normal',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
)

const PILL_CURRENT = cn(CHIP_ACTIVE, 'font-medium')
const PILL_OTHER = CHIP_INACTIVE

const STATE_DOT: Record<ProviderEntryStatus, string> = {
  ok: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-danger',
  unknown: 'border border-foreground-subtle bg-transparent',
}

const STATE_LABEL: Record<
  ProviderEntryStatus,
  { readonly key: string; readonly fallback: string }
> = {
  ok: { key: 'uiLibrary.providerEntryPills.status.ok', fallback: 'OK' },
  warning: { key: 'uiLibrary.providerEntryPills.status.warning', fallback: 'Warning' },
  error: { key: 'uiLibrary.providerEntryPills.status.error', fallback: 'Error' },
  unknown: { key: 'uiLibrary.providerEntryPills.status.unknown', fallback: 'Unknown' },
}

export function ProviderEntryPills({
  label,
  entries,
  selectedEntryId,
  onSelect,
  onAdd,
  addLabel: addLabelProp,
}: ProviderEntryPillsProps): JSX.Element {
  const t = useUiText()
  const addLabel = addLabelProp ?? t('uiLibrary.providerEntryPills.addProvider', 'Add provider')
  return (
    <nav aria-label={label} className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {entries.map((entry) => (
          <EntryPill
            key={entry.entryId}
            entry={entry}
            current={entry.entryId === selectedEntryId}
            onSelect={onSelect}
          />
        ))}
        {onAdd !== undefined && (
          <button // ui-check-ok: CHIP_* dashed add pill; Button chrome breaks the strip
            type="button"
            onClick={onAdd}
            className={cn(
              PILL_BASE,
              'border-dashed border-border pl-2 text-foreground-subtle',
              'hover:border-primary/50 hover:text-foreground',
            )}
          >
            <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">{addLabel}</span>
          </button>
        )}
      </div>
    </nav>
  )
}

function EntryPill({
  entry,
  current,
  onSelect,
}: {
  readonly entry: ProviderEntryPill
  readonly current: boolean
  readonly onSelect: (entryId: string) => void
}): JSX.Element {
  const t = useUiText()
  const quiet = entry.status === 'ok'
  return (
    <button // ui-check-ok: CHIP_* entry pill (IntegrationHub strip pattern)
      type="button"
      aria-current={current ? 'true' : undefined}
      data-testid={`provider-entry-pill-${entry.entryId}`}
      onClick={() => onSelect(entry.entryId)}
      className={cn(PILL_BASE, current ? PILL_CURRENT : PILL_OTHER)}
    >
      <EntryIcon url={entry.iconUrl} />
      <span className="truncate">{entry.name}</span>
      <span
        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATE_DOT[entry.status])}
        aria-hidden
      />
      <span
        className={quiet ? 'sr-only' : 'shrink-0 text-[10px] font-normal text-foreground-subtle'}
      >
        {t(STATE_LABEL[entry.status].key, STATE_LABEL[entry.status].fallback)}
      </span>
    </button>
  )
}

function EntryIcon({ url }: { readonly url: string | null }): JSX.Element {
  if (url === null) {
    return (
      <span
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface text-[9px] text-foreground-subtle"
        aria-hidden
      >
        ?
      </span>
    )
  }
  return <img src={url} alt="" className="h-5 w-5 shrink-0 rounded-full object-contain" />
}
