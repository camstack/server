/**
 * Pending, failed and answered are three different things (D315): a query that
 * has not answered is "reading", one that failed says why and offers a retry,
 * and only an ANSWER with no rows is "nothing" — which the caller renders.
 */
import { ErrorBox } from '@camstack/ui-library'
import { Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export interface QueryBodyProps {
  readonly isPending: boolean
  readonly error: { readonly message: string } | null
  readonly what: string
  readonly onRetry: () => void
  readonly children: ReactNode
}

export function QueryBody({
  isPending,
  error,
  what,
  onRetry,
  children,
}: QueryBodyProps): ReactNode {
  const { t } = useTranslation()
  if (isPending) {
    return (
      <div
        className="flex items-center gap-2 py-3 text-xs text-foreground-subtle"
        role="status"
        data-testid="query-pending"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        {t('certificates.queryBody.reading', { what })}
      </div>
    )
  }
  if (error !== null) {
    return (
      <ErrorBox
        title={t('certificates.queryBody.couldNotRead', 'Could not read {{what}}', { what })}
        message={
          error.message.length > 0
            ? error.message
            : t('certificates.queryBody.requestFailed', 'Request failed')
        }
        onRetry={onRetry}
      />
    )
  }
  return children
}
