/**
 * A `Select` held to a fixed width inside an inline sentence, where the
 * library select would otherwise stretch to the full row.
 */
import { Select } from '@camstack/ui-library'
import type { ComponentProps } from 'react'

export type FixedSelectProps = Omit<ComponentProps<typeof Select>, 'className'> & {
  readonly widthClass: string
}

export function FixedSelect({ widthClass, ...props }: FixedSelectProps) {
  return (
    <span className={`block max-w-full ${widthClass}`}>
      <Select {...props} />
    </span>
  )
}
