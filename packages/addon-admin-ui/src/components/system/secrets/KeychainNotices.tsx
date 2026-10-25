/**
 * The Secrets page's ONE notice region (System → Secrets).
 *
 * Every condition that needs the operator is a single line here — icon, a
 * short sentence, its action — ordered by `buildKeychainNotices`. Longer
 * explanations sit behind the line's own "Details" toggle, and when there are
 * more than two lines only the most urgent shows until the operator expands
 * the rest. One box, one list: nothing stacks over anything at any width.
 */
import { Button, cn } from '@camstack/ui-library'
import { AlertOctagon, AlertTriangle, ChevronDown, Info, type LucideIcon } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import type { KeychainNotice, KeychainNoticeId, KeychainNoticeTone } from './keychain-notices'
import { useTranslation } from 'react-i18next'

/** Past this many lines, only the first is shown until expanded. */
const COLLAPSE_ABOVE = 2

const TONE: Record<KeychainNoticeTone, { icon: LucideIcon; text: string; border: string }> = {
  danger: { icon: AlertOctagon, text: 'text-danger', border: 'border-danger/40' },
  warning: { icon: AlertTriangle, text: 'text-warning', border: 'border-warning/40' },
  info: { icon: Info, text: 'text-info', border: 'border-border' },
}

export interface KeychainNoticesProps {
  readonly notices: readonly KeychainNotice[]
  /** The line's action buttons; `null` for none. */
  readonly renderAction: (id: KeychainNoticeId) => ReactNode
  /** The line's expandable explanation; `null` for none. */
  readonly renderDetail: (id: KeychainNoticeId) => ReactNode
}

export function KeychainNotices({ notices, renderAction, renderDetail }: KeychainNoticesProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const first = notices[0]
  if (first === undefined) return null
  const collapsible = notices.length > COLLAPSE_ABOVE
  const visible = collapsible && !expanded ? notices.slice(0, 1) : notices
  const hidden = notices.length - visible.length

  return (
    <section
      aria-label={t('secrets.keychainNotices.keychainNotices', 'Keychain notices')}
      className={cn('rounded-lg border bg-surface', TONE[first.tone].border)}
    >
      <ul className="divide-y divide-border">
        {visible.map((n) => (
          <NoticeLine
            key={n.id}
            notice={n}
            action={renderAction(n.id)}
            detail={renderDetail(n.id)}
          />
        ))}
      </ul>
      {collapsible && (
        <div className="border-t border-border px-3 py-1">
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <ChevronDown
              className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')}
              aria-hidden
            />
            {expanded
              ? t('secrets.keychainNotices.showLess', 'Show less')
              : t('secrets.keychainNotices.more', '{{hidden}} more', { hidden })}
          </Button>
        </div>
      )}
    </section>
  )
}

interface NoticeLineProps {
  readonly notice: KeychainNotice
  readonly action: ReactNode
  readonly detail: ReactNode
}

function NoticeLine({ notice, action, detail }: NoticeLineProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const tone = TONE[notice.tone]
  const Icon = tone.icon
  const hasDetail = detail !== null && detail !== undefined
  const detailId = `keychain-notice-${notice.id}`
  return (
    <li className="px-3 py-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <p className="flex min-w-0 flex-1 items-start gap-2 text-xs text-foreground">
          <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', tone.text)} aria-hidden />
          <span className="min-w-0 break-words">{notice.title}</span>
        </p>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 pl-5 sm:pl-0">
          {hasDetail && (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={open}
              aria-controls={detailId}
              onClick={() => setOpen((v) => !v)}
            >
              {t('secrets.keychainNotices.details', 'Details')}
            </Button>
          )}
          {action}
        </div>
      </div>
      {hasDetail && open && (
        <div id={detailId} className="mt-2 pl-5 text-xs text-foreground-muted">
          {detail}
        </div>
      )}
    </li>
  )
}
