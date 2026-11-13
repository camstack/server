import { type ReactElement, useState } from 'react'
import { useUiText } from '../../../contexts/ui-text'
import { CardButton } from './CardButton'

export interface CodePadProps {
  /** What the confirm key says ("Disarm", "Arm away"). */
  readonly submitLabel: string
  readonly onSubmit: (code: string) => void
  readonly onCancel: () => void
  readonly testId?: string
}

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const
const MAX_DIGITS = 12

/**
 * The card's code entry: a digit pad for a device that asks for a code
 * before it acts (an alarm panel). The code is shown as dots and leaves the
 * pad only on confirm.
 */
export function CodePad({ submitLabel, onSubmit, onCancel, testId }: CodePadProps): ReactElement {
  const t = useUiText()
  const [code, setCode] = useState('')
  const press = (digit: string) => (): void =>
    setCode((current) => (current.length >= MAX_DIGITS ? current : current + digit))
  return (
    <div data-testid={testId} className="grid w-full max-w-60 justify-items-center gap-2">
      <output
        aria-label={t('uiLibrary.deviceCard.codePad.code', 'Code')}
        className="h-6 text-lg tracking-widest text-foreground"
      >
        {code.length === 0 ? '—' : '•'.repeat(code.length)}
      </output>
      <div className="grid w-full grid-cols-3 gap-1.5">
        {DIGITS.map((digit) => (
          <CardButton key={digit} onClick={press(digit)} data-testid={`dc-code-${digit}`}>
            {digit}
          </CardButton>
        ))}
        <CardButton
          glyph="back"
          aria-label={t('uiLibrary.deviceCard.codePad.erase', 'Erase')}
          onClick={() => setCode((current) => current.slice(0, -1))}
        />
        <CardButton onClick={press('0')} data-testid="dc-code-0">
          0
        </CardButton>
        <CardButton
          glyph="cancel"
          aria-label={t('uiLibrary.deviceCard.cancel', 'Cancel')}
          onClick={onCancel}
        />
      </div>
      <CardButton
        tone="primary"
        disabled={code.length === 0}
        data-testid="dc-code-submit"
        onClick={() => onSubmit(code)}
      >
        {submitLabel}
      </CardButton>
    </div>
  )
}
