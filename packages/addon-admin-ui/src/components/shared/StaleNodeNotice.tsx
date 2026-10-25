/**
 * "The link named a node this cluster no longer has."
 *
 * Every page scoped by `?node=` falls back to its default node when the id
 * names nothing — an empty page for an id nobody can select away from would be
 * worse. But the fallback has to be VISIBLE. Since 2026-08-30 a system-event
 * notification links straight into these pages, and those rows live for days:
 * an operator taps "update available on agent-a", the agent has left the
 * cluster in the meantime, and without this line he reads the hub's list
 * believing it is agent-a's.
 *
 * Same rule as the rest of the admin UI: unknown is a STATE, stated in words,
 * never an absence.
 */
import { AlertTriangle } from 'lucide-react'
import { Trans } from 'react-i18next'

interface StaleNodeNoticeProps {
  /** The id the URL asked for. `null` when the URL asked for nothing real. */
  readonly staleNodeId: string | null
  /** The node actually on screen, named so the operator knows what he is reading. */
  readonly shownNodeName: string
}

export function StaleNodeNotice({ staleNodeId, shownNodeName }: StaleNodeNoticeProps) {
  if (staleNodeId === null) return null
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] text-foreground-subtle"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
      <span>
        <Trans
          i18nKey="shared.staleNodeNotice.notice"
          values={{ id: staleNodeId, name: shownNodeName }}
          components={{ b: <span className="font-medium text-foreground" /> }}
        />
      </span>
    </div>
  )
}
