import { type ReactNode, type JSX } from 'react'
import { cn } from '../lib/cn'
import { SettingRow } from './setting-row'

export interface KeyValueListProps {
  items: { key: string; value: ReactNode }[]
  className?: string
}

/**
 * A `<dl>` of label/value rows. Layout (including the L1 stacking) is owned by
 * `SettingRow`; this composite only supplies the description-list semantics.
 *
 * The rows used to be `flex items-center h-7` with a `w-1/3` term, so a label
 * could neither wrap nor stack: on a phone it took a third of the width and
 * the value took whatever was left.
 */
export function KeyValueList({ items, className }: KeyValueListProps): JSX.Element {
  return (
    <dl className={cn('flex flex-col', className)}>
      {items.map((item) => (
        <SettingRow key={item.key} elements="description" label={item.key}>
          {item.value}
        </SettingRow>
      ))}
    </dl>
  )
}
