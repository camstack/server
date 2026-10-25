/**
 * <WidgetSlot> — single host-side mount point for any addon-contributed
 * widget. Consumers reference a widget by its public id
 * (`<addonId>/<stableId>`), the slot looks the widget's metadata up in
 * the shared `WidgetRegistry`, resolves the component through the
 * unified `useRemoteComponent` Module-Federation loader (the SAME path
 * `ContributionRenderer`'s `kind:'remote'` branch uses), validates host
 * context against the widget's `requires` metadata, and renders one of:
 *   - skeleton placeholder while the bundle is still loading,
 *   - inline error fallback when the widget id is unknown OR the host
 *     didn't supply a required context (`deviceContext` /
 *     `integrationContext`),
 *   - the resolved component otherwise.
 *
 * The slot is intentionally STUPID — no styling beyond the skeleton/
 * error fallback. Layout (card vs inline, sizing) is the host's
 * responsibility.
 */
import { Suspense, type ReactNode, useMemo } from 'react'
import {
  useRemoteComponent,
  useWidgetMetadata,
  type WidgetProps,
} from '../contexts/widget-registry.js'
import { HOST_WIDGETS } from '../widgets/host-widgets.js'

export interface WidgetSlotProps {
  /** `<addonId>/<stableId>` — the public widget identifier. */
  readonly widgetId: string
  /** Host context — picked up by metadata `requires` validation. Defaults to `'device-tab'`. */
  readonly host?: WidgetProps['host']
  /** Forwarded to widget. */
  readonly config?: Readonly<Record<string, unknown>>
  /** Forwarded to widget. */
  readonly deviceId?: number
  readonly integrationId?: string
  /** Stable instance id — defaults to `widgetId` for non-dashboard hosts (single mount per page). */
  readonly instanceId?: string
  /** Dashboard sizing — placeholder for v1. */
  readonly size?: WidgetProps['size']
  readonly columns?: number
  readonly rows?: number
}

export function WidgetSlot(props: WidgetSlotProps): ReactNode {
  const { widgetId, deviceId } = props

  // Host-widget path — ui-library components resolved BEFORE the MF
  // registry.  Konva-using widgets (motion-zones, privacy-mask) are
  // React.lazy — wrap in <Suspense> with the same WidgetSkeleton used
  // for remote widgets so callers get a consistent loading experience.
  const HostComponent = HOST_WIDGETS[widgetId]
  if (HostComponent !== undefined) {
    if (deviceId === undefined) {
      return <WidgetMissingError widgetId={widgetId} reason="missing-device-context" />
    }
    return (
      <Suspense fallback={<WidgetSkeleton />}>
        <HostComponent deviceId={deviceId} />
      </Suspense>
    )
  }

  return <RemoteWidgetSlot {...props} />
}

/**
 * Module-Federation remote-widget path — looks the widget's metadata up
 * in the shared `WidgetRegistry` and resolves it through `useRemoteComponent`.
 */
function RemoteWidgetSlot(props: WidgetSlotProps): ReactNode {
  const { widgetId } = props
  const metadata = useWidgetMetadata(widgetId)

  // Unknown widget id — the registry has no descriptor, so there's no
  // `remote` to feed the MF loader. Render the error before mounting
  // the inner host (which calls `useRemoteComponent` unconditionally).
  if (metadata === undefined) {
    return <WidgetMissingError widgetId={widgetId} reason="unknown" />
  }
  return <ResolvedWidgetSlot {...props} metadata={metadata} />
}

interface ResolvedWidgetSlotProps extends WidgetSlotProps {
  readonly metadata: NonNullable<ReturnType<typeof useWidgetMetadata>>
}

/**
 * Inner host — resolves the widget component through the unified
 * `useRemoteComponent` MF loader (shared with `ContributionRenderer`'s
 * `kind:'remote'` branch). Mounted only once a `metadata` descriptor is
 * known, so the hook always receives a valid `remote` descriptor.
 */
function ResolvedWidgetSlot(props: ResolvedWidgetSlotProps): ReactNode {
  const {
    widgetId,
    host = 'device-tab',
    config,
    deviceId,
    integrationId,
    instanceId,
    size,
    columns,
    rows,
    metadata,
  } = props
  const Component = useRemoteComponent(metadata.remote, metadata.bundleUrl)

  const resolvedInstanceId = useMemo(() => instanceId ?? widgetId, [instanceId, widgetId])

  if (Component === null) {
    return <WidgetSkeleton />
  }
  if (Component === undefined) {
    // Bundle resolved but the requested componentKey isn't exported.
    return <WidgetMissingError widgetId={widgetId} reason="missing-export" />
  }

  // Host-context validation — gate AFTER load so a required-but-missing
  // context renders a clear message instead of a blank slot.
  if (metadata.requires.deviceContext && deviceId === undefined) {
    return <WidgetMissingError widgetId={widgetId} reason="missing-device-context" />
  }
  if (metadata.requires.integrationContext && integrationId === undefined) {
    return <WidgetMissingError widgetId={widgetId} reason="missing-integration-context" />
  }

  return (
    <Component
      instanceId={resolvedInstanceId}
      host={host}
      config={config}
      deviceId={deviceId}
      integrationId={integrationId}
      size={size}
      columns={columns}
      rows={rows}
    />
  )
}

function WidgetSkeleton(): ReactNode {
  return (
    <div className="rounded-lg border border-border bg-surface/40 p-4 animate-pulse">
      <div className="h-3 w-24 bg-foreground-subtle/20 rounded mb-2" />
      <div className="h-2 w-full bg-foreground-subtle/10 rounded mb-1" />
      <div className="h-2 w-3/4 bg-foreground-subtle/10 rounded" />
    </div>
  )
}

interface WidgetMissingErrorProps {
  readonly widgetId: string
  readonly reason:
    | 'unknown'
    | 'missing-export'
    | 'missing-device-context'
    | 'missing-integration-context'
}

function WidgetMissingError({ widgetId, reason }: WidgetMissingErrorProps): ReactNode {
  const message =
    reason === 'unknown'
      ? `Widget "${widgetId}" not registered`
      : reason === 'missing-export'
        ? `Widget "${widgetId}" bundle does not export this stableId`
        : reason === 'missing-device-context'
          ? `Widget "${widgetId}" requires a deviceId`
          : `Widget "${widgetId}" requires an integrationId`
  return (
    <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
      {message}
    </div>
  )
}
