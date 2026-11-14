import { type ReactElement, type ReactNode, useCallback, useEffect, useState } from 'react'
import { useUiText } from '../../../contexts/ui-text'
import type { CardGlyph } from '../icons'
import { CardButton, type CardButtonTone } from './CardButton'

/** How long an armed action waits for its confirmation. */
export const ARMED_WINDOW_MS = 5_000

export interface ArmedButtonProps {
  readonly glyph?: CardGlyph
  /** The tone while NOT armed (default: default); armed is always danger. */
  readonly tone?: CardButtonTone
  readonly children: ReactNode
  /** What the button says while armed (default: "Confirm"). */
  readonly armedLabel?: ReactNode
  readonly onConfirm: () => void
  readonly disabled?: boolean
  readonly windowMs?: number
  readonly testId?: string
  /** The accessible name of the main button, when its face is only a glyph. */
  readonly label?: string
  /** Confirm and Cancel stack vertically, for a side column; the default sits them side by side. */
  readonly stacked?: boolean
  /** Added to both buttons (a column passes its compact size). */
  readonly buttonClassName?: string
}

/**
 * The card's ONE two-step confirmation: the first press arms the action and
 * shows a Cancel beside it; a second press within the window runs it, and the
 * window closing (or Cancel) disarms. A scene never keeps its own confirm timer.
 */
export function ArmedButton({
  glyph,
  tone = 'default',
  children,
  armedLabel,
  onConfirm,
  disabled,
  windowMs = ARMED_WINDOW_MS,
  testId,
  label,
  stacked = false,
  buttonClassName,
}: ArmedButtonProps): ReactElement {
  const t = useUiText()
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return undefined
    const timer = setTimeout(() => setArmed(false), windowMs)
    return () => clearTimeout(timer)
  }, [armed, windowMs])
  const press = useCallback(() => {
    if (!armed) {
      setArmed(true)
      return
    }
    setArmed(false)
    onConfirm()
  }, [armed, onConfirm])
  return (
    <span
      className={
        stacked ? 'flex w-full flex-col items-center gap-1' : 'inline-flex items-center gap-2'
      }
      data-armed={armed}
    >
      <CardButton
        tone={armed ? 'danger' : tone}
        glyph={glyph}
        onClick={press}
        disabled={disabled}
        data-testid={testId}
        aria-label={label}
        title={label}
        className={buttonClassName}
      >
        {armed ? (armedLabel ?? t('uiLibrary.deviceCard.confirm', 'Confirm')) : children}
      </CardButton>
      {armed ? (
        <CardButton
          glyph="cancel"
          onClick={() => setArmed(false)}
          data-testid="dc-armed-cancel"
          className={buttonClassName}
        >
          {t('uiLibrary.deviceCard.cancel', 'Cancel')}
        </CardButton>
      ) : null}
    </span>
  )
}
