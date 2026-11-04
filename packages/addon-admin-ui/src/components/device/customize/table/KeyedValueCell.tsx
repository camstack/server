/**
 * The value of a Lists row: native items plus assigned ones, as a count and
 * their names. An unread native list is said, never treated as empty (D315).
 */
import { readKeyedArrayItems, type DeviceInfo } from '@camstack/types'
import type { TFunction } from 'i18next'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { currentComposition } from '../customization-read'
import { featureOf } from '../customization-save'
import { type DefaultConsumable, humanizeConsumableKey } from '../default-consumables'
import type { Known } from '../known'
import type { CustomizationHandle } from '../use-customization'
import { ListValueText } from './ListValueText'
import type { CustomizeRowSpec } from './customize-rows'

export interface KeyedValueCellProps {
  readonly device: DeviceInfo
  readonly handle: CustomizationHandle
  readonly spec: CustomizeRowSpec
  readonly defaults: Known<readonly DefaultConsumable[]>
}

function Checking(): ReactNode {
  const { t } = useTranslation()
  return (
    <span role="status" className="text-xs text-foreground-subtle">
      {t('customize.event.checking')}
    </span>
  )
}

function Unread({ reason }: { readonly reason: string }): ReactNode {
  const { t } = useTranslation()
  return (
    <span role="alert" className="text-xs text-warning" title={reason}>
      {t('customize.table.unknown')}
    </span>
  )
}

function defaultLabel(entry: DefaultConsumable, t: TFunction): string {
  if (entry.kind === 'item') return entry.item.label
  return t(`customize.consumables.fields.${entry.key}`, {
    defaultValue: humanizeConsumableKey(entry.key),
  })
}

export function KeyedValueCell({ handle, spec, defaults }: KeyedValueCellProps): ReactNode {
  const { t } = useTranslation()
  if (handle.state.kind === 'pending' || handle.state.kind === 'not-loaded') return <Checking />
  if (handle.state.kind === 'unknown') return <Unread reason={handle.state.reason} />
  const nativesPending = spec.cap === 'consumables' && defaults.kind === 'pending'
  if (nativesPending) return <Checking />
  if (spec.cap === 'consumables' && defaults.kind === 'unknown') {
    return <Unread reason={defaults.reason} />
  }
  const feature = featureOf(currentComposition(handle.state), spec.cap)
  const stored =
    feature === null ? [] : (readKeyedArrayItems(feature, spec.cap, spec.target.id)?.items ?? [])
  const natives =
    spec.cap === 'consumables' && defaults.kind === 'known'
      ? defaults.value.map((entry) => defaultLabel(entry, t))
      : []
  const labels = [...natives, ...stored.map((item) => item.label.trim() || item.key)]
  if (labels.length === 0) {
    return <span className="text-xs text-foreground-subtle">{t('customize.table.listNone')}</span>
  }
  return <ListValueText labels={labels} />
}
