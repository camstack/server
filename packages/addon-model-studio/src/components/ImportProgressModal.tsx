/**
 * Modal shown during plus catalog/Custom import or on-demand engine convert.
 * Surfaces high-level steps, live convert progress, and process log lines.
 */
import type { ConvertProgressEvent } from '../ui/api.js'
import { useT } from '../i18n/index.js'
import { Button } from '@camstack/ui-library'

export type ImportStepStatus = 'pending' | 'active' | 'done' | 'error' | 'skipped'

export interface ImportProgressStep {
  readonly id: string
  readonly label: string
  readonly status: ImportStepStatus
}

export interface ImportProgressModalProps {
  readonly title: string
  readonly steps: readonly ImportProgressStep[]
  readonly progress: ConvertProgressEvent | null
  readonly logs: readonly string[]
  readonly status: 'running' | 'success' | 'error'
  readonly errorMessage?: string
  readonly onClose: () => void
}

const STATUS_DOT: Readonly<Record<ImportStepStatus, string>> = {
  pending: 'bg-surface-hover',
  active: 'bg-warning animate-pulse',
  done: 'bg-success',
  error: 'bg-danger',
  skipped: 'bg-surface-hover',
}

export function ImportProgressModal({
  title,
  steps,
  progress,
  logs,
  status,
  errorMessage,
  onClose,
}: ImportProgressModalProps) {
  const { t } = useT()
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid="import-progress-modal"
    >
      <div className="w-full max-w-lg rounded-xl border border-border bg-surface shadow-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={[
                'w-2 h-2 rounded-full shrink-0',
                status === 'running'
                  ? 'bg-warning animate-pulse'
                  : status === 'success'
                    ? 'bg-success'
                    : 'bg-danger',
              ].join(' ')}
            />
            <h2 className="text-sm font-medium text-foreground truncate">{title}</h2>
          </div>
          {status !== 'running' && (
            <Button
              variant="unstyled"
              type="button"
              onClick={onClose}
              className="px-2.5 py-1 text-[10px] font-medium rounded-md border border-border text-foreground-subtle hover:text-foreground"
            >
              {t('common.close')}
            </Button>
          )}
        </div>

        <div className="px-4 py-3 space-y-3 max-h-[70vh] overflow-y-auto">
          <ol className="space-y-1.5">
            {steps.map((step) => (
              <li key={step.id} className="flex items-center gap-2 text-xs">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[step.status]}`} />
                <span
                  className={
                    step.status === 'active'
                      ? 'text-foreground font-medium'
                      : step.status === 'pending' || step.status === 'skipped'
                        ? 'text-foreground-subtle'
                        : 'text-foreground'
                  }
                >
                  {step.label}
                  {step.status === 'skipped' ? t('importProgress.skipped') : ''}
                </span>
              </li>
            ))}
          </ol>

          {status === 'running' && progress !== null && progress.phase !== 'log' && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-mono text-foreground">
                  {progress.phase}
                  {progress.detail ? ` — ${progress.detail}` : ''}
                </span>
                {progress.pct !== undefined && (
                  <span className="font-mono text-foreground-subtle">
                    {progress.pct.toFixed(0)}%
                  </span>
                )}
              </div>
              <div className="h-1.5 w-full rounded-full bg-surface overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{ width: `${Math.max(4, Math.min(100, progress.pct ?? 8))}%` }}
                />
              </div>
            </div>
          )}

          {status === 'error' && errorMessage !== undefined && (
            <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger whitespace-pre-wrap">
              {errorMessage}
            </div>
          )}

          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wide text-foreground-subtle">
              {t('importProgress.processLog')}
            </div>
            <pre
              className="h-40 overflow-y-auto rounded-md border border-border bg-background px-2 py-1.5 text-[10px] font-mono text-foreground-subtle whitespace-pre-wrap break-all"
              data-testid="import-progress-log"
            >
              {logs.length === 0
                ? status === 'running'
                  ? t('importProgress.waiting')
                  : t('importProgress.noLines')
                : logs.join('\n')}
            </pre>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Append a progress event into the operator-facing log buffer. */
export function appendProgressLog(
  logs: readonly string[],
  event: ConvertProgressEvent,
  limit = 400,
): readonly string[] {
  const line =
    event.log !== undefined && event.log.length > 0
      ? event.log
      : event.phase === 'log'
        ? (event.detail ?? '')
        : `[${event.phase}]${event.detail !== undefined ? ` ${event.detail}` : ''}${
            event.pct !== undefined ? ` ${event.pct.toFixed(0)}%` : ''
          }`
  if (line.trim().length === 0) return logs
  const next = [...logs, line]
  return next.length > limit ? next.slice(next.length - limit) : next
}
