/**
 * LiveStreamViewer — device detail camera viewer.
 *
 * Thin wrapper around StreamPanel (ui-library). Uses the shared
 * `useDeviceWebrtc` hook for WebRTC signaling + stream choices, and
 * — when the device has PTZ — exposes a header toggle on the stream
 * panel that overlays a `PTZOverlay` on the live video. The in-stream
 * overlay is fully INDEPENDENT from the floating PTZ panel surface
 * (DeviceDetail toolbar): clicking the toolbar's PTZ icon opens the
 * floating panel, clicking the in-stream PTZ button toggles the
 * overlay. They are two separate ways to drive PTZ.
 */
import { useState } from 'react'
import {
  StreamPanel,
  useDeviceWebrtc,
  useDeviceSnapshotImage,
  usePTZ,
  PTZOverlay,
  useSystem,
} from '@camstack/ui-library'
import { useDeviceDetections } from '../../hooks/useDeviceDetections'
import { useStationaryOverlay } from '@camstack/ui-library'
import { hubOrigin } from '../../lib/mount'

export interface LiveStreamViewerProps {
  /** Numeric device id — canonical handle for deviceManager queries. */
  readonly deviceId: number
  /** Display name for alt text */
  readonly deviceName?: string
  /**
   * Whether the device advertises the PTZ feature. Drives whether
   * the in-header PTZ toggle is rendered. Caller passes
   * `device.features.includes(DeviceFeature.PanTiltZoom)`.
   */
  readonly hasPTZ?: boolean
  /** Additional CSS class */
  readonly className?: string
}

/** Top ladder rung — this is a full-width player poster. */
const VIEWER_SNAPSHOT_WIDTH = 960

export function LiveStreamViewer({
  deviceId,
  deviceName,
  hasPTZ = false,
  className,
}: LiveStreamViewerProps) {
  const system = useSystem()
  const serverUrl = typeof window !== 'undefined' ? hubOrigin() : ''
  const isValidDeviceId = Number.isFinite(deviceId)

  // Header-toggle state for the in-stream PTZ overlay. Fully
  // independent from the DeviceDetail floating PTZ panel — that panel
  // is its own surface, the in-stream overlay is its own surface,
  // operators flip whichever they want without coupling.
  const [headerPtzShown, setHeaderPtzShown] = useState(false)
  const ptzActive = isValidDeviceId && hasPTZ && headerPtzShown

  // Snapshot — a plain data-plane image URL served by the snapshot WRAPPER
  // (browser HTTP cache + ETag), replacing a hand-rolled duplicate of
  // `useDeviceSnapshotImage` that fetched a base64 4 K frame over the WebSocket
  // AND cached it under a different query key than the panel's copy, so the two
  // never shared a byte. `force` is applied only by the refresh button, so
  // navigation never wakes a battery camera.
  const snapshot = useDeviceSnapshotImage(isValidDeviceId ? deviceId : null, {
    width: VIEWER_SNAPSHOT_WIDTH,
  })

  // WebRTC signaling + stream choices via shared hook
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
  } = useDeviceWebrtc(system.trpcClient, isValidDeviceId ? deviceId : null)

  // Detection data
  const detectionData = useDeviceDetections(isValidDeviceId ? deviceId : null)
  // The census. It is NOT in the detection stream — a promoted parked object is
  // dropped from the tracker on purpose — so the stationary layer is fed from
  // the occupancy snapshot, which is the only place it exists.
  const stationaryObjects = useStationaryOverlay(
    system.trpcClient,
    isValidDeviceId ? deviceId : null,
  )

  // PTZ — only fire underlying queries when the overlay is actually
  // rendered. `enabled: ptzActive` short-circuits `getPresets` and
  // the wrap()-protected method calls so non-PTZ cameras + hidden
  // overlays never hit the cap router with a doomed request.
  const ptzControls = usePTZ(system.trpcClient, isValidDeviceId ? deviceId : 0, {
    enabled: ptzActive,
  })

  const snapshotSrc = snapshot.src

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
      streams={streams}
      pipelineMetrics={pipelineMetrics}
      deviceName={deviceName}
      phase={detectionData.phase}
      detections={detectionData}
      {...(stationaryObjects !== undefined ? { stationaryObjects } : {})}
      defaultShowDetections={false}
      defaultShowMotion={false}
      autoPlay={false}
      showPlayStop
      snapshotSrc={snapshotSrc}
      {...(snapshotSrc ? { posterUrl: snapshotSrc } : {})}
      snapshotLoading={snapshot.loading}
      onRefreshSnapshot={snapshot.refresh}
      ptzAvailable={isValidDeviceId && hasPTZ}
      ptzShown={ptzActive}
      onPtzToggle={() => setHeaderPtzShown((v) => !v)}
      ptzOverlay={ptzActive ? <PTZOverlay controls={ptzControls} /> : undefined}
      className={className}
    />
  )
}
