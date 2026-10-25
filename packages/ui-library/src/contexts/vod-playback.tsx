/**
 * VodPlayback — shared context coordinating recorded (VOD) playback between a
 * widget/section (the Recording panel) and the hero StreamPanel.
 *
 * A CONTROLLER (the Recording widget) calls `play({ url, label })`; the hero
 * StreamPanel CONSUMES `request` and switches into VOD mode (HLS playback
 * through the hub data-plane) instead of the live WebRTC stream. `clear()`
 * returns the hero to live.
 *
 * Built on `createSharedContext` (NOT a plain `createContext`) so it crosses
 * the Module-Federation boundary: an addon-shipped widget consuming
 * `useVodPlayback()` resolves the SAME provider instance the host mounted —
 * the same mechanism `player-overlays` / `zone-editing` use to let federated
 * widgets (zone-editor, privacy-mask) drive the live player. Consumers used
 * outside a provider get the inert default (no-op), so a StreamPanel mounted
 * on a page without the Recording widget stays live-only without crashing.
 */
import { useContext, useMemo, useState, type ReactNode, type JSX } from 'react'
import { createSharedContext } from '../lib/shared-context'

export interface VodPlaybackRequest {
  /** Media URL through the hub data-plane (relative) — an HLS master `.m3u8`,
   *  or a progressive `.mp4` when {@link format} says so. */
  readonly url: string
  /**
   * What {@link url} is. Absent means `hls`, so every existing controller is
   * unchanged.
   *
   * A NATIVE clip (a camera's own file, fetched and muxed by its vendor addon)
   * is `mp4`: the hero player sets `video.src` instead of handing it to
   * hls.js, which would parse the file as a manifest and fail (D549 22). The
   * value comes straight from `videoclips.getClipPlayback().format` — the
   * provider is the only thing that knows.
   */
  readonly format?: 'hls' | 'mp4'
  /** Short human label shown in the hero while playing (e.g. a timestamp). */
  readonly label?: string
}

export interface VodPlaybackContextValue {
  readonly request: VodPlaybackRequest | null
  readonly play: (request: VodPlaybackRequest) => void
  readonly clear: () => void
}

const INERT: VodPlaybackContextValue = {
  request: null,
  play: () => {},
  clear: () => {},
}

const VodPlaybackContext = createSharedContext<VodPlaybackContextValue>(
  'camstack:vod-playback',
  INERT,
)

export function VodPlaybackProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [request, setRequest] = useState<VodPlaybackRequest | null>(null)
  const value = useMemo<VodPlaybackContextValue>(
    () => ({
      request,
      play: (req) => setRequest(req),
      clear: () => setRequest(null),
    }),
    [request],
  )
  return <VodPlaybackContext.Provider value={value}>{children}</VodPlaybackContext.Provider>
}

/** @returns the VOD playback controller (inert no-op outside a provider). */
export function useVodPlayback(): VodPlaybackContextValue {
  return useContext(VodPlaybackContext)
}
