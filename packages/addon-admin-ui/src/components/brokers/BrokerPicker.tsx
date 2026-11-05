/**
 * `BrokerPicker` — pick an existing broker of one `kind`, or create one without
 * leaving the dialog that needs it. "Create new…" opens `InstanceCreateDialog`
 * stacked over the caller (the caller's state is untouched underneath); on
 * success the new broker is selected, on cancel nothing changes.
 *
 * It is the one broker-selection control: the integration wizard's broker step
 * and the Matter dialog both mount it. `kind` is data; the component names none.
 */
import { useEffect, useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  ErrorBox,
  useBrokerInstances,
  type BrokerInstance,
} from '@camstack/ui-library'
import { InstanceCreateDialog } from '../instances/InstanceCreateDialog'

const STATE_VARIANT: Record<BrokerInstance['state'], 'success' | 'default' | 'danger'> = {
  ok: 'success',
  off: 'default',
  unknown: 'default',
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
  const listQuery = useBrokerInstances({ kind })
  const brokers = listQuery.data ?? []

  // Nothing chosen yet: pre-select the first broker of the kind, but only once
  // the list ANSWERED — still loading or failed must never read as "no broker".
  const firstId = brokers[0]?.id ?? null
  const answered = !listQuery.isLoading && !listQuery.isError && listQuery.data !== undefined
  useEffect(() => {
    if (answered && value === null && firstId !== null) onChange(firstId)
  }, [answered, value, firstId, onChange])

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
            message: listQuery.error?.message ?? t('common.unknownError'),
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
          <Badge variant={STATE_VARIANT[b.state]} className="text-[10px]">
            {b.stateLabel ?? b.state}
          </Badge>
        </button>
      ))}
      <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
        <Plus className="h-3.5 w-3.5" /> {t('brokers.picker.createNew')}
      </Button>
      {creating && (
        <InstanceCreateDialog
          functionCap="broker"
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
