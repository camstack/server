import { useQueryClient } from '@tanstack/react-query'
import { Boxes, Server, Layers, Link2, Minus, RotateCcw, Check } from 'lucide-react'

import {
  DataTable,
  useDeviceManagerGetBindings,
  useDeviceManagerGetDevice,
  useDeviceManagerListBindableCapsForDeviceType,
  useDeviceManagerSetWrapperActive,
} from '@camstack/ui-library'
import type { DataColumn } from '@camstack/ui-library'
import { useEventInvalidation } from '../../../hooks/useEventInvalidation'
import { Trans, useTranslation } from 'react-i18next'

interface BindingRow {
  readonly capName: string
  readonly kind: 'native' | 'wrapped' | 'linked' | 'unbound'
  readonly providerAddonId: string
  readonly providerNodeId: string
  readonly nativeAddonId: string
  readonly wrappers: readonly string[]
}

interface BindingsTabProps {
  /** Numeric device id — used for every deviceManager query. */
  readonly deviceId: number
}

/**
 * Per-device capability bindings.
 *
 * Combines two sources:
 *   - `deviceManager.getBindings` — every cap the device already has bound
 *     (native or wrapper). For an RTSP camera without `snapshotUrl` this is
 *     just `device-ops` (auto-registered per device).
 *   - `deviceManager.listBindableCapsForDeviceType` — every cap whose
 *     `scope:'device'` + `deviceTypes` applies to this device's type plus
 *     the list of wrapper addons that can provide it.
 *
 * The union gives the user a complete picture: caps already bound show their
 * active provider; caps that COULD be bound but aren't yet show with kind
 * "unbound" and the wrapper picker lets the user activate one (useful for
 * snapshot: even when the camera has no native endpoint, activating the
 * `snapshot` wrapper routes requests through stream-broker → ffmpeg).
 */
export function BindingsTab({ deviceId }: BindingsTabProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const enabled = Number.isFinite(deviceId)

  const { data: device } = useDeviceManagerGetDevice({ deviceId }, { enabled })
  const deviceType = typeof device?.type === 'string' ? device.type : 'camera'

  // Bindings only change when an operator toggles them or the
  // capability binding is re-evaluated. The event bus emits
  // `capability.binding-changed` on every transition — subscribe and
  // drop the 5s polling.
  useEventInvalidation(['deviceManager', 'getBindings'], ['capability.binding-changed'])

  const {
    data: bindings,
    isLoading,
    isError,
    error,
  } = useDeviceManagerGetBindings({ deviceId }, { enabled })

  const { data: bindableCaps } = useDeviceManagerListBindableCapsForDeviceType(
    { deviceType },
    { enabled: !!deviceType },
  )

  const setWrapperMutation = useDeviceManagerSetWrapperActive({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [['deviceManager', 'getBindings']] })
    },
  })

  if (isLoading) {
    return (
      <div className="p-4">
        <div className="h-20 rounded-lg border border-border bg-surface animate-pulse" />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="p-4 text-xs text-red-400">
        {t('device.bindingsTab.failedToLoadBindings', 'Failed to load bindings:')}{' '}
        {error instanceof Error ? error.message : String(error)}
      </div>
    )
  }

  // Union of bound entries + bindable-but-unbound caps. Entries keyed by
  // capName — `getBindings` wins when a cap is both bound AND bindable.
  const entriesByCap = new Map<string, BindingRow>()
  const wrappersByCap: Record<string, readonly string[]> = {}
  for (const bc of bindableCaps ?? []) {
    wrappersByCap[bc.capName] = bc.wrappers
  }
  for (const entry of bindings?.entries ?? []) {
    entriesByCap.set(entry.capName, {
      ...entry,
      wrappers: wrappersByCap[entry.capName] ?? [],
    })
  }
  for (const bc of bindableCaps ?? []) {
    if (entriesByCap.has(bc.capName)) continue
    entriesByCap.set(bc.capName, {
      capName: bc.capName,
      kind: 'unbound',
      providerAddonId: '',
      providerNodeId: '',
      nativeAddonId: '',
      wrappers: bc.wrappers,
    })
  }
  const rows = [...entriesByCap.values()].toSorted((a, b) => a.capName.localeCompare(b.capName))

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-8 text-foreground-subtle">
        <Boxes className="h-8 w-8 opacity-40" />
        <p className="text-xs">
          {t(
            'device.bindingsTab.noCapabilityProvidersApplicableTo',
            'No capability providers applicable to this device yet.',
          )}
        </p>
        <p className="text-[10px] opacity-60">
          {t(
            'device.bindingsTab.nativeProvidersShowUpHere',
            'Native providers show up here as soon as the owning addon registers them.',
          )}
        </p>
      </div>
    )
  }

  const boundCount = rows.filter((r) => r.kind !== 'unbound').length

  const columns: readonly DataColumn<BindingRow>[] = [
    {
      key: 'capability',
      header: t('device.bindingsTab.capability', 'Capability'),
      render: (row) => <span className="font-mono text-foreground">{row.capName}</span>,
    },
    {
      key: 'kind',
      header: t('device.bindingsTab.kind', 'Kind'),
      render: (row) => <KindBadge kind={row.kind} />,
    },
    {
      key: 'provider',
      header: t('device.bindingsTab.activeProvider', 'Active Provider'),
      render: (row) => (
        <span className="font-mono text-foreground-subtle">
          {row.providerAddonId || <span className="opacity-40">—</span>}
        </span>
      ),
    },
    {
      key: 'node',
      header: t('device.bindingsTab.node', 'Node'),
      render: (row) =>
        row.providerNodeId ? (
          <NodeChip nodeId={row.providerNodeId} />
        ) : (
          <span className="text-[10px] opacity-40">—</span>
        ),
    },
    {
      key: 'native',
      header: t('device.bindingsTab.kindNative', 'Native'),
      render: (row) => (
        <span className="font-mono text-foreground-subtle">
          {row.nativeAddonId || <span className="opacity-40">—</span>}
        </span>
      ),
    },
    {
      key: 'wrapper',
      header: t('device.bindingsTab.wrapper', 'Wrapper'),
      render: (row) => {
        const activeWrapperId = row.kind === 'wrapped' ? row.providerAddonId : null
        return (
          <WrapperPicker
            wrappers={row.wrappers}
            activeWrapperId={activeWrapperId}
            disabled={setWrapperMutation.isPending}
            onPick={(wrapperAddonId) => {
              const isCurrentlyActive = activeWrapperId === wrapperAddonId
              setWrapperMutation.mutate({
                deviceId,
                capName: row.capName,
                wrapperAddonId,
                active: !isCurrentlyActive,
              })
            }}
          />
        )
      },
    },
  ]

  return (
    <div className="flex flex-col gap-3 p-1">
      <div className="text-[11px] text-foreground-subtle">
        <Trans
          i18nKey="device.bindingsTab.boundSummary"
          count={rows.length}
          values={{ bound: boundCount }}
          components={{ b: <span className="font-medium text-foreground" />, em: <em /> }}
        />
      </div>
      <DataTable columns={columns} rows={rows} rowKey={(row) => row.capName} minWidthPx={720} />
    </div>
  )
}

function KindBadge({ kind }: { readonly kind: 'native' | 'wrapped' | 'linked' | 'unbound' }) {
  const { t } = useTranslation()
  if (kind === 'native') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-success/30 text-success bg-success/5 px-1.5 py-0.5 text-[10px] font-medium">
        <Server className="h-3 w-3" />
        {t('device.bindingsTab.kindNative')}
      </span>
    )
  }
  if (kind === 'wrapped') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-primary/30 text-primary bg-primary/5 px-1.5 py-0.5 text-[10px] font-medium">
        <Layers className="h-3 w-3" />
        {t('device.bindingsTab.wrapped')}
      </span>
    )
  }
  if (kind === 'linked') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-warning/30 text-warning bg-warning/5 px-1.5 py-0.5 text-[10px] font-medium">
        <Link2 className="h-3 w-3" />
        {t('device.bindingsTab.linked')}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border text-foreground-subtle/70 px-1.5 py-0.5 text-[10px] font-medium">
      <Minus className="h-3 w-3" />
      {t('common.unbound')}
    </span>
  )
}

function NodeChip({ nodeId }: { readonly nodeId: string }) {
  const isHub = nodeId === 'hub'
  return (
    <span
      className={`inline-flex items-center rounded-md border border-border px-1.5 py-0.5 font-mono text-[10px] ${
        isHub ? 'text-foreground-subtle' : 'text-foreground'
      }`}
    >
      {nodeId}
    </span>
  )
}

interface WrapperPickerProps {
  readonly wrappers: readonly string[]
  readonly activeWrapperId: string | null
  readonly disabled: boolean
  readonly onPick: (wrapperAddonId: string) => void
}

function WrapperPicker({ wrappers, activeWrapperId, disabled, onPick }: WrapperPickerProps) {
  const { t } = useTranslation()
  if (wrappers.length === 0) {
    return (
      <span className="text-[10px] opacity-40">
        {t('device.bindingsTab.noneAvailable', 'none available')}
      </span>
    )
  }
  return (
    <div className="flex flex-wrap gap-1">
      {wrappers.map((wrapperId) => {
        const isActive = wrapperId === activeWrapperId
        return (
          <button
            key={wrapperId}
            disabled={disabled}
            onClick={() => onPick(wrapperId)}
            title={
              isActive
                ? t(
                    'device.bindingsTab.clickToDeactivateRevertTo',
                    'Click to deactivate (revert to native)',
                  )
                : t('device.bindingsTab.activateWrapper', 'Activate wrapper {{wrapperId}}', {
                    wrapperId,
                  })
            }
            className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] transition-colors disabled:opacity-50 ${
              isActive
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-border text-foreground-subtle hover:text-foreground hover:bg-surface-hover'
            }`}
          >
            {isActive ? <Check className="h-3 w-3" /> : <RotateCcw className="h-3 w-3" />}
            {wrapperId}
          </button>
        )
      })}
    </div>
  )
}
