/**
 * Native keyed-array items, read-only. They belong to the device's own
 * capability, so this card never writes them back into the composition.
 */
import {
  ConsumableLevelBadge,
  consumableItemLevel,
  parseConsumableLevel,
} from '@camstack/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AssignmentRow } from '../assignments/AssignmentRow'
import { ValueText } from '../assignments/LiveValueText'
import type { LiveValue } from '../assignments/live-value'
import { useLiveValue } from '../assignments/use-live-value'
import { type DefaultConsumable, humanizeConsumableKey } from '../default-consumables'

export function NativeItemRows(props: {
  readonly deviceId: number
  readonly defaults: readonly DefaultConsumable[]
}): ReactNode {
  return props.defaults.map((entry) =>
    entry.kind === 'field' ? (
      <NativeFieldRow
        key={`field:${entry.cap}.${entry.path}`}
        deviceId={props.deviceId}
        entry={entry}
      />
    ) : (
      <NativeSliceRow key={`item:${entry.key}`} entry={entry} />
    ),
  )
}

function NativeFieldRow(props: {
  readonly deviceId: number
  readonly entry: Extract<DefaultConsumable, { kind: 'field' }>
}): ReactNode {
  const { t } = useTranslation()
  const value = useLiveValue({
    deviceId: props.deviceId,
    cap: props.entry.cap,
    path: props.entry.path,
  })
  return (
    <AssignmentRow
      name={t(`customize.consumables.fields.${props.entry.key}`, {
        defaultValue: humanizeConsumableKey(props.entry.key),
      })}
      detail={t('customize.consumables.builtIn')}
      meta={t('customize.assign.native')}
      value={null}
      readout={<LevelReadout value={value} />}
      removeLabel=""
    />
  )
}

function LevelReadout(props: { readonly value: LiveValue }): ReactNode {
  switch (props.value.kind) {
    case 'pending':
      return <ValueText display={{ text: '…', tone: 'muted' }} />
    case 'unknown':
      return <ValueText display={{ text: '?', title: props.value.reason, tone: 'warning' }} />
    case 'absent':
      return <ConsumableLevelBadge level={null} size="sm" />
    case 'value':
      return <ConsumableLevelBadge level={parseConsumableLevel(props.value.value)} size="sm" />
  }
}

function NativeSliceRow(props: {
  readonly entry: Extract<DefaultConsumable, { kind: 'item' }>
}): ReactNode {
  const { t } = useTranslation()
  const { item } = props.entry
  const label =
    item.level !== null
      ? `${Math.round(item.level)} %`
      : item.status === 'replace'
        ? t('uiLibrary.consumablesPanel.replace')
        : undefined
  return (
    <AssignmentRow
      name={item.label}
      detail={t('customize.consumables.builtIn')}
      meta={t('customize.assign.native')}
      value={null}
      readout={<ConsumableLevelBadge level={consumableItemLevel(item)} label={label} size="sm" />}
      removeLabel=""
    />
  )
}
