/**
 * A password input with its eye inside it — the one control for every secret
 * in a settings form (a keychain secret, a camera driver's plaintext, a create
 * dialog). Presentational: the caller owns the text, whether it is shown,
 * and what pressing the eye means (toggle what is typed, or fetch a stored
 * value first — `busy` while that is in flight, `error` when it was refused).
 */
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import {
  type CSSProperties,
  forwardRef,
  type InputHTMLAttributes,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from 'react'
import { cn } from '../lib/cn'
import { IconButton } from './icon-button'
import { Input } from './input'
import { Tooltip, TooltipContent } from './tooltip'

export interface PasswordInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> {
  readonly value: string
  readonly onValueChange: (text: string) => void
  /** The text is shown in clear. */
  readonly shown: boolean
  readonly onToggleShown: () => void
  /** The eye is waiting for a value (a reveal in flight). */
  readonly busy?: boolean
  /** Why the last press failed — drawn as a tooltip on the eye. */
  readonly error?: string | null
  /** The eye cannot act right now; the reason is its title. */
  readonly toggleBlockedReason?: string | null
  /** Draw no eye at all (a field that opts out of the toggle). */
  readonly hideToggle?: boolean
  /** Multi-line entry (a PEM key): a textarea masked by the browser. */
  readonly multiline?: boolean
}

const TEXTAREA =
  'w-full min-h-[60px] rounded-md border border-border bg-background px-2.5 py-1.5 pr-9 font-mono text-xs text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed'

// Not in React's CSSProperties; every current engine honours it.
const MASKED_TEXTAREA = { WebkitTextSecurity: 'disc' } as CSSProperties

export const PasswordInput: ForwardRefExoticComponent<
  PasswordInputProps & RefAttributes<HTMLInputElement>
> = forwardRef<HTMLInputElement, PasswordInputProps>(
  (
    {
      value,
      onValueChange,
      shown,
      onToggleShown,
      busy = false,
      error = null,
      toggleBlockedReason = null,
      hideToggle = false,
      multiline = false,
      className,
      disabled,
      ...inputProps
    },
    ref,
  ) => {
    const label = shown ? 'Hide password' : 'Show password'
    return (
      <div className="relative w-full">
        {multiline ? (
          <textarea
            className={cn(TEXTAREA, className)}
            // A textarea has no `type=password`; the browser masks it instead.
            style={shown ? undefined : MASKED_TEXTAREA}
            value={value}
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
            aria-label={inputProps['aria-label']}
            placeholder={inputProps.placeholder}
            onChange={(e) => onValueChange(e.target.value)}
          />
        ) : (
          <Input
            ref={ref}
            {...inputProps}
            type={shown ? 'text' : 'password'}
            className={cn('h-auto bg-background py-1.5', !hideToggle && 'pr-9', className)}
            value={value}
            disabled={disabled}
            spellCheck={false}
            autoComplete="new-password"
            onChange={(e) => onValueChange(e.target.value)}
          />
        )}
        {!hideToggle && (
          <Tooltip open={error !== null} className="absolute right-0.5 top-0.5">
            {/* The title sits on a wrapper: a disabled button takes no hover. */}
            <span className="inline-flex" title={toggleBlockedReason ?? undefined}>
              <IconButton
                type="button"
                variant="ghost"
                icon={busy ? Loader2 : shown ? EyeOff : Eye}
                aria-label={label}
                aria-pressed={shown}
                aria-busy={busy || undefined}
                disabled={disabled || busy || toggleBlockedReason !== null}
                className={cn('h-6 w-6 text-foreground-subtle', busy && '[&>svg]:animate-spin')}
                onClick={onToggleShown}
              />
            </span>
            {error !== null && (
              <TooltipContent
                role="alert"
                className="left-auto right-0 w-max max-w-[16rem] translate-x-0 whitespace-normal bg-danger text-white"
              >
                {error}
              </TooltipContent>
            )}
          </Tooltip>
        )}
      </div>
    )
  },
)

PasswordInput.displayName = 'PasswordInput'
