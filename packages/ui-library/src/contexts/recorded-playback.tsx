/**
 * RecordedPlayback — shared context wiring the hero player's
 * `camstack-control` RTCDataChannel to the Recording timeline (R9).
 *
 * The hero `StreamPanel` (host side) BINDS the channel that
 * `CameraStreamPlayer` opens on the live WebRTC session; the Recording
 * widget's `RecordingTimeline` (controller side) SENDS frame-push playback
 * commands over it (seek / scrubCommit / setRate / goLive — the broker's
 * `TimelineSession` drives the `RecordedFeeder` on the SAME session, so
 * recorded frames arrive on the same `<video>` element) and OBSERVES the
 * server's playback state + ~1 Hz position reports.
 *
 * This is the admin-ui port of the shipped viewer's default recorded path
 * (srcV2 → embed → `camstack-control`), replacing "manifest-window HLS only".
 * The HLS VOD path (VodPlayback context) remains available as a fallback.
 *
 * Built on `createSharedContext` (NOT a plain `createContext`) so it crosses
 * the Module-Federation boundary — same mechanism as `vod-playback`.
 * Consumers outside a provider get the inert default: `bindControlChannel`
 * is null (StreamPanel then opens NO datachannel — plain live player) and
 * `channelOpen` is false (RecordingTimeline stays on the HLS path).
 */
import { useCallback, useContext, useMemo, useRef, useState, type ReactNode, type JSX } from 'react'
import { createSharedContext } from '../lib/shared-context'
import {
  parseRecordedServerMessage,
  serializeRecordedCommand,
  type RecordedControlCommand,
  type RecordedPlaybackMode,
} from '../lib/recorded-control-protocol'

export interface RecordedPlaybackContextValue {
  /**
   * Host-side binding for the player's `onControlChannel` prop. `null` in the
   * inert default — a StreamPanel outside the provider passes `undefined` to
   * the player and no datachannel is created (behaviour unchanged).
   */
  readonly bindControlChannel: ((channel: RTCDataChannel) => void) | null
  /** True while a bound channel is open — frame-push control is available. */
  readonly channelOpen: boolean
  /** Last server-reported playback mode (`live` until told otherwise). */
  readonly mode: RecordedPlaybackMode
  /** Last server-reported playback position (~1 Hz), or null while live. */
  readonly positionMs: number | null
  /** Send a control command. Returns false when the channel isn't open. */
  readonly send: (cmd: RecordedControlCommand) => boolean
}

const INERT: RecordedPlaybackContextValue = {
  bindControlChannel: null,
  channelOpen: false,
  mode: 'live',
  positionMs: null,
  send: () => false,
}

const RecordedPlaybackContext = createSharedContext<RecordedPlaybackContextValue>(
  'camstack:recorded-playback',
  INERT,
)

export function RecordedPlaybackProvider({
  children,
}: {
  readonly children: ReactNode
}): JSX.Element {
  const channelRef = useRef<RTCDataChannel | null>(null)
  const [channelOpen, setChannelOpen] = useState(false)
  const [mode, setMode] = useState<RecordedPlaybackMode>('live')
  const [positionMs, setPositionMs] = useState<number | null>(null)

  // Bind (or re-bind on player reconnect) the control channel. The player
  // creates a fresh channel per PeerConnection; the latest one wins. Handlers
  // are (re)attached here so a stale channel's close can't clobber a newer
  // binding (guarded by identity checks).
  const bindControlChannel = useCallback((channel: RTCDataChannel): void => {
    channelRef.current = channel
    const markClosed = (): void => {
      if (channelRef.current !== channel) return
      channelRef.current = null
      setChannelOpen(false)
      // The server session is gone with the connection — position/mode are
      // stale; reset to the live defaults so the timeline falls back cleanly.
      setMode('live')
      setPositionMs(null)
    }
    channel.onopen = () => {
      if (channelRef.current === channel) setChannelOpen(true)
    }
    channel.onclose = markClosed
    channel.onerror = markClosed
    channel.onmessage = (e: MessageEvent) => {
      if (channelRef.current !== channel) return
      const data: unknown = e.data
      if (typeof data !== 'string') return
      const msg = parseRecordedServerMessage(data)
      if (!msg) return
      if (msg.kind === 'position') {
        setPositionMs(msg.epochMs)
      } else if (msg.kind === 'state') {
        setMode(msg.state)
        if (msg.state === 'live') setPositionMs(null)
      }
      // `servedProfile` is the embed's to act on (pin mirror, upgrade veto);
      // this context tracks mode and position only.
    }
    if (channel.readyState === 'open') {
      setChannelOpen(true)
    } else if (channel.readyState === 'closed' || channel.readyState === 'closing') {
      markClosed()
    } else {
      setChannelOpen(false)
    }
  }, [])

  const send = useCallback((cmd: RecordedControlCommand): boolean => {
    const channel = channelRef.current
    if (!channel || channel.readyState !== 'open') return false
    channel.send(serializeRecordedCommand(cmd))
    return true
  }, [])

  const value = useMemo<RecordedPlaybackContextValue>(
    () => ({ bindControlChannel, channelOpen, mode, positionMs, send }),
    [bindControlChannel, channelOpen, mode, positionMs, send],
  )

  return (
    <RecordedPlaybackContext.Provider value={value}>{children}</RecordedPlaybackContext.Provider>
  )
}

/** @returns the recorded-playback control surface (inert outside a provider). */
export function useRecordedPlayback(): RecordedPlaybackContextValue {
  return useContext(RecordedPlaybackContext)
}
