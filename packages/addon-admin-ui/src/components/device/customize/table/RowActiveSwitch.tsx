/**
 * The ONE active / inactive toggle of a Customize row: the library `Switch`,
 * for every kind whose stored feature can be switched off (a power source, an
 * identity-link row, an event). A row is never given a checkbox of its own.
 */
import { Switch } from '@dominevo/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export interface RowActiveSwitchProps {
  /** What the row is called: the switch's accessible name reads "Active — <title>". */
  readonly title: string
  readonly checked: boolean
  readonly disabled: boolean
  readonly testId: string
  readonly onChange: (next: boolean) => void
}

export function RowActiveSwitch(props: RowActiveSwitchProps): ReactNode {
  const { t } = useTranslation()
  return (
    <Switch
      checked={props.checked}
      disabled={props.disabled}
      aria-label={`${t('customize.table.linkActive')} ${props.title}`}
      data-testid={props.testId}
      onCheckedChange={props.onChange}
    />
  )
}
