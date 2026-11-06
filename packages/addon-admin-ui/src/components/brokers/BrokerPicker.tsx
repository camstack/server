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
  selectableBrokers,
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
  /** An optional link: nothing is pre-selected and an empty choice clears the pick. */
  readonly optional?: boolean
  /** The words of the empty choice of an optional link, already translated. */
  readonly noneLabel?: string
  readonly disabled?: boolean
}

export function BrokerPicker({
  kind,
  value,
  onChange,
  optional = false,
  noneLabel,
  disabled = false,
}: BrokerPickerProps) {
  const { t } = useTranslation()
  const [creating, setCreating] = useState(false)
  const listQuery = useBrokerInstances({ kind })
  // Only brokers that can carry traffic, plus the one already chosen (kept visible with its state).
  const brokers = selectableBrokers(listQuery.data ?? [], value)

  // Nothing chosen yet: pre-select the first broker of the kind, but only once
  // the list ANSWERED — still loading or failed must never read as "no broker".
  const firstId = brokers[0]?.id ?? null
  const answered = !listQuery.isLoading && !listQuery.isError && listQuery.data !== undefined
  useEffect(() => {
    if (!optional && !disabled && answered && value === null && firstId !== null) onChange(firstId)
  }, [optional, disabled, answered, value, firstId, onChange])

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
      {optional && (
        <button // ui-check-ok: a selectable card (aria-pressed), not an action button
          type="button"
          aria-pressed={value === null}
          disabled={disabled}
          onClick={() => onChange(null)}
          className={`flex w-full items-center rounded-lg border bg-surface p-3 text-left text-xs text-foreground-subtle transition-colors ${
            value === null
              ? 'border-primary ring-1 ring-primary'
              : 'border-border hover:border-foreground-subtle/30'
          }`}
        >
          {noneLabel ?? t('brokers.picker.noneChoice')}
        </button>
      )}
      {brokers.map((b) => (
        <button // ui-check-ok: a selectable card (aria-pressed), not an action button
          key={b.id}
          type="button"
          aria-pressed={value === b.id}
          disabled={disabled}
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
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => setCreating(true)}>
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
