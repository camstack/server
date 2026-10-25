import { useMemo } from 'react'
import { RotateCw, RefreshCw, Server } from 'lucide-react'
import {
  EventStream,
  LogStream,
  PtzPanel,
  StateValuesStream,
  StreamPanel,
  useAddonsRestartAddon,
  useConfirm,
  useDeviceSnapshotImage,
  useDeviceWebrtc,
  usePlayerOverlayLayers,
  useRebootReboot,
  useSystem,
  toStationaryOverlayBox,
  useVodPlayback,
} from '@camstack/ui-library'

import type { StationaryOverlayBox } from '@camstack/types'
import { useDeviceDetections } from '../../hooks/useDeviceDetections'
import { useStationaryObjects } from '../detection-intelligence/use-stationary-objects'
import { useDevice } from '../../hooks/useDevice'
import { useDeviceIntercom } from '../../hooks/useDeviceIntercom'
import { ReplTerminal } from '../shared/ReplTerminal'
import { IntercomPanel } from './IntercomPanel'
import { vodPanelProps } from './vod-panel-props'
import { hubOrigin } from '../../lib/mount'
import { Trans, useTranslation } from 'react-i18next'

// All panels take the numeric device id — the canonical handle
// propagated from the DeviceDetail URL. Every downstream panel (stream,
// logs, REPL, events) routes by the numeric id end-to-end; there is no
// stableId translation inside this module.

// ---- Stream Panel (with detection overlay + intercom toggle) ----
interface StreamPanelContentProps {
  deviceId: number
  /** Whether the device supports two-way audio. When true the
   *  in-stream toolbar surfaces a one-click Intercom button that
   *  starts/stops the PTT session DIRECTLY — no extra tab to open.
   *  Sourced from `DeviceFeature.TwoWayAudio`. */
  intercomAvailable?: boolean
}

export function StreamPanelContent({
  deviceId,
  intercomAvailable = false,
}: StreamPanelContentProps) {
  const system = useSystem()
  const serverUrl = typeof window !== 'undefined' ? hubOrigin() : ''
  const deviceIdReady = Number.isFinite(deviceId)
  const detections = useDeviceDetections(deviceIdReady ? deviceId : null)
  // The census. It is NOT in the detection stream — a promoted parked object is
  // dropped from the tracker on purpose — so the stationary layer is fed from
  // the occupancy snapshot, the only place it exists.
  const census = useStationaryObjects(deviceIdReady ? [deviceId] : [])
  const stationaryObjects = useMemo(() => {
    if (!deviceIdReady) return undefined
    const out: StationaryOverlayBox[] = []
    for (const row of census.rows) {
      const box = toStationaryOverlayBox(row)
      if (box !== null) out.push(box)
    }
    return out
  }, [deviceIdReady, census.rows])

  const {
    streams,
    pipelineMetrics,
    createSession,
    sendAnswer,
    handleOffer,
    getIceServers,
    addIceCandidate,
    getIceCandidates,
    closeSession,
    getSessionState,
    applyDownlinkProbe,
  } = useDeviceWebrtc(system.trpcClient, deviceIdReady ? deviceId : null)

  // Snapshot — a plain data-plane image URL (browser HTTP cache + ETag), not a
  // base64 blob over the WebSocket. This is the hero player poster, so it takes
  // the ladder's top rung: still ~5% of the 4 K capture it used to receive.
  const snapshot = useDeviceSnapshotImage(deviceIdReady ? deviceId : null, {
    width: PANEL_SNAPSHOT_WIDTH,
  })

  // Intercom session lives RIGHT HERE — clicking the in-stream
  // intercom button starts/stops the PTT session directly. No
  // separate tab/panel hosts the mic any more; the player toolbar
  // is the only surface that needs to know whether we're talking,
  // and the highlighted state of the button is the entire UI.
  //
  // Click semantics (mirror IntercomPanel but more permissive on stop):
  //   idle / error                   → start()
  //   requesting-mic / starting /
  //     connecting / talking         → stop()  (button always responds)
  //   stopping                       → no-op  (already tearing down)
  // The "stop while still starting" path lets the operator abort a
  // hung connect without waiting for it to time out.
  const intercom = useDeviceIntercom(deviceIdReady && intercomAvailable ? deviceId : null)
  const intercomBusy =
    intercom.state === 'requesting-mic' ||
    intercom.state === 'starting' ||
    intercom.state === 'connecting' ||
    intercom.state === 'stopping'
  const intercomActive = intercom.isTalking || intercomBusy
  const onIntercomToggle = () => {
    if (intercom.state === 'idle' || intercom.state === 'error') {
      void intercom.start()
    } else if (intercom.state !== 'stopping') {
      void intercom.stop()
    }
  }

  // Player overlay layers — pluggable. Sibling components register
  // overlay layers (and toolbar buttons, see `usePlayerToolbarButtons`
  // inside `StreamPanel`) via the `usePlayerOverlayLayer` /
  // `usePlayerToolbarButton` hooks. The host doesn't know about
  // zones / detection bbox / audio waveform; whatever is registered
  // gets composed into `extraOverlay` here. Reordered by `order`
  // (lower = bottom). Detection tab registers `'zones'` at order
  // 100; future addon-page extensions plug in similarly.
  const layers = usePlayerOverlayLayers()

  // VOD playback request driven by the Recording tab. When set, the hero
  // swaps the live stream for HLS playback of the recorded window/clip; the
  // panel header shows the clip label and re-purposes the play/stop button
  // to return to live (so nothing overlaps the video).
  const vod = useVodPlayback()
  const playbackToken =
    typeof window !== 'undefined' ? window.localStorage.getItem('camstack_admin_token') : null
  // One mapping, unit-pinned — `format` reaches the player or a native clip's
  // MP4 is handed to hls.js and parsed as a manifest (D549 decision 22).
  const vodProps = vodPanelProps(vod.request, playbackToken)

  const extraOverlay =
    layers.length > 0 ? (
      <>
        {layers.map((layer) => (
          <div key={layer.id} className="absolute inset-0">
            {layer.node}
          </div>
        ))}
      </>
    ) : null
  return (
    <StreamPanel
      serverUrl={serverUrl}
      createSession={createSession}
      sendAnswer={sendAnswer}
      handleOffer={handleOffer}
      getIceServers={getIceServers}
      addIceCandidate={addIceCandidate}
      getIceCandidates={getIceCandidates}
      closeSession={closeSession}
      getSessionState={getSessionState}
      applyDownlinkProbe={applyDownlinkProbe}
      {...(vodProps === null ? {} : { ...vodProps, onExitPlayback: () => vod.clear() })}
      streams={streams}
      pipelineMetrics={pipelineMetrics}
      phase={detections.phase}
      detections={detections}
      {...(stationaryObjects !== undefined ? { stationaryObjects } : {})}
      defaultShowDetections
      defaultShowMotion
      showPlayStop
      snapshotSrc={snapshot.src}
      {...(snapshot.src ? { posterUrl: snapshot.src } : {})}
      snapshotLoading={snapshot.loading}
      onRefreshSnapshot={snapshot.refresh}
      intercomAvailable={intercomAvailable}
      intercomShown={intercomActive}
      onIntercomToggle={onIntercomToggle}
      extraOverlay={extraOverlay}
      chromeless
      className="h-full"
    />
  )
}

// ---- Logs Panel ----
interface LogsPanelContentProps {
  deviceId: number
  /** Set when the device is a Container — the Logs tab then shows the whole
   *  subtree (container + all children) via the `containerDeviceId` filter. */
  containerDeviceId?: number
}

export function LogsPanelContent({ deviceId, containerDeviceId }: LogsPanelContentProps) {
  const { t } = useTranslation()
  if (!Number.isFinite(deviceId)) {
    return (
      <div className="flex items-center justify-center h-full text-[11px] text-foreground-subtle italic">
        {t('device.panelContent.notLoaded', { id: deviceId })}
      </div>
    )
  }
  return (
    <div className="flex flex-col h-full">
      <LogStream
        {...(containerDeviceId !== undefined ? { containerDeviceId } : { deviceId })}
        limit={50}
        maxHeight="max-h-full"
        showScope={false}
        showFilters={false}
      />
    </div>
  )
}

// ---- REPL Panel ----
interface ReplPanelContentProps {
  deviceId: number
}

export function ReplPanelContent({ deviceId }: ReplPanelContentProps) {
  const { t } = useTranslation()
  if (!Number.isFinite(deviceId)) {
    return (
      <div className="flex items-center justify-center h-full text-[11px] text-foreground-subtle italic">
        {t('device.panelContent.notLoaded', { id: deviceId })}
      </div>
    )
  }
  // The greeting plays double-duty as the first usage hint: scoped to
  // this device, it reminds the user that `device` is already bound and
  // points at `examples` / `context` for the full surface.
  const greeting = [
    `CamStack REPL — device #${deviceId}`,
    '',
    '  device.state.battery.value           sync state read',
    '  await device.snapshot.getSnapshot({})  cap action',
    '',
    "  type 'examples' for more, 'context' for the full API",
  ].join('\n')
  return (
    <ReplTerminal
      scope={{ type: 'device', deviceId }}
      greeting={greeting}
      className="h-full border-0 rounded-none"
    />
  )
}

// ---- PTZ Panel (live pan/tilt/zoom controls) ----
//
// Thin re-export of the ui-library `PtzPanel` cap-settings composite.
// The PTZ surface (controls + autotrack) now lives in ui-library so it
// can be mounted by the cap-UI contribution mechanism; this wrapper
// keeps the `FloatingPanelManager` shortcut working with no API change.
interface PTZPanelContentProps {
  deviceId: number
}

export function PTZPanelContent({ deviceId }: PTZPanelContentProps) {
  const { t } = useTranslation()
  return <PtzPanel deviceId={deviceId} />
}

// ---- Events Panel — full event stream scoped to the device ----
//
// Replaces the camera-only `CameraEventsTab`: uses the generic
// `EventStream` from ui-library so non-camera devices see their
// own events (state changes, switch toggles, sensor trips). The
// CameraEventsTab path was a thin wrapper around the same stream
// with camera-only chrome — generic is fine for the floating panel.
interface EventsPanelContentProps {
  deviceId: number
}

export function EventsPanelContent({ deviceId }: EventsPanelContentProps) {
  const { t } = useTranslation()
  if (!Number.isFinite(deviceId)) {
    return (
      <div className="flex items-center justify-center h-full text-[11px] text-foreground-subtle italic">
        {t('device.panelContent.notLoaded', { id: deviceId })}
      </div>
    )
  }
  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <EventStream deviceId={deviceId} limit={50} maxHeight="max-h-full" />
    </div>
  )
}

// ---- State Panel — runtime-state slice changes scoped to the device ----
//
// Surfaces the per-cap runtime-state writes (battery, switch, motion,
// ptz-autotrack, …) — the cache layer the kernel maintains and that
// `device.state.<cap>.value` reads in the REPL. Useful for verifying
// what the device thinks it knows after a setSettings round-trip.
interface StatePanelContentProps {
  deviceId: number
}

export function StatePanelContent({ deviceId }: StatePanelContentProps) {
  const { t } = useTranslation()
  if (!Number.isFinite(deviceId)) {
    return (
      <div className="flex items-center justify-center h-full text-[11px] text-foreground-subtle italic">
        {t('device.panelContent.notLoaded', { id: deviceId })}
      </div>
    )
  }
  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <StateValuesStream deviceId={deviceId} limit={50} maxHeight="max-h-full" />
    </div>
  )
}

// ---- Restart Panel — three big buttons (device / addon / agent) ----
//
// Mirrors the kebab Restart entries but lives in the shortcut row so
// power users don't have to chase them through a kebab. Each button
// double-confirms via `useConfirm` because all three are visible and
// destructive (a misclick interrupts the live stream / drops the
// process / restarts the whole agent). Reads addonId + name through
// `useDevice(deviceId)` — no need for the parent to thread them.
interface RestartPanelContentProps {
  deviceId: number
}

export function RestartPanelContent({ deviceId }: RestartPanelContentProps) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const { data: device } = useDevice(Number.isFinite(deviceId) ? deviceId : 0)
  const addonId = String(device?.addonId ?? '')
  const deviceName = String(device?.name ?? `device #${deviceId}`)
  const rebootMutation = useRebootReboot()
  const restartAddonMutation = useAddonsRestartAddon()

  const onRestartDevice = async () => {
    const ok = await confirm({
      title: t('device.panelContent.reboot', 'Reboot "{{deviceName}}"?', { deviceName }),
      message: t(
        'device.panelContent.theDeviceWillGoOffline',
        'The device will go offline for ~30 seconds while the firmware restarts.',
      ),
      confirmLabel: t('device.panelContent.reboot2', 'Reboot'),
      variant: 'danger',
    })
    if (ok) rebootMutation.mutate({ deviceId })
  }

  const onRestartAddon = async () => {
    const ok = await confirm({
      title: t('device.panelContent.restartAddon', 'Restart addon "{{addonId}}"?', { addonId }),
      message: t(
        'device.panelContent.everyDeviceServedByThis',
        'Every device served by this addon disconnects briefly and reconnects.',
      ),
      confirmLabel: t('device.panelContent.restart', 'Restart'),
      variant: 'danger',
    })
    if (ok) restartAddonMutation.mutate({ addonId })
  }

  return (
    <div className="flex flex-col h-full p-3 gap-2 overflow-y-auto">
      <button
        type="button"
        onClick={() => {
          void onRestartDevice()
        }}
        disabled={rebootMutation.isPending}
        className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-xs hover:bg-surface-hover disabled:opacity-50 transition-colors"
      >
        <RotateCw className="h-3.5 w-3.5" />
        <span className="flex-1 text-left">
          <div className="font-medium text-foreground">
            {t('device.panelContent.restartDevice', 'Restart device')}
          </div>
          <div className="text-[10px] text-foreground-subtle">
            {t(
              'device.panelContent.rebootTheFirmware30sOffline',
              'Reboot the firmware. ~30s offline.',
            )}
          </div>
        </span>
      </button>
      <button
        type="button"
        onClick={() => {
          void onRestartAddon()
        }}
        disabled={restartAddonMutation.isPending}
        className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-xs hover:bg-surface-hover disabled:opacity-50 transition-colors"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        <span className="flex-1 text-left">
          <div className="font-medium text-foreground">
            {t('device.panelContent.restartAddon2', 'Restart addon')}
          </div>
          <div className="text-[10px] text-foreground-subtle">
            <Trans
              i18nKey="device.panelContent.bouncesAddon"
              values={{ addonId }}
              components={{ code: <code className="text-foreground/70" /> }}
            />
          </div>
        </span>
      </button>
      <button
        type="button"
        disabled
        title={t(
          'device.panelContent.perAgentRestartComingWith',
          'Per-agent restart — coming with the agent-process supervisor.',
        )}
        className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-xs opacity-40 cursor-not-allowed"
      >
        <Server className="h-3.5 w-3.5" />
        <span className="flex-1 text-left">
          <div className="font-medium text-foreground">
            {t('device.panelContent.restartAgent', 'Restart agent')}
          </div>
          <div className="text-[10px] text-foreground-subtle">
            {t(
              'device.panelContent.disabledAgentProcessSupervisorNot',
              'Disabled — agent-process supervisor not yet wired.',
            )}
          </div>
        </span>
      </button>
    </div>
  )
}

// ---- Intercom Panel (push-to-talk) ----
interface IntercomPanelContentProps {
  deviceId: number
}

export function IntercomPanelContent({ deviceId }: IntercomPanelContentProps) {
  const { t } = useTranslation()
  if (!Number.isFinite(deviceId)) {
    return (
      <div className="flex items-center justify-center h-full text-[11px] text-foreground-subtle italic">
        {t('device.panelContent.notLoaded', { id: deviceId })}
      </div>
    )
  }
  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <IntercomPanel deviceId={deviceId} />
    </div>
  )
} /** Top ladder rung — the device panel's player poster is full-width. */
const PANEL_SNAPSHOT_WIDTH = 960
