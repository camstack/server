/**
 * `<ErrorBox>` — the shared, presentational error/alert box for the
 * admin UI.
 *
 * One consistent way to surface connection / status / operation
 * failures across every addon surface (Remote Access, Mesh Networks,
 * TURN Servers, Authentication, device-export, …). It always renders
 * as a bordered box INSIDE a form/body — never as a tiny inline header
 * span. Light-theme readable by design.
 *
 * Purely presentational: no data fetching, no business logic. Pass a
 * message string (or richer `ReactNode`), an optional `title`, an
 * optional retry handler / action slot, and an optional `warning`
 * variant for non-fatal advisories.
 */
import { useUiText } from '../contexts/ui-text'
import { type ReactNode, type JSX } from 'react'
import { AlertCircle, AlertTriangle, RefreshCw } from 'lucide-react'
import { cn } from '../lib/cn'

export type ErrorBoxVariant = 'danger' | 'warning'

export interface ErrorBoxProps {
  /** The error message. Accepts a string or richer content. */
  message: ReactNode
  /** Optional bold headline shown above the message. */
  title?: string
  /**
   * Optional retry handler. When supplied (and no custom `action` is
   * given) a compact "Retry" button is rendered.
   */
  onRetry?: () => void
  /** Custom action slot — overrides the default retry button. */
  action?: ReactNode
  /** Visual flavor. Defaults to `danger`. */
  variant?: ErrorBoxVariant
  className?: string
}

interface VariantStyle {
  readonly box: string
  readonly icon: string
  readonly title: string
  readonly message: string
}

const VARIANT_STYLES: Record<ErrorBoxVariant, VariantStyle> = {
  danger: {
    box: 'border-danger/40 bg-danger/10',
    icon: 'text-danger',
    title: 'text-danger',
    message: 'text-danger',
  },
  warning: {
    box: 'border-amber-500/40 bg-amber-500/10',
    icon: 'text-amber-600 dark:text-amber-400',
    title: 'text-amber-700 dark:text-amber-300',
    message: 'text-amber-700 dark:text-amber-300',
  },
}

export function ErrorBox({
  message,
  title,
  onRetry,
  action,
  variant = 'danger',
  className,
}: ErrorBoxProps): JSX.Element {
  const t = useUiText()
  const styles = VARIANT_STYLES[variant]
  const Icon = variant === 'warning' ? AlertTriangle : AlertCircle

  return (
    <div
      role="alert"
      className={cn('flex items-start gap-2.5 rounded border px-3 py-2.5', styles.box, className)}
    >
      <Icon className={cn('h-4 w-4 mt-0.5 shrink-0', styles.icon)} aria-hidden="true" />
      <div className="flex-1 min-w-0">
        {title && <p className={cn('text-xs font-semibold', styles.title)}>{title}</p>}
        <div className={cn('text-xs break-words', styles.message, title ? 'mt-0.5' : '')}>
          {message}
        </div>
      </div>
      {action ??
        (onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className={cn(
              'shrink-0 inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium',
              'border border-current/30 hover:bg-current/10 transition-colors',
              styles.message,
            )}
          >
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
            {t('uiLibrary.errorBox.retry', 'Retry')}
          </button>
        ))}
    </div>
  )
}
