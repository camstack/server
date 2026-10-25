/**
 * The integration selector: one pill per integration — its ICON next to its
 * NAME — sitting in the page header. The pill on screen is marked current; the
 * rest are links (`?integration=<id>`), so a middle-click opens one in a new
 * tab and back/forward walks them.
 *
 * Links, not `role="tab"` buttons: choosing one changes the address, and a
 * tab pattern promises arrow-key roving and a tabpanel this is not. `nav` +
 * `aria-current` is the honest semantics for "pick a page's worth of content".
 *
 * The pills WRAP, at every width — same rule as the Nodes fleet strip: a pill
 * that wrapped to a second line is still visible; one scrolled off a strip is
 * not. On a phone each group's label takes its own line above its pills, so
 * the row never pushes the page sideways; from `sm` up the labels are a column
 * and every group's pills start on one line.
 */
import { Plus } from 'lucide-react'
import type { ReactElement } from 'react'
import { Link } from 'react-router-dom'

import { addonCatalogHref } from '../../lib/integration-hub-url'
import { PILL_BASE, PILL_CURRENT, PILL_OTHER } from '../HeaderPills'
import { AddonAssetIcon } from '../shared/AddonAssetIcon'
import type { IntegrationEntry, IntegrationGroup, IntegrationState } from './types'

const STATE_DOT: Record<IntegrationState, string> = {
  ok: 'bg-success',
  off: 'bg-foreground-subtle/60',
  error: 'bg-danger',
  unknown: 'border border-foreground-subtle bg-transparent',
}

interface IntegrationPillsProps {
  /** Names the selector for assistive tech ("Connectivity integrations"). */
  readonly label: string
  readonly groups: readonly IntegrationGroup[]
  readonly selectedId: string | null
  readonly hrefFor: (integrationId: string) => string
}

export function IntegrationPills({
  label,
  groups,
  selectedId,
  hrefFor,
}: IntegrationPillsProps): ReactElement {
  const labelled = groups.length > 1
  return (
    <nav
      aria-label={label}
      // With several groups the labels form a column from `sm` up, so the
      // pills of every group start on one line — a definition list, not a
      // run-on row where a group starts wherever the previous one ended.
      className={
        labelled
          ? 'flex flex-col gap-2 sm:grid sm:grid-cols-[max-content_minmax(0,1fr)] sm:items-start sm:gap-x-3'
          : 'flex flex-col'
      }
    >
      {groups.map((group) => (
        <div
          key={group.id}
          role="group"
          aria-label={group.label}
          className={
            labelled
              ? 'flex min-w-0 flex-col gap-1 sm:col-span-2 sm:grid sm:grid-cols-subgrid sm:items-start'
              : 'min-w-0'
          }
        >
          {labelled && (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle sm:pt-2">
              {group.label}
            </span>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {group.entries.map((entry) => (
              <IntegrationPill
                key={entry.id}
                entry={entry}
                current={entry.id === selectedId}
                href={hrefFor(entry.id)}
              />
            ))}
            {group.install && (
              <Link
                to={addonCatalogHref(group.install.capability)}
                className={`${PILL_BASE} border-dashed border-border pl-2 text-foreground-subtle hover:border-primary/50 hover:text-foreground`}
              >
                <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="truncate">{group.install.label}</span>
              </Link>
            )}
          </div>
        </div>
      ))}
    </nav>
  )
}

function IntegrationPill({
  entry,
  current,
  href,
}: {
  readonly entry: IntegrationEntry
  readonly current: boolean
  readonly href: string
}): ReactElement {
  const quiet = entry.state === 'ok'
  return (
    <Link
      to={href}
      aria-current={current ? 'true' : undefined}
      className={`${PILL_BASE} ${current ? PILL_CURRENT : PILL_OTHER}`}
      data-testid={`integration-pill-${entry.id}`}
    >
      <AddonAssetIcon addonId={entry.id} fallback={entry.fallbackIcon} tileClassName="" size="sm" />
      <span className="truncate">{entry.name}</span>
      {entry.showState !== false && <PillState entry={entry} quiet={quiet} />}
    </Link>
  )
}

function PillState({
  entry,
  quiet,
}: {
  readonly entry: IntegrationEntry
  readonly quiet: boolean
}): ReactElement {
  return (
    <>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATE_DOT[entry.state]}`} aria-hidden />
      {/* The state in words: visible whenever it is not the healthy default,
          read out always — a dot alone fails a red-green reader and a
          monochrome screenshot. */}
      <span
        className={quiet ? 'sr-only' : 'shrink-0 text-[10px] font-normal text-foreground-subtle'}
      >
        {entry.stateLabel}
      </span>
    </>
  )
}
