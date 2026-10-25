/**
 * HlsVideo — reusable HLS (VOD) `<video>` for recorded playback.
 *
 * The recorder serves SELF-CONTAINED per-segment fMP4 (each `.m4s` carries
 * its own ftyp+moov) with reset timestamps and NO EXT-X-MAP. hls.js handles
 * that shape; NATIVE Safari HLS rejects it (loads the first frame then stalls
 * building the timeline → "could not load"). So hls.js is PREFERRED and native
 * is a last-resort fallback only.
 *
 * The playback URL is served through the hub data-plane reverse-proxy
 * (`/addon/<addonId>/...`) — same origin/cert as the admin-ui (no mixed
 * content). The route is admin-gated: hls.js sends the stored admin Bearer via
 * `xhrSetup`, and `withCredentials` lets the same-origin session cookie ride
 * too (so the native fallback, which can't set a header, still authenticates).
 *
 * Data-agnostic: the caller fetches the manifest URL + supplies the auth token
 * (ui-library never reaches into localStorage).
 *
 * Quality state is LIFTED to the caller via `onQualityOptions` / `selectedLevel`
 * so the parent (StreamPanel) can render the selector in the header alongside
 * the live stream selector, at the same position and with the same styling.
 */
import { useEffect, useRef, useState, type JSX } from 'react'
import { useUiText } from '../contexts/ui-text'
import type Hls from 'hls.js'
import type { Events, ManifestParsedData } from 'hls.js'
import { qualityOptions, type HlsLevelInfo, type QualityOption } from './hls-quality'

export interface HlsVideoProps {
  /** Media URL (typically relative, through the hub data-plane) — an HLS
   *  master `.m3u8`, or a progressive `.mp4` when {@link format} says so. */
  readonly url: string
  /**
   * What {@link url} is. Absent means `hls` — every existing caller is
   * unchanged by construction.
   *
   * `mp4` is the NATIVE-CLIP path (D549 22): a vendor addon fetched the
   * camera's own file, muxed it once with `+faststart` and serves it with
   * `Range`, so a plain `<video src>` seeks natively and hls.js is not
   * involved at all — handing it an MP4 would have it parse the file as a
   * manifest and fail. **Nothing is appended to the URL**: the hub's
   * `/addon/<id>/<prefix>` proxy takes the same-origin session cookie, which
   * is what the native-Safari branch below already relies on, so the URL is
   * never a credential.
   */
  readonly format?: 'hls' | 'mp4'
  /** Bearer token for the admin-gated data-plane route (optional). */
  readonly authToken?: string | null
  /** Poster painted until the first frame decodes (optional). */
  readonly posterUrl?: string
  /** Auto-play once the manifest is parsed (default: true). */
  readonly autoPlay?: boolean
  readonly className?: string
  /**
   * Called on MANIFEST_PARSED (and reset to `[]` on a new URL) with the
   * full list of quality options (`qualityOptions(hls.levels)`). The caller
   * renders the selector; this component owns only the hls instance.
   * Emits `[]` when the manifest has ≤1 real level (no selector needed).
   */
  readonly onQualityOptions?: (options: readonly QualityOption[]) => void
  /**
   * The level index to apply to `hls.currentLevel`. `-1` = Auto/ABR
   * (default). When this prop changes, the component sets `hls.currentLevel`
   * immediately. Has no effect in the native HLS fallback path.
   */
  readonly selectedLevel?: number
}

// hls.js reports `height: 0` when the level has no resolution in the manifest.
// Treat 0 as absent (unknown) to match the `HlsLevelInfo.height > 0` contract.
function hlsLevelToInfo(level: {
  readonly height: number
  readonly bitrate: number
  readonly name: string
}): HlsLevelInfo {
  return {
    height: level.height > 0 ? level.height : undefined,
    bitrate: level.bitrate > 0 ? level.bitrate : undefined,
    name: level.name.length > 0 ? level.name : undefined,
  }
}

export function HlsVideo({
  url,
  format = 'hls',
  authToken,
  posterUrl,
  autoPlay = true,
  className,
  onQualityOptions,
  selectedLevel = -1,
}: HlsVideoProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  // The manifest callback reads the latest translator without re-attaching hls.
  const t = useUiText()
  const tRef = useRef(t)
  tRef.current = t
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !url) return
    setError(null)
    setLoading(true)
    // Reset quality options on each new URL — caller receives [] immediately.
    onQualityOptions?.([])

    const onPlaying = (): void => setLoading(false)
    video.addEventListener('playing', onPlaying)

    // A progressive MP4: the browser plays it directly. Checked FIRST, before
    // any hls.js consideration — the two paths are mutually exclusive and a
    // manifest parser handed an MP4 fails with an error the operator cannot
    // act on. Nothing is appended to `url` and `crossOrigin` stays unset: the
    // clip plane is same-origin and authenticates by cookie (D549 22).
    if (format === 'mp4') {
      video.src = url
      const onLoaded = (): void => {
        if (autoPlay) void video.play().catch(() => {})
      }
      const onFailed = (): void => setError('Could not load this clip.')
      video.addEventListener('loadedmetadata', onLoaded)
      video.addEventListener('error', onFailed)
      // No quality levels on a single file — the caller's selector stays empty.
      onQualityOptions?.([])
      return () => {
        video.removeEventListener('loadedmetadata', onLoaded)
        video.removeEventListener('error', onFailed)
        video.removeEventListener('playing', onPlaying)
        video.removeAttribute('src')
        video.load()
      }
    }

    // Native HLS fallback (older iOS Safari without MSE). Relies on the
    // same-origin session cookie — native players can't set an auth header.
    // Check this BEFORE the dynamic hls.js load so Safari takes this path
    // immediately (hls.js MSE is not available in Safari at all).
    if (!('MediaSource' in window) && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url
      const onLoaded = (): void => {
        if (autoPlay) void video.play().catch(() => {})
      }
      video.addEventListener('loadedmetadata', onLoaded)
      video.addEventListener('error', () => setError('Could not load this recording.'))
      return () => {
        video.removeEventListener('loadedmetadata', onLoaded)
        video.removeEventListener('playing', onPlaying)
        video.removeAttribute('src')
        video.load()
      }
    }

    // Prefer hls.js (MSE) — native Safari HLS can't parse the recorder's
    // map-less per-segment fMP4. The data-plane route is admin-gated: send
    // the supplied Bearer (and credentials so the same-origin cookie rides).
    // hls.js is loaded dynamically so it is split into its own lazy chunk
    // and never included in the initial admin-ui bundle.
    let cancelled = false
    void import('hls.js').then(({ default: HlsClass }) => {
      if (cancelled) return
      if (!HlsClass.isSupported()) {
        // MSE claimed available but hls.js disagrees — last-resort native path.
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = url
          const onLoaded = (): void => {
            if (autoPlay) void video.play().catch(() => {})
          }
          video.addEventListener('loadedmetadata', onLoaded)
          video.addEventListener('error', () => setError('Could not load this recording.'))
        } else {
          setLoading(false)
          setError('HLS playback is not supported in this browser.')
        }
        return
      }

      const hls = new HlsClass({
        enableWorker: true,
        lowLatencyMode: false,
        xhrSetup: (xhr) => {
          xhr.withCredentials = true
          if (authToken) xhr.setRequestHeader('Authorization', `Bearer ${authToken}`)
        },
      })
      hlsRef.current = hls
      hls.loadSource(url)
      hls.attachMedia(video)
      hls.on(
        HlsClass.Events.MANIFEST_PARSED,
        (_evt: Events.MANIFEST_PARSED, data: ManifestParsedData) => {
          const levels = data.levels.map(hlsLevelToInfo)
          // Only emit options when there are ≥2 real levels — a single-level
          // manifest doesn't benefit from a quality picker.
          onQualityOptions?.(levels.length > 1 ? qualityOptions(levels, tRef.current) : [])
          if (autoPlay) void video.play().catch(() => {})
        },
      )
      hls.on(HlsClass.Events.ERROR, (_evt, data) => {
        if (data.fatal) {
          setLoading(false)
          setError(`Playback error (${data.type}).`)
        }
      })
    })

    return () => {
      cancelled = true
      video.removeEventListener('playing', onPlaying)
      // Destroy if the instance was already created before unmount.
      hlsRef.current?.destroy()
      hlsRef.current = null
    }
  }, [url, format, authToken, autoPlay, onQualityOptions])

  // Apply the caller-controlled level whenever it changes.
  useEffect(() => {
    const hls = hlsRef.current
    if (hls === null) return
    hls.currentLevel = selectedLevel
  }, [selectedLevel])

  return (
    <div className={`relative h-full w-full bg-black ${className ?? ''}`}>
      <video
        ref={videoRef}
        controls
        playsInline
        className="h-full w-full"
        {...(posterUrl ? { poster: posterUrl } : {})}
      />
      {loading && !error ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/60" />
        </div>
      ) : null}
      {error ? (
        <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-amber-400">
          {error}
        </div>
      ) : null}
    </div>
  )
}
