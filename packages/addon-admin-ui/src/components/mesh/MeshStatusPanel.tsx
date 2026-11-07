/** The live status of a mesh provider: status grid, endpoints and the peers table. */
import { useCallback, useMemo, type ReactElement } from 'react'
import { ExternalLink, Globe, Copy, Loader2 } from 'lucide-react'
import {
  Badge,
  Button,
  DataTable,
  ErrorBox,
  useMeshNetworkListPeers,
  type DataColumn,
} from '@camstack/ui-library'
import type { MeshPeer, MeshStatus } from '@camstack/types'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'
import { useMeshStatus } from './use-mesh-status'

const SCOPE_BADGE: Record<string, string> = {
  mesh: 'bg-info/15 text-info',
  public: 'bg-primary/15 text-primary',
}

const PEERS_POLL_INTERVAL_MS = 30_000

/**
 * The mesh `status` panel — status grid, endpoints and peers, always
 * visible, above the integration's settings and activity.
 */
export function MeshStatusPanel({ addonId }: { readonly addonId: string }): ReactElement {
  const { t } = useTranslation()
  const { status } = useMeshStatus(addonId)
  const peersQuery = useMeshNetworkListPeers(
    { addonId },
    { refetchInterval: PEERS_POLL_INTERVAL_MS, retry: false },
  )

  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="space-y-4 p-2 sm:p-4">
        {status.error && <ErrorBox message={status.error} />}
        <StatusGrid status={status} />

        {status.endpoints.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[11px] font-semibold text-foreground-subtle uppercase tracking-wide">
              {t('system.meshNetworks.endpoints', 'Endpoints')}
            </div>
            {status.endpoints.map((ep) => (
              <div key={ep.id} className="flex items-center gap-2 text-xs flex-wrap">
                <span
                  className={`text-[10px] rounded-full px-2 py-0.5 font-medium ${SCOPE_BADGE[ep.scope] ?? 'bg-foreground-subtle/15 text-foreground-subtle'}`}
                >
                  {ep.scope === 'public' ? <Globe className="inline h-2.5 w-2.5 mr-0.5" /> : null}
                  {ep.label}
                </span>
                <a
                  href={ep.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-success hover:underline break-all flex items-center gap-1"
                >
                  <ExternalLink className="h-3 w-3 shrink-0" />
                  {ep.url}
                </a>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="border-t border-border">
        <PeersTable peers={peersQuery.data?.peers ?? []} loading={peersQuery.isLoading} />
      </div>
    </div>
  )
}

function StatusGrid({ status }: { status: MeshStatus }): ReactElement {
  const { t } = useTranslation()
  const rows: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: t('system.meshNetworks.tenant', 'Tenant'), value: status.tenantName || '—' },
    { label: t('system.meshNetworks.user', 'User'), value: status.userLogin ?? '—' },
    {
      label: t('system.meshNetworks.controlPlane', 'Control plane'),
      value: status.controlPlaneUrl || '—',
    },
    { label: t('system.meshNetworks.meshIp', 'Mesh IP'), value: status.meshIp || '—', mono: true },
    {
      label: t('system.meshNetworks.magicdns', 'MagicDNS'),
      value: status.magicDnsHostname || '—',
      mono: true,
    },
    {
      label: t('system.meshNetworks.dnsSuffix', 'DNS suffix'),
      value: status.magicDnsSuffix || '—',
      mono: true,
    },
    { label: t('system.meshNetworks.peers', 'Peers'), value: String(status.peerCount) },
    {
      label: t('system.meshNetworks.keyExpiry', 'Key expiry'),
      value: status.keyExpiry ? formatExpiry(status.keyExpiry) : '—',
    },
  ]
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
      {rows.map((r) => (
        <div key={r.label} className="flex items-baseline justify-between gap-3 text-xs">
          <span className="text-foreground-subtle shrink-0">{r.label}</span>
          <span className={`text-foreground truncate ${r.mono ? 'font-mono' : ''}`}>{r.value}</span>
        </div>
      ))}
    </div>
  )
}

function formatExpiry(ms: number): string {
  const delta = ms - Date.now()
  if (delta < 0) return i18n.t('system.meshNetworks.expiredAgo', { when: formatRelative(ms) })
  const days = Math.floor(delta / 86_400_000)
  if (days > 60) return new Date(ms).toLocaleDateString()
  if (days > 1) return i18n.t('system.meshNetworks.expiryDays', { count: days })
  const hours = Math.floor(delta / 3_600_000)
  if (hours > 1) return i18n.t('system.meshNetworks.expiryHours', { count: hours })
  return i18n.t('system.meshNetworks.expiryMin', { count: Math.max(1, Math.floor(delta / 60_000)) })
}

// ── Peers table ─────────────────────────────────────────────────────

interface PeerRow extends MeshPeer {
  readonly _id: string
}

function PeersTable({
  peers,
  loading,
}: {
  peers: readonly MeshPeer[]
  loading: boolean
}): ReactElement {
  const { t } = useTranslation()
  const rows = useMemo<readonly PeerRow[]>(() => peers.map((p) => ({ ...p, _id: p.id })), [peers])

  const copy = useCallback((text: string) => {
    if (text) void navigator.clipboard?.writeText(text)
  }, [])

  const columns: readonly DataColumn<PeerRow>[] = useMemo(
    () => [
      {
        key: 'hostname',
        header: t('system.meshNetworks.hostname', 'Hostname'),
        render: (row) => (
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5">
              <span className="font-medium text-foreground">
                {row.hostname || t('system.meshNetworks.unknown', '(unknown)')}
              </span>
              {row.isSelf && <Badge variant="info">{t('common.self')}</Badge>}
              {row.exitNodeOption && <Badge variant="warning">exit-node</Badge>}
            </div>
            {row.userLogin && (
              <div className="text-[10px] text-foreground-subtle truncate">{row.userLogin}</div>
            )}
          </div>
        ),
      },
      {
        key: 'magicDns',
        header: t('system.meshNetworks.magicdns', 'MagicDNS'),
        render: (row) =>
          row.magicDns ? (
            <div className="flex items-center gap-1">
              <span className="font-mono text-xs truncate">{row.magicDns}</span>
              <Button
                variant="unstyled"
                onClick={() => copy(row.magicDns)}
                className="p-0.5 hover:bg-foreground-subtle/10 rounded"
                aria-label={t('system.meshNetworks.copyMagicdns', 'Copy MagicDNS')}
              >
                <Copy className="h-3 w-3 text-foreground-subtle" />
              </Button>
            </div>
          ) : (
            <span className="text-foreground-subtle">—</span>
          ),
      },
      {
        key: 'addresses',
        header: 'IP',
        render: (row) => {
          const ip = row.addresses[0] ?? ''
          return ip ? (
            <div className="flex items-center gap-1">
              <span className="font-mono text-xs">{ip}</span>
              <Button
                variant="unstyled"
                onClick={() => copy(ip)}
                className="p-0.5 hover:bg-foreground-subtle/10 rounded"
                aria-label={t('system.meshNetworks.copyIp', 'Copy IP')}
              >
                <Copy className="h-3 w-3 text-foreground-subtle" />
              </Button>
            </div>
          ) : (
            <span className="text-foreground-subtle">—</span>
          )
        },
      },
      {
        key: 'connection',
        header: t('system.meshNetworks.connection', 'Connection'),
        render: (row) => (
          <div className="flex items-center gap-1.5">
            <Badge variant={connectionVariant(row.connection)}>{row.connection}</Badge>
            {row.relay && (
              <span className="text-[10px] text-foreground-subtle font-mono">{row.relay}</span>
            )}
          </div>
        ),
      },
      {
        key: 'routes',
        header: t('system.meshNetworks.routes', 'Routes'),
        render: (row) =>
          row.advertisedRoutes.length > 0 ? (
            <span className="text-[10px] font-mono text-foreground-subtle truncate">
              {row.advertisedRoutes.join(', ')}
            </span>
          ) : (
            <span className="text-foreground-subtle">—</span>
          ),
      },
      {
        key: 'tx',
        header: t('system.meshNetworks.txRx', 'TX / RX'),
        render: (row) => (
          <span className="text-[10px] text-foreground-subtle font-mono">
            ↑ {formatBytes(row.txBytes)} · ↓ {formatBytes(row.rxBytes)}
          </span>
        ),
      },
      {
        key: 'lastSeen',
        header: t('system.meshNetworks.lastSeen', 'Last seen'),
        render: (row) => (
          <span className="text-[10px] text-foreground-subtle">
            {row.lastSeenMs > 0 ? formatRelative(row.lastSeenMs) : '—'}
          </span>
        ),
      },
    ],
    [copy, t],
  )

  if (loading && peers.length === 0) {
    return (
      <div className="p-4 text-xs text-foreground-subtle">
        <Loader2 className="h-3 w-3 animate-spin inline mr-1" />{' '}
        {t('systemPage.meshNetworks.loadingPeers')}
      </div>
    )
  }
  if (peers.length === 0) {
    return (
      <div className="p-4 text-xs text-foreground-subtle">
        {t(
          'system.meshNetworks.noPeersVisibleYourTailnet',
          'No peers visible — your tailnet may be empty or the host is not joined.',
        )}
      </div>
    )
  }
  return (
    <div className="p-4">
      <DataTable columns={columns} rows={rows} rowKey={(row) => row._id} minWidthPx={820} />
    </div>
  )
}

function connectionVariant(conn: MeshPeer['connection']): 'success' | 'warning' | 'info' {
  if (conn === 'direct') return 'success'
  if (conn === 'relay') return 'warning'
  return 'info'
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`
}

function formatRelative(ms: number): string {
  const delta = Date.now() - ms
  if (delta < 60_000) return i18n.t('system.meshNetworks.justNow')
  if (delta < 3_600_000)
    return i18n.t('system.meshNetworks.agoMin', { count: Math.round(delta / 60_000) })
  if (delta < 86_400_000)
    return i18n.t('system.meshNetworks.agoHour', { count: Math.round(delta / 3_600_000) })
  return i18n.t('system.meshNetworks.agoDay', { count: Math.round(delta / 86_400_000) })
}
