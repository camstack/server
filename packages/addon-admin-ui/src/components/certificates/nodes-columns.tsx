/**
 * Columns of the merged Nodes table. The headers say which certificate a
 * column is about ("HTTPS …" is what the node serves, "Identity …" is what it
 * presents to the hub) — two certificates, two CAs, one row per node.
 * Row actions follow Tokens & sessions: ghost buttons with a label, the
 * destructive one in the danger tone, a disabled one saying why.
 */
import {
  Badge,
  Button,
  type DataColumn,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@camstack/ui-library'
import { Ban, Loader2, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'

import {
  dateStringToMs,
  describeExpiry,
  expiryTone,
  formatDateTime,
  httpsRenewPolicy,
  shortFingerprint,
  shortSerial,
} from './certificate-model'
import {
  HUB_NODE_ID,
  identityBlockedReason,
  identityRevokeBlockedReason,
  type NodeCertificateRow,
} from './nodes-model'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

const TONE_CLASS = {
  ok: 'text-foreground-subtle',
  soon: 'text-warning',
  expired: 'text-danger',
  unknown: 'text-foreground-subtle',
} as const

const ISSUED_VIA_LABEL = {
  enroll: 'Issued at enrollment',
  renewal: 'Issued by a renewal',
  boot: 'Issued at boot',
  pairing: 'Issued at pairing',
  observed: 'Observed on its connection',
} as const

const MODE_LABEL = {
  uploaded: 'Uploaded',
  generated: 'Generated',
  disabled: 'Disabled',
} as const

export type NodeAction = 'renew-https' | 'renew-identity' | 'revoke-identity'

export interface NodeColumnOptions {
  readonly now: number
  /** Whether the whole table is writing: one write at a time. */
  readonly busy: boolean
  /** The node + action in flight, if any. */
  readonly running: {
    readonly nodeId: string
    readonly action: NodeAction
  } | null
  readonly onRenewHttps: (row: NodeCertificateRow) => void
  readonly onRenewIdentity: (row: NodeCertificateRow) => void
  readonly onRevokeIdentity: (row: NodeCertificateRow) => void
}

function httpsExpiryMs(row: NodeCertificateRow): number | null {
  const https = row.https?.https
  return https?.kind === 'served' ? dateStringToMs(https.status.validTo) : null
}

function Expiry({ ms, now }: { readonly ms: number | null; readonly now: number }): ReactNode {
  if (ms === null) return <span className="text-foreground-subtle">—</span>
  return (
    <div>
      <div>{formatDateTime(ms)}</div>
      <div className={`text-[10px] ${TONE_CLASS[expiryTone(ms, now)]}`}>
        {describeExpiry(ms, now)}
      </div>
    </div>
  )
}

function HttpsState({ row }: { readonly row: NodeCertificateRow }): ReactNode {
  const { t } = useTranslation()
  const https = row.https?.https
  if (https === undefined) return <span className="text-foreground-subtle">—</span>
  if (https.kind === 'served') {
    return (
      <div title={https.status.leafFingerprintSha256 ?? ''}>
        <Badge variant="success" className="text-[10px]">
          {t('certificates.nodesColumns.served', 'Served')}
        </Badge>
        <span className="ml-1.5 text-[10px] text-foreground-subtle">
          {MODE_LABEL[https.status.mode]}
        </span>
        <div className="mt-1 font-mono text-[10px] text-foreground-subtle">
          {shortFingerprint(https.status.leafFingerprintSha256)}
        </div>
        {https.status.sans.length > 0 && (
          <div
            className="mt-0.5 max-w-[14rem] truncate font-mono text-[10px] text-foreground-subtle"
            title={https.status.sans.join(', ')}
          >
            {https.status.sans.join(', ')}
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="max-w-[16rem]">
      <Badge variant={https.kind === 'unreadable' ? 'danger' : 'warning'} className="text-[10px]">
        {https.kind === 'unreadable'
          ? t('certificates.nodesColumns.unreadable', 'Unreadable')
          : t('certificates.nodesColumns.notServed', 'Not served')}
      </Badge>
      <div className="mt-1 whitespace-normal text-[10px] text-foreground-subtle">
        {https.reason}
      </div>
    </div>
  )
}

function IdentityCell({ row }: { readonly row: NodeCertificateRow }): ReactNode {
  const { t } = useTranslation()
  const leaf = row.mesh?.current ?? null
  if (leaf === null)
    return (
      <span className="text-foreground-subtle">
        {t('certificates.nodesColumns.noneRecorded', 'None recorded')}
      </span>
    )
  const earlier = row.mesh?.history.length ?? 0
  return (
    <div>
      <div className="font-mono text-[11px]" title={leaf.serial}>
        {shortSerial(leaf.serial)}
      </div>
      <div className="font-mono text-[10px] text-foreground-subtle" title={leaf.fingerprintSha256}>
        {shortFingerprint(leaf.fingerprintSha256)}
      </div>
      <div className="text-[10px] text-foreground-subtle">
        {ISSUED_VIA_LABEL[leaf.issuedVia]}
        {earlier > 0 ? ` · ${t('certificates.nodesColumns.earlier', { count: earlier })}` : ''}
      </div>
    </div>
  )
}

function Presenting({ row }: { readonly row: NodeCertificateRow }): ReactNode {
  const { t } = useTranslation()
  const presenting = row.mesh?.presentingCurrent ?? null
  if (presenting === null) {
    return (
      <span className="text-foreground-subtle">
        {row.online ? '—' : t('certificates.nodesColumns.offline', 'Offline')}
      </span>
    )
  }
  return presenting ? (
    <Badge variant="success" className="text-[10px]">
      {t('common.yes', 'Yes')}
    </Badge>
  ) : (
    <Badge variant="warning" className="text-[10px]">
      {t('certificates.nodesColumns.noPresentsAnother', 'No - presents another')}
    </Badge>
  )
}

interface RowButtonProps {
  readonly label: string
  readonly ariaLabel: string
  readonly icon: typeof RefreshCw
  readonly reason: string | null
  readonly busy: boolean
  readonly spinning: boolean
  readonly danger: boolean
  readonly onClick: () => void
}

function RowButton(p: RowButtonProps): ReactNode {
  const Icon = p.icon
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={p.danger ? 'text-danger hover:bg-danger/10' : undefined}
      disabled={p.reason !== null || p.busy}
      title={p.reason ?? undefined}
      aria-label={p.ariaLabel}
      onClick={p.onClick}
    >
      {p.spinning ? (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      ) : (
        <Icon className="h-3 w-3" aria-hidden />
      )}
      {p.label}
    </Button>
  )
}

/** The hub's own row: nothing to click, the reasons live in a tooltip. */
function HubManaged({ reasons }: { readonly reasons: readonly string[] }): ReactNode {
  const { t } = useTranslation()
  return (
    <Tooltip className="inline-block">
      <TooltipTrigger>
        <span
          className="cursor-help text-[11px] text-foreground-subtle"
          data-testid="hub-managed-note"
        >
          {t('certificates.nodesColumns.managedByTheHub', 'Managed by the hub')}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <ul className="max-w-xs space-y-1 whitespace-normal text-left text-[11px]">
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  )
}

function Actions({
  row,
  o,
}: {
  readonly row: NodeCertificateRow
  readonly o: NodeColumnOptions
}): ReactNode {
  const { t } = useTranslation()
  const httpsReason =
    row.https === null ? 'No HTTPS inventory for this node.' : httpsRenewPolicy(row.https).reason
  const renewReason = identityBlockedReason(row)
  const revokeReason = identityRevokeBlockedReason(row)
  const is = (a: NodeAction): boolean => o.running?.nodeId === row.nodeId && o.running.action === a
  // The hub row shows only the actions that work (usually none) and one muted note;
  // the reasons for the blocked ones live in its tooltip, not as dead buttons.
  const shown = (reason: string | null): boolean => !row.isHub || reason === null
  const hubReasons = [httpsReason, renewReason, revokeReason].filter(
    (r, i, all): r is string => r !== null && all.indexOf(r) === i,
  )
  return (
    <div className="flex w-44 flex-col items-end gap-1">
      <div className="flex flex-col items-end gap-0.5">
        {shown(httpsReason) && (
          <RowButton
            label={t('certificates.nodesColumns.renewHttps', 'Renew HTTPS')}
            ariaLabel={t(
              'certificates.nodesColumns.renewTheCertificateOn',
              'Renew the certificate on {{nodeId}}',
              { nodeId: row.nodeId },
            )}
            icon={RefreshCw}
            reason={httpsReason}
            busy={o.busy}
            spinning={is('renew-https')}
            danger={false}
            onClick={() => o.onRenewHttps(row)}
          />
        )}
        {shown(renewReason) && (
          <RowButton
            label={
              is('renew-identity')
                ? t('certificates.nodesColumns.renewing', 'Renewing…')
                : t('certificates.nodesColumns.renewIdentity', 'Renew identity')
            }
            ariaLabel={t(
              'certificates.nodesColumns.renewTheClusterCertificateOf',
              'Renew the cluster certificate of {{nodeId}}',
              { nodeId: row.nodeId },
            )}
            icon={RefreshCw}
            reason={renewReason}
            busy={o.busy}
            spinning={is('renew-identity')}
            danger={false}
            onClick={() => o.onRenewIdentity(row)}
          />
        )}
        {shown(revokeReason) && (
          <RowButton
            label={t('certificates.nodesColumns.revokeIdentity', 'Revoke identity')}
            ariaLabel={t(
              'certificates.nodesColumns.revokeTheClusterCertificateOf',
              'Revoke the cluster certificate of {{nodeId}}',
              { nodeId: row.nodeId },
            )}
            icon={Ban}
            reason={revokeReason}
            busy={o.busy}
            spinning={is('revoke-identity')}
            danger
            onClick={() => o.onRevokeIdentity(row)}
          />
        )}
      </div>
      {row.isHub && hubReasons.length > 0 && <HubManaged reasons={hubReasons} />}
      {!row.isHub && httpsReason !== null && row.https !== null && (
        <div
          className="w-full whitespace-normal text-right text-[10px] text-foreground-subtle"
          data-testid={`renew-reason-${row.nodeId}`}
        >
          {httpsReason}
        </div>
      )}
      {!row.isHub && renewReason !== null && (
        <div
          className="w-full whitespace-normal text-right text-[10px] text-foreground-subtle"
          data-testid={`mesh-reason-${row.nodeId}`}
        >
          {renewReason}
        </div>
      )}
    </div>
  )
}

export function nodeColumns(o: NodeColumnOptions): DataColumn<NodeCertificateRow>[] {
  return [
    {
      key: 'node',
      header: i18n.t('certificates.nodesColumns.node', 'Node'),
      sortValue: (r) => (r.isHub ? '' : r.nodeId.toLowerCase()),
      render: (r) => (
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-foreground">{r.nodeId}</span>
          {r.nodeId === HUB_NODE_ID && (
            <Badge variant="info" className="text-[10px]">
              {i18n.t('common.hubWord')}
            </Badge>
          )}
          {!r.online && (
            <Badge variant="default" className="text-[10px]">
              {i18n.t('common.offline')}
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: 'https-state',
      header: 'HTTPS',
      notSortableReason: 'A state with a reason has no single order.',
      render: (r) => <HttpsState row={r} />,
    },
    {
      key: 'https-expires',
      header: i18n.t('certificates.nodesColumns.httpsExpires', 'HTTPS expires'),
      sortValue: (r) => httpsExpiryMs(r),
      render: (r) => <Expiry ms={httpsExpiryMs(r)} now={o.now} />,
    },
    {
      key: 'identity',
      header: i18n.t('certificates.nodesColumns.identity', 'Identity'),
      sortValue: (r) => r.mesh?.current?.serial ?? null,
      render: (r) => <IdentityCell row={r} />,
    },
    {
      key: 'identity-expires',
      header: i18n.t('certificates.nodesColumns.identityExpires', 'Identity expires'),
      sortValue: (r) => r.mesh?.current?.notAfter ?? null,
      render: (r) => <Expiry ms={r.mesh?.current?.notAfter ?? null} now={o.now} />,
    },
    {
      key: 'presenting',
      header: i18n.t('certificates.nodesColumns.inUse', 'In use'),
      notSortableReason: 'Offline nodes have no answer to order by.',
      render: (r) => <Presenting row={r} />,
    },
    {
      key: 'actions',
      header: i18n.t('certificates.nodesColumns.actions', 'Actions'),
      align: 'right',
      notSortableReason: 'Actions have no order.',
      render: (r) => <Actions row={r} o={o} />,
    },
  ]
}
