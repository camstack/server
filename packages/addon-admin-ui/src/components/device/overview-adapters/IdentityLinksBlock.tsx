/**
 * The device's identity links (D1063), under its declared identifiers: the
 * PoE port that powers it, or another integration's record of the same
 * object. A proposal waits for the operator (Confirm / Dismiss); a link can be
 * undone (Unlink). Nothing here is edited by hand — a link comes only from
 * identifiers the providers declared.
 *
 * An unanswered read is never "none" (D315): pending draws a skeleton, a
 * store not read yet says so, and only an ANSWERED empty list says none.
 */
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { IdentityLink, IdentityLinkDecision } from '@camstack/types'
import {
  Button,
  ConfirmActionButton,
  Skeleton,
  useDeviceManagerConfirmIdentityLink,
  useDeviceManagerDismissIdentityLink,
  useDeviceManagerGetDevice,
  useDeviceManagerListIdentityLinks,
  useDeviceManagerUnlinkIdentity,
} from '@camstack/ui-library'
import { devicePath } from '../../../lib/customization-routes'
import { InfoRow } from './shared/overview-primitives'

export interface IdentityLinksBlockProps {
  readonly deviceId: number
}

/** How a link reads from THIS device's side. */
export type LinkRelation = 'same-device' | 'powered-by' | 'powers'

export function linkRelation(link: IdentityLink, deviceId: number): LinkRelation {
  if (link.kind === 'same-device') return 'same-device'
  return link.a.deviceId === deviceId ? 'powers' : 'powered-by'
}

/** A refused decision (`not-loaded`, `wrong-state`, …) is an error the operator sees, never a silent no-op. */
export function requireDecided(answer: IdentityLinkDecision): IdentityLink {
  if (!answer.ok) throw new Error(answer.message)
  return answer.link
}

/** The links worth showing: a dismissed one is the operator's "no", kept only so it is not re-proposed. */
export function visibleLinks(links: readonly IdentityLink[]): readonly IdentityLink[] {
  return links.filter((l) => l.state !== 'dismissed')
}

export function IdentityLinksBlock({ deviceId }: IdentityLinksBlockProps) {
  const { t } = useTranslation()
  const query = useDeviceManagerListIdentityLinks({ deviceId })
  const header = (
    <div className="px-3 sm:px-4 py-1.5 text-[10px] text-foreground-subtle border-y border-border">
      {t(
        'overviewAdapters.identityLinks.header',
        'Linked devices, matched on the identifiers above.',
      )}
    </div>
  )
  if (query.error) {
    return (
      <>
        {header}
        <p className="px-3 sm:px-4 py-2 text-xs text-foreground-muted">
          {t('overviewAdapters.identityLinks.unavailable', 'Linked devices could not be read.')}
        </p>
      </>
    )
  }
  if (query.data === undefined) {
    return (
      <>
        {header}
        <div className="px-3 sm:px-4 py-2" data-testid="identity-links-pending">
          <Skeleton className="h-4 w-1/2" />
        </div>
      </>
    )
  }
  if (query.data.status === 'not-loaded') {
    return (
      <>
        {header}
        <p className="px-3 sm:px-4 py-2 text-xs text-foreground-muted">
          {t('overviewAdapters.identityLinks.notLoaded', 'Linked devices are not read yet.')}
        </p>
      </>
    )
  }
  const links = visibleLinks(query.data.links)
  return (
    <>
      {header}
      {links.length === 0 ? (
        <p className="px-3 sm:px-4 py-2 text-xs text-foreground-muted">
          {t('overviewAdapters.identityLinks.none', 'No linked devices.')}
        </p>
      ) : (
        <div className="divide-y divide-border">
          {links.map((link) => (
            <IdentityLinkRow key={link.id} link={link} deviceId={deviceId} />
          ))}
        </div>
      )}
    </>
  )
}

interface IdentityLinkRowProps {
  readonly link: IdentityLink
  readonly deviceId: number
}

function IdentityLinkRow({ link, deviceId }: IdentityLinkRowProps) {
  const { t } = useTranslation()
  const other = link.a.deviceId === deviceId ? link.b : link.a
  const { data: otherDevice } = useDeviceManagerGetDevice({
    deviceId: other.deviceId,
  })
  const queryClient = useQueryClient()
  // A decision changes this device's links and, through Customize, its capabilities.
  const refresh = {
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [['deviceManager']] }),
  }
  const confirm = useDeviceManagerConfirmIdentityLink(refresh)
  const dismiss = useDeviceManagerDismissIdentityLink(refresh)
  const unlink = useDeviceManagerUnlinkIdentity(refresh)
  const relationLabel: Record<LinkRelation, string> = {
    'same-device': t('overviewAdapters.identityLinks.sameDevice', 'Same device'),
    'powered-by': t('overviewAdapters.identityLinks.poweredBy', 'Powered by'),
    powers: t('overviewAdapters.identityLinks.powers', 'Powers'),
  }
  const [refusal, setRefusal] = useState<string | null>(null)
  const decide = (run: Promise<IdentityLinkDecision>): void => {
    setRefusal(null)
    run.then(requireDecided).catch((err: unknown) => {
      setRefusal(err instanceof Error ? err.message : String(err))
    })
  }
  const name = otherDevice?.name ?? `#${other.deviceId}`
  const proposed = link.state === 'proposed'
  return (
    <InfoRow
      label={relationLabel[linkRelation(link, deviceId)]}
      value={
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <Link to={devicePath(other.deviceId)} className="text-primary hover:underline truncate">
            {name}
          </Link>
          {proposed && (
            <span className="text-[11px] text-warning">
              {t('overviewAdapters.identityLinks.proposed', 'Suggested')}
            </span>
          )}
          {link.evidenceGone === true && (
            <span className="text-[11px] text-foreground-subtle">
              {t('overviewAdapters.identityLinks.evidenceGone', 'No longer matched')}
            </span>
          )}
          <span className="ml-auto flex gap-1.5">
            {proposed ? (
              <>
                <Button
                  size="sm"
                  disabled={confirm.isPending}
                  onClick={() => decide(confirm.mutateAsync({ linkId: link.id }))}
                >
                  {t('overviewAdapters.identityLinks.confirm', 'Confirm')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={dismiss.isPending}
                  onClick={() => decide(dismiss.mutateAsync({ linkId: link.id }))}
                >
                  {t('overviewAdapters.identityLinks.dismiss', 'Dismiss')}
                </Button>
              </>
            ) : (
              <ConfirmActionButton
                size="sm"
                label={t('overviewAdapters.identityLinks.unlink', 'Unlink')}
                title={t('overviewAdapters.identityLinks.unlinkTitle', 'Unlink these devices?')}
                description={t(
                  'overviewAdapters.identityLinks.unlinkBody',
                  'The link is removed and not suggested again. Anything it added in Customize is removed with it.',
                )}
                action={async () => requireDecided(await unlink.mutateAsync({ linkId: link.id }))}
              />
            )}
          </span>
          {refusal !== null && (
            <span className="basis-full text-[11px] text-danger">{refusal}</span>
          )}
        </div>
      }
    />
  )
}
