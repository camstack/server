/**
 * `BrokerPicker` — pick an existing broker of one `kind`, or create one without
 * leaving the dialog that needs it. "Create new…" opens `BrokerEditorDialog`
 * stacked over the caller (the caller's state is untouched underneath); on
 * success the new broker is selected, on cancel nothing changes.
 *
 * It is the one broker-selection control: the integration wizard's broker step
 * and the Matter dialog both mount it. `kind` is data; the component names none.
 */
import { useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, ErrorBox, useBrokerList } from '@camstack/ui-library'
import type { UnifiedBrokerStatus } from '@camstack/types'
import { BrokerEditorDialog } from './BrokerEditorDialog'
import { asBrokerList } from './broker-kinds'

const STATUS_VARIANT: Record<UnifiedBrokerStatus, 'success' | 'warning' | 'default' | 'danger'> = {
  connected: 'success',
  connecting: 'warning',
  disconnected: 'default',
  'auth-failed': 'danger',
  unreachable: 'danger',
  // i18n-ignore: tone token, not display text
  error: 'danger',
}

export interface BrokerPickerProps {
  /** Broker kind to list and to create. */
  readonly kind: string
  /** Selected broker id, or null. */
  readonly value: string | null
  readonly onChange: (brokerId: string | null) => void
}

export function BrokerPicker({ kind, value, onChange }: BrokerPickerProps) {
  const { t } = useTranslation()
  const [creating, setCreating] = useState(false)
  const listQuery = useBrokerList({ kind })
  // Re-filter client side so a stale or unfiltered cache never leaks a foreign kind.
  const brokers = asBrokerList(listQuery.data).filter((b) => b.kind === kind)

  return (
    <div className="space-y-2">
      {listQuery.isLoading && (
        <div className="flex items-center gap-2 text-xs text-foreground-subtle">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('brokers.picker.loading')}
        </div>
      )}
      {listQuery.isError && (
        <ErrorBox
          message={t('brokers.picker.loadFailed', {
            message:
              listQuery.error instanceof Error ? listQuery.error.message : t('common.unknownError'),
          })}
        />
      )}
      {!listQuery.isLoading && !listQuery.isError && brokers.length === 0 && (
        <p className="rounded-lg border border-border bg-surface px-3 py-4 text-center text-xs text-foreground-subtle">
          {t('brokers.picker.none')}
        </p>
      )}
      {brokers.map((b) => (
        <button // ui-check-ok: a selectable card (aria-pressed), not an action button
          key={b.id}
          type="button"
          aria-pressed={value === b.id}
          onClick={() => onChange(b.id)}
          className={`flex w-full items-center justify-between gap-3 rounded-lg border bg-surface p-3 text-left transition-colors ${
            value === b.id
              ? 'border-primary ring-1 ring-primary'
              : 'border-border hover:border-foreground-subtle/30'
          }`}
        >
          <span className="text-xs font-semibold text-foreground">{b.name}</span>
          <Badge variant={STATUS_VARIANT[b.status]} className="text-[10px]">
            {b.status}
          </Badge>
        </button>
      ))}
      <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
        <Plus className="h-3.5 w-3.5" /> {t('brokers.picker.createNew')}
      </Button>
      {creating && (
        <BrokerEditorDialog
          kind={kind}
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false)
            onChange(id)
          }}
        />
      )}
    </div>
  )
}
