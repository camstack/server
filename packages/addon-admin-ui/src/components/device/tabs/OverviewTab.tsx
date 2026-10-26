import { DeviceFeature, DeviceType } from '@camstack/types'
import {
  DiscoveryPanel,
  DoorbellRecentPanel,
  useDoorbellEvents,
  useNetworkQualityGetDeviceStats,
  WidgetSlot,
} from '@camstack/ui-library'
import { Wifi } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { DeviceNotificationMute } from '../DeviceNotificationMute'
import { HelperGroupStatus } from '../HelperGroupStatus'
import { MigrateDeviceCard } from '../MigrateDeviceCard'
import { DeviceInfoAdapter } from '../overview-adapters/DeviceInfoAdapter'
import { ResyncButton } from '../ResyncButton'

interface OverviewTabProps {
  device: Record<string, unknown>
}

function formatBitrate(kbps: number): string {
  // i18n-ignore: unit symbols
  if (kbps < 1000) return `${kbps.toFixed(0)} kbps`
  // i18n-ignore: unit symbols
  return `${(kbps / 1000).toFixed(1)} Mbps`
}

// ---------------------------------------------------------------------------
// Stream option type
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function OverviewTab({ device }: OverviewTabProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  // v2 device surface:
  //   - `id` (number): system-wide progressive id, unique across
  //     integrations. The hub's boot-time storage sanitization guarantees
  //     every persisted device has a numeric id, so by the time this
  //     component renders a fully-loaded `device` the id is always a
  //     number. Every downstream query routes by this handle.
  //   - `stableId` (string): retained only for the "Device Info" display
  //     row and for integration-layer reconciliation — never threaded
  //     through internal API calls.
  //   - `addonId` (string): owning integration, used for ProviderIcon.
  const numericId = typeof device.id === 'number' ? device.id : null
  const type = String(device.type ?? '')
  // Camera-only panels (Phase / Detection FPS / Inference / Stream
  // brokers / Stream network) are skipped on Lights / Switches / Sensors
  // / Buttons. Their underlying RPC polls are also gated on this flag —
  // a Switch device polling pipelineRunner.getCameraMetrics every 2s
  // produces noisy `PRECONDITION_FAILED` errors and burns hub cycles
  // for nothing.
  const isCamera = type === DeviceType.Camera
  const isHub = type === DeviceType.Hub
  // Capabilities surface the device class's `features` enum verbatim
  // (battery / PTZ / two-way audio / native snapshot / doorbell / …).
  // The cast documents the wire shape — `device` is loose-typed
  // (`Record<string, unknown>`) at the tab boundary, but the backend
  // schema for `Device.features` is always `DeviceFeature[]`.
  const deviceCapabilities = (device.features as readonly string[] | undefined) ?? []
  // Re-sync is generic — offered for ANY device that advertises
  // `DeviceFeature.Resyncable` (D13: resolve via capability, never branch on
  // addonId). The owning provider serves the action via `device-adoption.resync`.
  const canResync = deviceCapabilities.includes(DeviceFeature.Resyncable)

  // --- Network stats ---
  // Network quality lacks a snapshot event today; keep a slow poll so
  // the stats card still ticks. Move to event-driven once
  // `network.quality-sample` lands.
  const { data: networkStats } = useNetworkQualityGetDeviceStats(
    { deviceId: numericId ?? 0 },
    { enabled: numericId !== null && isCamera, refetchInterval: 5_000 },
  )

  // Derived network values
  const streams = networkStats?.streams ?? {}
  const streamEntries = Object.entries(streams)

  // Doorbell — only subscribe when the device advertises the feature.
  // Pass deviceId so the hook filters to this camera's presses only.
  const isDoorbell = deviceCapabilities.includes(DeviceFeature.DoorbellButton)
  const doorbell = useDoorbellEvents(
    isDoorbell ? { deviceId: numericId ?? undefined, historyLimit: 10 } : undefined,
  )
  const doorbellLatestFresh = doorbell.latest
    ? Date.now() - doorbell.latest.timestamp < 30_000
    : false

  return (
    <div className="space-y-5">
      {device.addonId === 'composer' &&
        numericId !== null &&
        typeof device.stableId === 'string' && (
          <HelperGroupStatus deviceId={numericId} stableId={device.stableId} />
        )}
      {/* The live stream is now the page-level Hero (left column on
          desktop / first row on mobile) — surfacing it again here
          would render the same WebRTC session twice on every load. */}

      {/* ── Hub: discovered children panel ── */}
      {/* Per the device-discovery cap surface — promotes/releases child
          devices behind the hub. Lives in Overview (instead of a
          dedicated "Devices" structural tab) so the operator lands
          directly on the actionable affordance for hubs. */}
      {isHub && numericId !== null && (
        <DiscoveryPanel
          deviceId={numericId}
          onOpenChild={(childId) => navigate(`/devices/${childId}`)}
        />
      )}

      {/* ── On-demand re-sync — generic, gated on DeviceFeature.Resyncable. ── */}
      {canResync && numericId !== null && <ResyncButton deviceId={numericId} />}

      {/* ── Replace this camera with different hardware. Camera-only: the cap
          switches the eight CAMERA functions off on both sides, and there is no
          equivalent for a light or a sensor. Sits with the other general
          per-device actions rather than in Config — it is a one-shot operation
          on the device's identity, not a setting. ── */}
      {isCamera && numericId !== null && (
        <MigrateDeviceCard deviceId={numericId} deviceName={String(device.name ?? '')} />
      )}

      {/* ── Notifications — the notification centre's own per-device setting
          (D113 phase 3). NOT camera-only: the mute is keyed by deviceId and
          the alarm reports a muted sensor or button the same way it reports a
          muted camera. Reads and writes `notificationRules` directly; the
          deprecated switch group is never involved. ── */}
      {numericId !== null && <DeviceNotificationMute deviceId={numericId} isCamera={isCamera} />}

      {/* ── Quick Stats — camera-only (Phase / Detection FPS / Inference
          / Tracks all read from pipeline-runner state, which doesn't
          exist for Lights / Switches / Sensors / Buttons). Sourced from
          addon-pipeline-orchestrator's widget bundle via the
          WidgetRegistry — see Phase C of the addon-widgets system. */}
      {isCamera && numericId !== null && (
        <WidgetSlot
          widgetId="pipeline-orchestrator/pipeline-quick-stats"
          host="device-tab"
          deviceId={numericId}
        />
      )}

      {/* ── Doorbell — recent press history when the device is a doorbell. ── */}
      {isDoorbell && (
        <DoorbellRecentPanel history={doorbell.history} latestIsFresh={doorbellLatestFresh} />
      )}

      {/* ── Stream Brokers — camera-only. Sourced from
          addon-stream-broker's widget bundle via the WidgetRegistry —
          see Phase A of the addon-widgets system. */}
      {isCamera && numericId !== null && (
        <WidgetSlot
          widgetId="stream-broker/stream-broker-panel"
          host="device-tab"
          deviceId={numericId}
        />
      )}

      {/* ── Network / Stream Stats ── */}
      {isCamera && streamEntries.length > 0 && (
        <div
          className="@container rounded-lg border border-border bg-surface overflow-hidden"
          style={{ containerType: 'inline-size' }}
        >
          <div className="border-b border-border px-4 py-2">
            <h2 className="text-xs font-semibold text-foreground uppercase tracking-wider">
              {t('device.overviewTab.streamNetwork', 'Stream Network')}
            </h2>
          </div>
          <div className="divide-y divide-border">
            {streamEntries.map(([streamId, stats]) => (
              <div key={streamId} className="px-4 py-2.5">
                <div className="flex items-center gap-2 mb-2">
                  <Wifi className="h-3 w-3 text-foreground-subtle" />
                  <span className="text-[11px] font-medium text-foreground">{streamId}</span>
                </div>
                <div className="grid grid-cols-2 @[640px]:grid-cols-4 gap-2">
                  <MiniStat
                    label={t('device.overviewTab.nominal', 'Nominal')}
                    value={formatBitrate(stats.nominalBitrateKbps ?? 0)}
                  />
                  <MiniStat
                    label={t('device.overviewTab.observed', 'Observed')}
                    value={formatBitrate(stats.observedBitrateKbps ?? 0)}
                  />
                  <MiniStat
                    label={t('device.overviewTab.peak', 'Peak')}
                    value={formatBitrate(stats.peakBitrateKbps ?? 0)}
                  />
                  <MiniStat
                    label={t('device.overviewTab.packetLoss', 'Packet Loss')}
                    value={`${(stats.packetLossPercent ?? 0).toFixed(2)}%`}
                    warning={(stats.packetLossPercent ?? 0) > 1}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Device Info — read-only facts. Name, room, type and display
          are edited on Customize and saved with that tab's one Save. ── */}
      <DeviceInfoAdapter />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MiniStat({ label, value, warning }: { label: string; value: string; warning?: boolean }) {
  return (
    <div>
      <p className="text-[10px] text-foreground-subtle">{label}</p>
      <p className={`text-xs font-medium ${warning ? 'text-warning' : 'text-foreground'}`}>
        {value}
      </p>
    </div>
  )
}
