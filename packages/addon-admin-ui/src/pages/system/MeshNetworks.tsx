/**
 * Mesh Networks page — one card per `mesh-network` provider registered
 * on the hub (Tailscale today, Headscale / ZeroTier later). The page is
 * provider-agnostic: it enumerates providers via the `addons` cap's
 * generic `listCapabilityProviders` and queries each provider's
 * `mesh-network.getStatus` for the generic status (tenant, user,
 * endpoints, key expiry, …).
 *
 * An `<IntegrationHub>` page (Network → Mesh Networks): the pills, the
 * Enable/Disable toggle, Restart, the schema settings and the activity
 * stream are all the base's. This page only contributes what's genuinely
 * mesh-specific:
 *   • The PRIMARY action — Connect / Disconnect / Log out.
 *   • Joined / peer-count status badges.
 *   • A `status` panel — the status grid, endpoints, and the peers table —
 *     above the settings (`?section=status`).
 *
 * Routing: `mesh-network` is a collection cap; every method
 * (`getStatus`, `startLogin`, `leave`, `logout`, `listPeers`) accepts an
 * optional `addonId` that targets the matching provider.
 */
import { useCallback, useMemo, useState, type ReactElement } from 'react'
import {
  Boxes,
  LogIn,
  LogOut,
  Loader2,
  ExternalLink,
  Network as NetworkIcon,
  Globe,
  Copy,
  X,
  ShieldOff,
} from 'lucide-react'
import {
  Button,
  Badge,
  DataTable,
  ErrorBox,
  type DataColumn,
  useAddonsList,
  useAddonsListCapabilityProviders,
  useMeshNetworkGetStatus,
  useMeshNetworkListPeers,
  useMeshNetworkStartLogin,
  useMeshNetworkLeave,
  useMeshNetworkLogout,
  useSystem,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { MeshStatusSchema } from '@camstack/types'
import type { MeshPeer, MeshStatus } from '@camstack/types'
import { AddonIntegrationBody } from '../../components/integration-hub/AddonIntegrationBody'
import { STATUS_BADGE_CLASS } from '../../components/integration-hub/addon-controls'
import { IntegrationHub } from '../../components/integration-hub/IntegrationHub'
import { providerPillState, type IntegrationGroup } from '../../components/integration-hub/types'
import { buildAddonDisplayNameMap } from '../../lib/addon-display-names'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

const SCOPE_BADGE: Record<string, string> = {
  mesh: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  public: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
}

const STATUS_POLL_INTERVAL_MS = 5_000
const CAPABILITY = 'mesh-network'
const PEERS_POLL_INTERVAL_MS = 30_000

const EMPTY_STATUS: MeshStatus = {
  joined: false,
  meshIp: '',
  magicDnsHostname: '',
  peerCount: 0,
  endpoints: [],
  tenantName: '',
  magicDnsSuffix: '',
  userLogin: null,
  controlPlaneUrl: '',
  keyExpiry: null,
}

/**
 * One enumerated `mesh-network` provider; the live `MeshStatus` is queried
 * per provider via `meshNetwork.getStatus({ addonId })`.
 */
interface MeshProviderRow {
  readonly addonId: string
  readonly displayName: string
  readonly isActive: boolean
}

export function MeshNetworksPage(): ReactElement {
  const { t } = useTranslation()
  const providersQuery = useAddonsListCapabilityProviders(
    { capName: 'mesh-network' },
    { refetchInterval: STATUS_POLL_INTERVAL_MS },
  )
  const addonsQuery = useAddonsList(undefined, { refetchInterval: STATUS_POLL_INTERVAL_MS })

  const displayNames = useMemo(
    () => buildAddonDisplayNameMap(addonsQuery.data ?? []),
    [addonsQuery.data],
  )

  const providers = useMemo<readonly MeshProviderRow[]>(
    () =>
      (providersQuery.data ?? []).map((p) => ({
        addonId: p.addonId,
        displayName: displayNames.get(p.addonId) ?? p.addonId,
        isActive: p.isActive,
      })),
    [providersQuery.data, displayNames],
  )

  const groups: readonly IntegrationGroup[] = [
    {
      id: CAPABILITY,
      label: t('system.meshNetworks.meshNetworks', 'Mesh networks'),
      install: { capability: CAPABILITY, label: t('system.meshNetworks.addMesh', 'Add mesh') },
      entries: providers.map((p) => ({
        id: p.addonId,
        name: p.displayName,
        fallbackIcon: NetworkIcon,
        ...providerPillState(p.isActive),
        render: () => (
          <AddonIntegrationBody
            addonId={p.addonId}
            displayName={p.displayName}
            capName={CAPABILITY}
            isActive={p.isActive}
            badges={<ProviderStatusBadges addonId={p.addonId} />}
            primaryAction={<ProviderPrimaryAction addonId={p.addonId} />}
            panels={[
              {
                id: 'status',
                title: t('system.meshNetworks.status', 'Status'),
                icon: Boxes,
                content: <MeshProviderPanel addonId={p.addonId} />,
              },
            ]}
          />
        ),
      })),
    },
  ]

  return (
    <IntegrationHub
      embedded
      icon={Boxes}
      title={t('system.meshNetworks.meshNetworks2', 'Mesh Networks')}
      subtitle={t(
        'system.meshNetworks.privateVpnMeshesThatConnect',
        'Private VPN meshes that connect CamStack to your other devices (Tailscale, Headscale, …). Each provider can also expose this hub publicly via its ingress (Tailscale Funnel).',
      )}
      groups={groups}
      isLoading={providersQuery.isLoading}
      emptyTitle={t(
        'system.meshNetworks.noMeshNetworkProvidersInstalled',
        'No mesh-network providers installed',
      )}
      emptyDescription={t(
        'system.meshNetworks.installAMeshAddonE',
        'Install a mesh addon (e.g. @camstack/addon-tailscale) to join this hub into a private VPN mesh.',
      )}
    />
  )
}

/**
 * Live status of one provider, validated against `MeshStatusSchema`.
 * `getStatus`'s codegen'd wire output is `unknown`; the safeParse keeps
 * a typed value without a cast. Cold-start falls back to `EMPTY_STATUS`.
 */
function useMeshStatus(addonId: string): { status: MeshStatus; isLoading: boolean } {
  const { data, isLoading } = useMeshNetworkGetStatus(
    { addonId },
    { refetchInterval: STATUS_POLL_INTERVAL_MS, retry: false },
  )
  const parsed = data ? MeshStatusSchema.safeParse(data) : null
  return {
    status: parsed?.success ? parsed.data : EMPTY_STATUS,
    isLoading,
  }
}

// ── Status badges (Joined / peer count) ─────────────────────────────

function ProviderStatusBadges({ addonId }: { readonly addonId: string }): ReactElement {
  const { t } = useTranslation()
  const { status } = useMeshStatus(addonId)
  return (
    <>
      <Badge variant={status.joined ? 'success' : 'default'} className={STATUS_BADGE_CLASS}>
        {status.joined
          ? t('system.meshNetworks.joined', 'Joined')
          : t('system.meshNetworks.notJoined', 'Not joined')}
      </Badge>
      {status.joined && (
        <Badge className={STATUS_BADGE_CLASS}>
          {t('common.peers', { count: status.peerCount })}
        </Badge>
      )}
    </>
  )
}

// ── Primary action (Connect / Disconnect / Logout) ──────────────────

/**
 * The page-specific PRIMARY lifecycle action. The provider's live
 * `joined` state drives what's visible:
 *   • joined         → Disconnect + Logout
 *   • not joined     → Connect + Logout (lets the operator wipe cached
 *                      credentials before pasting an auth key)
 *   • connecting     → Cancel (poll abort)
 *
 * Connect drives the browser-redirect login flow: `meshNetwork.startLogin`
 * opens the provider's auth URL in a new tab, then we poll
 * `meshNetwork.getStatus({ addonId })` until the provider reports
 * `joined: true`. (Restart lives in the common surface.)
 */
function ProviderPrimaryAction({ addonId }: { readonly addonId: string }): ReactElement {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [connecting, setConnecting] = useState<boolean>(false)
  const [pollAbort, setPollAbort] = useState<{ cancelled: boolean } | null>(null)
  const system = useSystem()
  const { status } = useMeshStatus(addonId)

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: [['meshNetwork']] })
  }, [queryClient])

  const startLoginMutation = useMeshNetworkStartLogin()
  const leaveMutation = useMeshNetworkLeave({ onSuccess: invalidate })
  const logoutMutation = useMeshNetworkLogout({ onSuccess: invalidate })

  const startConnect = useCallback(async () => {
    setConnecting(true)
    const abort = { cancelled: false }
    setPollAbort(abort)
    try {
      const result = await startLoginMutation.mutateAsync({ addonId })
      if (abort.cancelled) return
      // Empty loginUrl = silent re-login from cached daemon credentials
      // (the provider exited 0 before printing a URL). Skip the popup
      // and let the status poll below detect the join.
      if (result.loginUrl) {
        window.open(result.loginUrl, '_blank', 'noopener,noreferrer')
      }
      const startedAt = Date.now()
      const MAX_POLL_MS = 10 * 60_000
      while (!abort.cancelled) {
        await sleep(2_000)
        if (abort.cancelled) break
        const snap = await system.trpcClient.meshNetwork.getStatus
          .query({ addonId })
          .catch(() => null)
        const parsed = snap ? MeshStatusSchema.safeParse(snap) : null
        if (parsed?.success && parsed.data.joined) {
          invalidate()
          break
        }
        if (Date.now() - startedAt > MAX_POLL_MS) {
          // Surface failures via the status error banner — the next
          // status poll picks up the provider's own state.
          break
        }
      }
    } finally {
      setConnecting(false)
      setPollAbort(null)
    }
  }, [addonId, invalidate, startLoginMutation, system])

  const cancelConnect = useCallback(() => {
    if (pollAbort) pollAbort.cancelled = true
    setConnecting(false)
    setPollAbort(null)
  }, [pollAbort])

  return (
    <>
      {status.joined ? (
        <>
          <Button
            size="sm"
            variant="secondary"
            disabled={leaveMutation.isPending}
            onClick={() => leaveMutation.mutate({ addonId })}
          >
            {leaveMutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <LogOut className="h-3 w-3" />
            )}
            {t('system.meshNetworks.disconnect', 'Disconnect')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={logoutMutation.isPending}
            onClick={() => logoutMutation.mutate({ addonId })}
          >
            {logoutMutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <ShieldOff className="h-3 w-3" />
            )}
            {t('system.meshNetworks.logOut', 'Log out')}
          </Button>
        </>
      ) : connecting ? (
        <Button size="sm" variant="ghost" onClick={cancelConnect}>
          <X className="h-3 w-3 mr-1" /> {t('common.cancel')}
        </Button>
      ) : (
        <>
          <Button size="sm" variant="primary" onClick={() => void startConnect()}>
            <LogIn className="h-3 w-3" />
            {t('system.meshNetworks.connect', 'Connect')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={logoutMutation.isPending}
            onClick={() => logoutMutation.mutate({ addonId })}
          >
            {logoutMutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <ShieldOff className="h-3 w-3" />
            )}
            {t('system.meshNetworks.logOut', 'Log out')}
          </Button>
        </>
      )}
    </>
  )
}

// ── Expanded panel (status grid + endpoints + peers) ────────────────

/**
 * The mesh `status` panel — status grid, endpoints and peers, always
 * visible, above the integration's settings and activity.
 */
function MeshProviderPanel({ addonId }: { readonly addonId: string }): ReactElement {
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
                  className="text-emerald-700 dark:text-emerald-300 hover:underline break-all flex items-center gap-1"
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
              <button
                onClick={() => copy(row.magicDns)}
                className="p-0.5 hover:bg-foreground-subtle/10 rounded"
                aria-label={t('system.meshNetworks.copyMagicdns', 'Copy MagicDNS')}
              >
                <Copy className="h-3 w-3 text-foreground-subtle" />
              </button>
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
              <button
                onClick={() => copy(ip)}
                className="p-0.5 hover:bg-foreground-subtle/10 rounded"
                aria-label={t('system.meshNetworks.copyIp', 'Copy IP')}
              >
                <Copy className="h-3 w-3 text-foreground-subtle" />
              </button>
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
