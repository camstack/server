/**
 * `CopyButton` — a compact button that copies a string `value` to the
 * clipboard via `navigator.clipboard.writeText`, showing a brief
 * "copied" check state. Addon-agnostic; used wherever a secret / URL
 * needs a one-click copy affordance (export setup panels, etc.).
 */
import { useCallback, useState, type ReactElement } from 'react'
import { Copy, Check } from 'lucide-react'
import { cn } from '../lib/cn'
import { useUiText } from '../contexts/ui-text'
import { Button } from '../primitives/button'

const COPIED_RESET_MS = 2000

export interface CopyButtonProps {
  /** String copied to the clipboard when the button is pressed. */
  readonly value: string
  /** Optional visible label rendered next to the icon. Icon-only when omitted.
   *
   *  Do NOT pass the name of the field the button sits next to: the row
   *  already shows it, and the repeat is what overlapped the value on a phone
   *  (a token row rendered its own name on top of the masked secret). Use
   *  {@link CopyButtonProps.srLabel} for that — it names the target for screen
   *  readers without spending horizontal space. */
  readonly label?: string
  /** Names what is copied, for assistive tech only — never rendered. Falls back
   *  to `label`, then to a generic word. */
  readonly srLabel?: string
  /** Extra classes merged onto the button. */
  readonly className?: string
  /** Disable the button (e.g. nothing to copy). */
  readonly disabled?: boolean
}

export function CopyButton({
  value,
  label,
  srLabel,
  className,
  disabled,
}: CopyButtonProps): ReactElement {
  const t = useUiText()
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    if (!value) return
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), COPIED_RESET_MS)
    })
  }, [value])

  return (
    <Button
      size="sm"
      variant="ghost"
      type="button"
      disabled={disabled || value.length === 0}
      onClick={handleCopy}
      className={cn(className)}
      aria-label={
        copied
          ? t('uiLibrary.copyButton.copied', 'Copied')
          : t('uiLibrary.copyButton.copy', 'Copy {{what}}', {
              what: srLabel ?? label ?? t('uiLibrary.copyButton.value', 'value'),
            })
      }
    >
      {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      {label ? (
        <span className="ml-1">{copied ? t('uiLibrary.copyButton.copied', 'Copied') : label}</span>
      ) : null}
    </Button>
  )
}
