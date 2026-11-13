/**
 * The instance picker the host mounts for `instance-select` fields (D1013 rule 5). A broker link
 * gets the rich `BrokerPicker` (default pick, create in place); any other function cap gets the
 * library's plain select, which never picks for the operator (an optional link stays empty), with a
 * "Create new…" for any instance the link can point at. An optional link (`required: false`) keeps
 * an empty choice in both, and `disabled` is passed through.
 */
import { InstancePlainSelect, type InstancePickerSlotProps } from '@camstack/ui-library'
import type { JSX } from 'react'
import { BrokerPicker } from '../brokers/BrokerPicker'
import { InstanceLinkCreate } from './InstanceLinkCreate'

/** The cap whose instances are brokers. */
const BROKER_CAP = 'broker'

export function InstancePicker({
  functionCap,
  kind,
  noneLabel,
  required,
  disabled,
  value,
  onChange,
}: InstancePickerSlotProps): JSX.Element {
  if (functionCap === BROKER_CAP && kind !== undefined) {
    return (
      <BrokerPicker
        kind={kind}
        value={value}
        onChange={onChange}
        optional={required === false}
        disabled={disabled === true}
        {...(noneLabel !== undefined ? { noneLabel } : {})}
      />
    )
  }
  return (
    <div className="space-y-2">
      <InstancePlainSelect
        functionCap={functionCap}
        {...(kind !== undefined ? { kind } : {})}
        {...(noneLabel !== undefined ? { noneLabel } : {})}
        value={value ?? ''}
        disabled={disabled === true}
        onChange={(id) => onChange(id === '' ? null : id)}
        controlId={`instance-picker-${functionCap}-${kind ?? 'any'}`}
      />
      {kind === undefined && (
        <div>
          <InstanceLinkCreate
            functionCap={functionCap}
            disabled={disabled === true}
            onCreated={onChange}
          />
        </div>
      )}
    </div>
  )
}
