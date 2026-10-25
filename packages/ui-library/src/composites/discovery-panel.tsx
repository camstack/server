import { useUiText, UiTrans } from '../contexts/ui-text'
import { useState, useMemo } from 'react'
import {
  RefreshCw,
  Plus,
  Trash2,
  AlertTriangle,
  Loader2,
  Wifi,
  Moon,
  WifiOff,
  HelpCircle,
  ExternalLink,
} from 'lucide-react'
import { trpc } from '../trpc-react'
import type {
  DiscoveredChildDevice,
  DiscoveredChildStatus,
  DeviceDiscoveryStatus,
} from '@camstack/types'

/**
 * Shared discovery panel — renders the `device-discovery` cap surface
 * for any parent device that registers it (Reolink Hub, future ONVIF
 * gateway, NVR-style integrations). Keeps the integration's UI
 * surface zero-effort: as long as the cap is mounted, the panel
 * renders the channel list with status badges, refresh, adopt, and
 * release controls.
 *
 * A single generic UI used by every provider that exposes children
 * behind a gateway. Keeps the operator UX consistent across
 * integrations.
 */

interface DiscoveryPanelProps {
  readonly deviceId: number
  readonly className?: string
  /**
   * Optional navigation callback fired when the operator clicks the
   * "Open" link on an adopted child row. ui-library deliberately
   * stays free of `react-router-dom` so it works in agent UIs +
   * embedded admin shells alike — host wires the actual navigation.
   * When omitted, the link is hidden.
   */
  readonly onOpenChild?: (childDeviceId: number) => void
}

export function DiscoveryPanel({
  deviceId,
  className = '',
  onOpenChild,
}: DiscoveryPanelProps): React.ReactElement {
  const t = useUiText()
  // tRPC handle for the device-discovery cap. Typed via the shared
  // proxy — every method gets a deviceId-aware input shape.
  const utils = trpc.useUtils()
  const listQuery = trpc.deviceDiscovery.listDiscovered.useQuery(
    { deviceId },
    { refetchInterval: 10_000, retry: false },
  )
  const statusQuery = trpc.deviceDiscovery.getStatus.useQuery(
    { deviceId },
    { refetchInterval: 10_000, retry: false },
  )
  const refreshMutation = trpc.deviceDiscovery.refreshDiscovery.useMutation({
    onSuccess: () => {
      void utils.deviceDiscovery.listDiscovered.invalidate({ deviceId })
      void utils.deviceDiscovery.getStatus.invalidate({ deviceId })
    },
  })
  const adoptMutation = trpc.deviceDiscovery.adoptDevice.useMutation({
    onSuccess: () => {
      void utils.deviceDiscovery.listDiscovered.invalidate({ deviceId })
    },
  })
  const releaseMutation = trpc.deviceDiscovery.releaseDevice.useMutation({
    onSuccess: () => {
      void utils.deviceDiscovery.listDiscovered.invalidate({ deviceId })
    },
  })

  const [busyChildId, setBusyChildId] = useState<string | null>(null)

  // Split the discovered list into two groups so the panel can render
  // them as separate sections — operators almost always care about
  // "what's available to adopt" first, "what's already managed" second.
  // Two-section split: candidates highlighted at the top, already-
  // adopted devices grey-listed at the bottom.
  const { available, adopted } = useMemo(() => {
    const list = listQuery.data ?? []
    // Sort: ascending by `rtspChannel` when both have one; entries
    // without a channel index (non-Reolink integrations that may
    // discover via UID-only) sort last by name. Avoids the magic
    // `?? 999` sentinel — the previous fallback would have ordered
    // a 1000-channel hub incorrectly. `Number.POSITIVE_INFINITY`
    // is semantically what "no channel — push to end" means.
    const sortKey = (c: DiscoveredChildDevice): number =>
      typeof c.metadata.rtspChannel === 'number' ? c.metadata.rtspChannel : Number.POSITIVE_INFINITY
    const byChannel = (a: DiscoveredChildDevice, b: DiscoveredChildDevice): number => {
      const ac = sortKey(a)
      const bc = sortKey(b)
      if (ac !== bc) return ac - bc
      return a.name.localeCompare(b.name)
    }
    return {
      available: list.filter((c) => !c.alreadyAdopted).toSorted(byChannel),
      adopted: list.filter((c) => c.alreadyAdopted).toSorted(byChannel),
    }
  }, [listQuery.data])

  // The auto-injected `getStatus` cap method returns a generic
  // `unknown`-typed payload through the codegen'd cap router (the
  // tightening per-cap status-shape is followup work — punch-list
  // #13). Cast to the cap's declared status schema here so the panel
  // can read the lastError / lastDiscoveryAt fields ergonomically.
  const status = statusQuery.data as DeviceDiscoveryStatus | null | undefined
  const lastErr = status?.lastError ?? null
  const lastDiscoveryAt = status?.lastDiscoveryAt ?? null

  async function handleRefresh(): Promise<void> {
    await refreshMutation.mutateAsync({ deviceId }).catch(() => {
      /* surfaced via mutation state */
    })
  }

  async function handleAdopt(child: DiscoveredChildDevice): Promise<void> {
    setBusyChildId(child.childNativeId)
    try {
      await adoptMutation.mutateAsync({ deviceId, childNativeId: child.childNativeId })
    } finally {
      setBusyChildId(null)
    }
  }

  async function handleRelease(child: DiscoveredChildDevice): Promise<void> {
    if (child.adoptedDeviceId == null) return
    setBusyChildId(child.childNativeId)
    try {
      await releaseMutation.mutateAsync({ deviceId, childDeviceId: child.adoptedDeviceId })
    } finally {
      setBusyChildId(null)
    }
  }

  return (
    <div className={`rounded-xl border border-border bg-surface ${className}`}>
      <div className="flex items-start justify-between gap-2 border-b border-border px-3 py-2 sm:px-5 sm:py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">
            {t('uiLibrary.discoveryPanel.title', 'Discovered devices')}
          </h3>
          <p className="text-[11px] text-foreground-subtle">
            <UiTrans
              uiKey="uiLibrary.discoveryPanel.intro"
              fallback="Channels behind this hub. Click <0>Add</0> to promote a channel to a managed device, or <1>Remove</1> to detach."
              components={[
                <span key="a" className="font-medium" />,
                <span key="r" className="font-medium" />,
              ]}
            />
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshMutation.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2 py-1.5 sm:px-3 text-xs font-medium text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50 shrink-0"
        >
          {refreshMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          <span className="hidden sm:inline">
            {t('uiLibrary.discoveryPanel.refresh', 'Refresh')}
          </span>
        </button>
      </div>

      {lastErr ? (
        <div className="flex items-start gap-2 border-b border-border bg-destructive/10 px-5 py-2 text-[11px] text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            {t('uiLibrary.discoveryPanel.refreshFailed', 'Last refresh failed: {{error}}', {
              error: lastErr,
            })}
          </span>
        </div>
      ) : null}

      {listQuery.isLoading ? (
        <div className="flex items-center justify-center py-8 text-foreground-subtle">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : available.length === 0 && adopted.length === 0 ? (
        <div className="px-5 py-8 text-center text-xs text-foreground-subtle">
          {t(
            'uiLibrary.discoveryPanel.empty',
            'No channels reported by the hub yet. Click Refresh to enumerate.',
          )}
        </div>
      ) : (
        <>
          {/* Available section: candidates the operator can promote
              into managed devices. Highlighted because this is the
              primary affordance of the discovery panel. */}
          {available.length > 0 ? (
            <Section
              title={t('uiLibrary.discoveryPanel.available', 'Available to add')}
              count={available.length}
              tone="primary"
            >
              {available.map((child) => (
                <ChildRow
                  key={child.childNativeId}
                  child={child}
                  busy={busyChildId === child.childNativeId}
                  onAdopt={handleAdopt}
                  onRelease={handleRelease}
                  onOpenChild={onOpenChild}
                />
              ))}
            </Section>
          ) : null}

          {/* Adopted section: already-managed children, kept here so
              the operator can release them without leaving the panel.
              De-emphasised vs Available so it doesn't compete for
              attention when the operator is mid-onboarding. */}
          {adopted.length > 0 ? (
            <Section
              title={t('uiLibrary.discoveryPanel.adopted', 'Already adopted')}
              count={adopted.length}
              tone="muted"
            >
              {adopted.map((child) => (
                <ChildRow
                  key={child.childNativeId}
                  child={child}
                  busy={busyChildId === child.childNativeId}
                  onAdopt={handleAdopt}
                  onRelease={handleRelease}
                  onOpenChild={onOpenChild}
                />
              ))}
            </Section>
          ) : null}
        </>
      )}

      {lastDiscoveryAt != null ? (
        <div className="border-t border-border px-5 py-2 text-[10px] text-foreground-subtle">
          {t('uiLibrary.discoveryPanel.lastRefreshed', 'Last refreshed {{when}}', {
            when: new Date(lastDiscoveryAt).toLocaleString(),
          })}
        </div>
      ) : null}
    </div>
  )
}

interface SectionProps {
  readonly title: string
  readonly count: number
  readonly tone: 'primary' | 'muted'
  readonly children: React.ReactNode
}

function Section({ title, count, tone, children }: SectionProps): React.ReactElement {
  const headerClass =
    tone === 'primary'
      ? 'bg-primary/5 text-primary border-primary/30'
      : 'bg-surface text-foreground-subtle border-border'
  return (
    <div className="border-t border-border">
      <div
        className={`flex items-center justify-between border-b px-3 sm:px-5 py-1.5 text-[10px] uppercase tracking-wider ${headerClass}`}
      >
        <span className="font-semibold">{title}</span>
        <span className="font-mono">{count}</span>
      </div>
      <div className="divide-y divide-border">{children}</div>
    </div>
  )
}

interface ChildRowProps {
  readonly child: DiscoveredChildDevice
  readonly busy: boolean
  readonly onAdopt: (child: DiscoveredChildDevice) => Promise<void>
  readonly onRelease: (child: DiscoveredChildDevice) => Promise<void>
  readonly onOpenChild?: (childDeviceId: number) => void
}

function ChildRow({
  child,
  busy,
  onAdopt,
  onRelease,
  onOpenChild,
}: ChildRowProps): React.ReactElement {
  const t = useUiText()
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 sm:px-5 sm:py-3 sm:flex-nowrap sm:gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusBadge status={child.status} />
          <span className="truncate text-sm font-medium text-foreground">{child.name}</span>
          {child.metadata.isDoorbell ? (
            <span className="rounded bg-surface-hover px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-foreground-subtle">
              {t('uiLibrary.discoveryPanel.doorbell', 'Doorbell')}
            </span>
          ) : null}
          {child.metadata.isBattery ? (
            <span className="rounded bg-surface-hover px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-foreground-subtle">
              {t('uiLibrary.discoveryPanel.battery', 'Battery')}
            </span>
          ) : null}
          {child.metadata.isMultifocal ? (
            <span className="rounded bg-surface-hover px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-foreground-subtle">
              {t('uiLibrary.discoveryPanel.multifocal', 'Multifocal')}
            </span>
          ) : null}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-foreground-subtle">
          {typeof child.metadata.rtspChannel === 'number' ? (
            <span>
              ch <span className="font-mono">{child.metadata.rtspChannel}</span>
            </span>
          ) : null}
          {child.metadata.model ? (
            <span className="truncate max-w-[160px]">{child.metadata.model}</span>
          ) : null}
          {child.metadata.uid ? (
            <span className="font-mono truncate max-w-[140px]">
              {child.metadata.uid.slice(0, 12)}…
            </span>
          ) : null}
        </div>
      </div>

      {child.alreadyAdopted ? (
        <div className="flex items-center gap-2">
          {/* Open link — host wires `onOpenChild` to its router; we
              gate on both the callback being supplied AND a real
              adopted device id (the panel renders adopted rows even
              before the slice catches up post-create, so id may be
              null for one render tick). */}
          {onOpenChild && child.adoptedDeviceId !== null ? (
            <button
              type="button"
              onClick={() => onOpenChild(child.adoptedDeviceId!)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
              title={t('uiLibrary.discoveryPanel.openTitle', 'Open device detail')}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t('uiLibrary.discoveryPanel.open', 'Open')}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              void onRelease(child)
            }}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/30 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            {t('uiLibrary.discoveryPanel.remove', 'Remove')}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            void onAdopt(child)
          }}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          {t('uiLibrary.discoveryPanel.add', 'Add')}
        </button>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: DiscoveredChildStatus }): React.ReactElement {
  const t = useUiText()
  switch (status) {
    case 'online':
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-500">
          <Wifi className="h-2.5 w-2.5" /> {t('uiLibrary.discoveryPanel.online', 'online')}
        </span>
      )
    case 'sleeping':
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500">
          <Moon className="h-2.5 w-2.5" /> {t('uiLibrary.discoveryPanel.sleeping', 'sleeping')}
        </span>
      )
    case 'offline':
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
          <WifiOff className="h-2.5 w-2.5" /> {t('uiLibrary.discoveryPanel.offline', 'offline')}
        </span>
      )
    case 'unknown':
    default:
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-medium text-foreground-subtle">
          <HelpCircle className="h-2.5 w-2.5" /> {t('uiLibrary.discoveryPanel.unknown', 'unknown')}
        </span>
      )
  }
}
