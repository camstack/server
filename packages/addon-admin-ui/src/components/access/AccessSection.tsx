/**
 * The chrome of one Tokens & sessions body: the common `SectionCard` with the
 * kind's name, what it is in one or two sentences, an optional header action
 * ("New token"), ONE notice region, and the kind's table. Every kind uses it,
 * so the bodies read as one page when the operator switches pills.
 *
 * One notice region per body: a failed write and the outcome of a bulk revoke
 * land in the same line under the description — never a second box stacked
 * over the table, never one inside the bulk bar.
 */
import {
  cn,
  IconButton,
  SECTION_BODY,
  SectionCard,
  useUserManagementListUsers,
} from '@camstack/ui-library'
import { AlertOctagon, CheckCircle2, X, type LucideIcon } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'

import type { UserNames } from './credential-row'
import { useTranslation } from 'react-i18next'

export interface AccessNotice {
  readonly tone: 'success' | 'danger'
  readonly message: string
}

export interface AccessSectionProps {
  readonly id: string
  readonly title: string
  readonly icon: LucideIcon
  readonly description: ReactNode
  readonly actions?: ReactNode
  /** Danger-styled (admin tokens act as a full administrator). */
  readonly tone?: 'default' | 'danger'
  /** The body's one notice line; `null` = none. */
  readonly notice?: AccessNotice | null
  readonly onDismissNotice?: () => void
  readonly children: ReactNode
}

export function AccessSection({
  id,
  title,
  icon,
  description,
  actions,
  tone = 'default',
  notice = null,
  onDismissNotice,
  children,
}: AccessSectionProps): ReactNode {
  return (
    <SectionCard
      headingId={`access-${id}`}
      title={title}
      icon={icon}
      actions={actions}
      testId={`access-${id}`}
    >
      <div className={`${SECTION_BODY} space-y-3`}>
        <div
          className={cn(
            'text-[11px] leading-relaxed',
            tone === 'danger'
              ? 'rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-foreground'
              : 'text-foreground-subtle',
          )}
        >
          {description}
        </div>
        {notice !== null && <NoticeLine notice={notice} onDismiss={onDismissNotice} />}
        {children}
      </div>
    </SectionCard>
  )
}

const NOTICE_TONE = {
  success: { icon: CheckCircle2, line: 'border-success/30 text-foreground', mark: 'text-success' },
  danger: { icon: AlertOctagon, line: 'border-danger/40 text-danger', mark: 'text-danger' },
} as const

function NoticeLine({
  notice,
  onDismiss,
}: {
  readonly notice: AccessNotice
  readonly onDismiss: (() => void) | undefined
}): ReactNode {
  const { t } = useTranslation()
  const tone = NOTICE_TONE[notice.tone]
  const Icon = tone.icon
  return (
    <div
      role={notice.tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-md border bg-surface px-3 py-2 text-[11px]',
        tone.line,
      )}
    >
      <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', tone.mark)} aria-hidden />
      <span className="min-w-0 flex-1">{notice.message}</span>
      {onDismiss !== undefined && (
        <IconButton
          type="button"
          variant="ghost"
          size="sm"
          icon={X}
          aria-label={t('access.accessSection.dismiss', 'Dismiss')}
          onClick={onDismiss}
          className="-my-1 h-5 w-5"
        />
      )}
    </div>
  )
}

/** id → username, from the one user list every section shares (same cache entry). */
export function useUserNames(): UserNames {
  const { data: users } = useUserManagementListUsers()
  return useMemo(() => {
    const m = new Map<string, string>()
    for (const u of users ?? []) m.set(u.id, u.username)
    return m
  }, [users])
}

/** The notice a body shows: a failed single write wins over a bulk outcome. */
export function pickNotice(
  error: string | null,
  bulkOutcome: AccessNotice | null = null,
): AccessNotice | null {
  if (error !== null) return { tone: 'danger', message: error }
  return bulkOutcome
}
