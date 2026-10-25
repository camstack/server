import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { type LiveValueDisplay, type LiveValueTarget, liveValueDisplay } from './live-value'
import { useLiveValue } from './use-live-value'

const TONE_CLASS = {
  muted: 'text-foreground-subtle',
  active: 'text-success',
  normal: 'text-foreground',
  warning: 'text-warning',
} as const

export interface LiveValueTextProps {
  readonly target: LiveValueTarget | null
}

export function LiveValueText({ target }: LiveValueTextProps): ReactNode {
  const { t } = useTranslation()
  const value = useLiveValue(target)
  if (target === null) return null
  const display = liveValueDisplay(value, target, {
    active: t('customize.assign.value.active'),
    inactive: t('customize.assign.value.inactive'),
    open: t('customize.assign.value.open'),
    closed: t('customize.assign.value.closed'),
  })
  return <ValueText display={display} />
}

export interface ValueTextProps {
  readonly display: LiveValueDisplay
}

/** A value already decided by its caller (e.g. the camera's own raw level, D696), in the live-value style. */
export function ValueText({ display }: ValueTextProps): ReactNode {
  return (
    <span className={`text-xs ${TONE_CLASS[display.tone]}`} title={display.title}>
      {display.text}
    </span>
  )
}
