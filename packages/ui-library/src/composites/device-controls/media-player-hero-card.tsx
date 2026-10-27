import { useUiText } from '../../contexts/ui-text'
import type { ReactNode } from 'react'
import { SkipBack, SkipForward, Play, Pause, Music, Volume2, VolumeX } from 'lucide-react'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice'
import { cn } from '../../lib/cn'
import type { MediaPlayerStatus, MediaPlayerState } from '@camstack/types'
import { DeviceFeature } from '@camstack/types'
import type { DeviceControlProps } from './control-registry'
import { GripTrack } from './atoms'

// ── Cap surface ───────────────────────────────────────────────────────────────
// Named cap type; the accessor performs the documented cap-access boundary
// narrowing (mirrors light-hero-card.tsx). Inputs omit `deviceId` — the device
// proxy injects it before forwarding.

type MediaPlayerCap = {
  play: (i: Record<string, never>) => Promise<void>
  pause: (i: Record<string, never>) => Promise<void>
  next: (i: Record<string, never>) => Promise<void>
  previous: (i: Record<string, never>) => Promise<void>
  seek: (i: { position: number }) => Promise<void>
  setVolume: (i: { volumeLevel: number }) => Promise<void>
  setMute: (i: { muted: boolean }) => Promise<void>
}

// ── State helpers ─────────────────────────────────────────────────────────────

/** Which states map to play() vs pause() on the central transport button. */
function toggleAction(state: MediaPlayerState): 'play' | 'pause' {
  if (state === 'playing' || state === 'buffering') return 'pause'
  return 'play'
}

/** 0..1 progress fraction from position/duration; 0 when unknown. */
function progressFraction(positionMs: number | null, durationMs: number | null): number {
  if (positionMs === null || durationMs === null || durationMs <= 0) return 0
  return Math.min(1, Math.max(0, positionMs / durationMs))
}

function formatClock(ms: number | null): string {
  if (ms === null) return '--:--'
  const total = Math.floor(ms / 1000)
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

// ── Now-playing block ─────────────────────────────────────────────────────────

interface NowPlayingProps {
  readonly title: string | null
  readonly subtitle: string | null
}

function NowPlaying({ title, subtitle }: NowPlayingProps): ReactNode {
  const t = useUiText()
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <Music className="h-6 w-6 text-foreground-subtle" aria-hidden="true" />
      <span className="text-base font-semibold text-foreground line-clamp-1">
        {title ?? t('uiLibrary.mediaPlayerHero.nothing', 'Nothing playing')}
      </span>
      {subtitle && <span className="text-xs text-foreground-subtle line-clamp-1">{subtitle}</span>}
    </div>
  )
}

// ── Transport button ──────────────────────────────────────────────────────────

interface TransportButtonProps {
  readonly label: string
  readonly busy: boolean
  readonly onPress: () => void
  readonly children: ReactNode
  readonly primary?: boolean
}

function TransportButton({
  label,
  busy,
  onPress,
  children,
  primary,
}: TransportButtonProps): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation()
        if (!busy) onPress()
      }}
      className={cn(
        'inline-flex items-center justify-center rounded-full transition-colors',
        primary
          ? 'h-12 w-12 bg-primary text-primary-foreground hover:bg-primary/90 shadow-md'
          : 'h-10 w-10 text-foreground-muted hover:bg-surface-hover',
        busy && 'opacity-40 cursor-not-allowed',
      )}
    >
      {children}
    </button>
  )
}

// ── MediaPlayerHeroCard ─────────────────────────────────────────────────────

/**
 * MediaPlayerHeroCard — now-playing hero for MediaPlayer devices.
 *
 * Renders (Spec §3):
 *  - Now-playing block: cover glyph + title + artist/album.
 *  - Seek GripTrack with a native range overlay (gated on DeviceFeature
 *    MediaPlayerSeek + a known duration).
 *  - Transport row: SkipBack / Play-Pause / SkipForward (lucide icons). Skip
 *    buttons are gated on MediaPlayerPrevious / MediaPlayerNext.
 *  - Volume GripTrack with a native range overlay + mute toggle (gated on a
 *    non-null volume surface + DeviceFeature.MediaPlayerVolume).
 *
 * Cap-gated on `media-player` — returns null when the device lacks the cap.
 */
export function MediaPlayerHeroCard({
  trpc,
  deviceId,
  features,
  optimistic,
}: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useDeviceCapability<MediaPlayerCap, MediaPlayerStatus>({
    trpc,
    deviceId,
    cap: (d) => d.mediaPlayer as MediaPlayerCap | undefined,
    slice: (d) => d.state.mediaPlayer,
  })

  const { display, applyOptimistic } = useOptimisticSlice<MediaPlayerStatus>(slice, {
    enabled: optimistic ?? true,
  })

  if (cap === undefined) return null
  if (display === undefined) return null

  const busy = !available
  const action = toggleAction(display.state)

  const supportsSeek =
    (features?.includes(DeviceFeature.MediaPlayerSeek) ?? false) &&
    display.duration !== null &&
    display.duration > 0
  const supportsNext = features?.includes(DeviceFeature.MediaPlayerNext) ?? false
  const supportsPrevious = features?.includes(DeviceFeature.MediaPlayerPrevious) ?? false
  const supportsVolume =
    (features?.includes(DeviceFeature.MediaPlayerVolume) ?? false) && display.volumeLevel !== null

  const handleToggle = (): void => {
    if (busy) return
    if (action === 'play') {
      applyOptimistic({ state: 'playing' })
      void cap.play({})
    } else {
      applyOptimistic({ state: 'paused' })
      void cap.pause({})
    }
  }

  const subtitle = display.currentMedia?.artist ?? display.currentMedia?.album ?? null
  const seekFraction = progressFraction(display.position, display.duration)
  const volumeLevel = display.volumeLevel ?? 0

  return (
    <div className="flex flex-col items-stretch gap-4 rounded-lg border border-border bg-surface p-6">
      {/* ── Now playing ─────────────────────────────────────────────────────── */}
      <NowPlaying title={display.currentMedia?.title ?? null} subtitle={subtitle} />

      {/* ── Seek track (only when seekable + duration known) ────────────────── */}
      {supportsSeek && (
        <div data-testid="media-seek" className="flex flex-col gap-1">
          <label className="relative block">
            <span className="sr-only">{t('uiLibrary.mediaPlayerHero.seek', 'Seek')}</span>
            <input
              aria-label={t('uiLibrary.mediaPlayerHero.seek', 'Seek')}
              type="range"
              min={0}
              max={display.duration ?? 0}
              step={1000}
              className="absolute inset-0 h-4 w-full cursor-pointer opacity-0"
              value={display.position ?? 0}
              disabled={busy}
              onChange={(e) => {
                if (busy) return
                const positionMs = Number(e.target.value)
                applyOptimistic({ position: positionMs })
                void cap.seek({ position: positionMs })
              }}
            />
            <div className="pointer-events-none">
              <GripTrack fraction={seekFraction} />
            </div>
          </label>
          <div className="flex justify-between text-[11px] tabular-nums text-foreground-subtle">
            <span>{formatClock(display.position)}</span>
            <span>{formatClock(display.duration)}</span>
          </div>
        </div>
      )}

      {/* ── Transport: prev / play-pause / next ─────────────────────────────── */}
      <div className="flex items-center justify-center gap-4">
        {supportsPrevious && (
          <TransportButton
            label={t('uiLibrary.mediaPlayerHero.previous', 'Previous')}
            busy={busy}
            onPress={() => void cap.previous({})}
          >
            <SkipBack className="h-5 w-5" aria-hidden="true" />
          </TransportButton>
        )}
        <TransportButton
          label={
            action === 'play'
              ? t('uiLibrary.mediaPlayerHero.play', 'Play')
              : t('uiLibrary.mediaPlayerHero.pause', 'Pause')
          }
          busy={busy}
          onPress={handleToggle}
          primary
        >
          {action === 'play' ? (
            <Play className="h-6 w-6" aria-hidden="true" />
          ) : (
            <Pause className="h-6 w-6" aria-hidden="true" />
          )}
        </TransportButton>
        {supportsNext && (
          <TransportButton
            label={t('uiLibrary.mediaPlayerHero.next', 'Next')}
            busy={busy}
            onPress={() => void cap.next({})}
          >
            <SkipForward className="h-5 w-5" aria-hidden="true" />
          </TransportButton>
        )}
      </div>

      {/* ── Volume track + mute (only when a volume surface exists) ──────────── */}
      {supportsVolume && (
        <div data-testid="media-volume" className="flex items-center gap-2">
          <button
            type="button"
            aria-label={
              display.isMuted === true
                ? t('uiLibrary.mediaPlayerHero.unmute', 'Unmute')
                : t('uiLibrary.mediaPlayerHero.mute', 'Mute')
            }
            title={
              display.isMuted === true
                ? t('uiLibrary.mediaPlayerHero.unmute', 'Unmute')
                : t('uiLibrary.mediaPlayerHero.mute', 'Mute')
            }
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation()
              if (busy || display.isMuted === null) return
              const muted = !display.isMuted
              applyOptimistic({ isMuted: muted })
              void cap.setMute({ muted })
            }}
            className={cn(
              'inline-flex h-7 w-7 items-center justify-center rounded text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors',
              busy && 'opacity-40 cursor-not-allowed',
            )}
          >
            {display.isMuted === true ? (
              <VolumeX className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Volume2 className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
          <label className="relative block flex-1">
            <span className="sr-only">{t('uiLibrary.mediaPlayerHero.volume', 'Volume')}</span>
            <input
              aria-label={t('uiLibrary.mediaPlayerHero.volume', 'Volume')}
              type="range"
              min={0}
              max={100}
              step={1}
              className="absolute inset-0 h-4 w-full cursor-pointer opacity-0"
              value={volumeLevel}
              disabled={busy}
              onChange={(e) => {
                if (busy) return
                const next = Number(e.target.value)
                applyOptimistic({ volumeLevel: next })
                void cap.setVolume({ volumeLevel: next })
              }}
            />
            <div className="pointer-events-none">
              <GripTrack fraction={volumeLevel / 100} />
            </div>
          </label>
          <span className="w-9 text-right text-[11px] tabular-nums text-foreground-subtle">
            {volumeLevel}%
          </span>
        </div>
      )}
    </div>
  )
}
