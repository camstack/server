import { useUiText } from '../../contexts/ui-text'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Minus,
  Music,
  Play,
  Pause,
  Plus,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Square,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { useDeviceState } from '../../hooks/use-device-proxy'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice'
import { cn } from '../../lib/cn'
import { Select } from '../../primitives/select'
import type {
  MediaPlayerRepeat,
  MediaPlayerStatus,
  MediaPlayerState,
  RunningStateStatus,
} from '@camstack/types'
import type { DeviceControlProps } from './control-registry'
import { GripTrack } from './atoms'
import { MEDIA_HERO_KEYFRAMES, PowerOrb, RunningIndicator } from './media-player-hero-parts'
import {
  deriveMediaPlayerView,
  isPositionTicking,
  projectedPositionMs,
  type NowPlayingView,
  type PowerView,
} from './media-player-view'

// ── Cap surface ───────────────────────────────────────────────────────────────
// Named cap type; the accessor performs the documented cap-access boundary
// narrowing (mirrors light-hero-card.tsx). Inputs omit `deviceId` — the device
// proxy injects it before forwarding.

type MediaPlayerCap = {
  turnOn: (i: Record<string, never>) => Promise<void>
  turnOff: (i: Record<string, never>) => Promise<void>
  play: (i: Record<string, never>) => Promise<void>
  pause: (i: Record<string, never>) => Promise<void>
  stop: (i: Record<string, never>) => Promise<void>
  next: (i: Record<string, never>) => Promise<void>
  previous: (i: Record<string, never>) => Promise<void>
  seek: (i: { position: number }) => Promise<void>
  setVolume: (i: { volumeLevel: number }) => Promise<void>
  volumeUp: (i: { steps: number }) => Promise<void>
  volumeDown: (i: { steps: number }) => Promise<void>
  setMute: (i: { muted: boolean }) => Promise<void>
  setShuffle: (i: { shuffle: boolean }) => Promise<void>
  setRepeat: (i: { repeat: MediaPlayerRepeat }) => Promise<void>
  selectSource: (i: { source: string }) => Promise<void>
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

const NEXT_REPEAT: Readonly<Record<MediaPlayerRepeat, MediaPlayerRepeat>> = {
  off: 'all',
  all: 'one',
  one: 'off',
}

// ── Now-playing block ─────────────────────────────────────────────────────────

/** The artwork of what is playing; a change cross-fades from the previous cover. */
function Artwork({ url }: { readonly url: string | null }): ReactNode {
  const [shown, setShown] = useState<string | null>(url)
  const [previous, setPrevious] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const last = useRef<string | null>(url)
  useEffect(() => {
    if (last.current === url) return
    setPrevious(last.current)
    setShown(url)
    last.current = url
    const timer = setTimeout(() => setPrevious(null), 700)
    return () => clearTimeout(timer)
  }, [url])
  const visible = shown !== null && failed !== shown
  return (
    <div
      data-testid="media-artwork"
      className="relative h-40 w-40 overflow-hidden rounded-lg border border-border bg-surface-hover"
    >
      {previous !== null && (
        <img
          src={previous}
          alt=""
          className="mph-fade-out absolute inset-0 h-full w-full object-cover"
        />
      )}
      {visible ? (
        <img
          key={shown}
          src={shown}
          alt=""
          data-testid="media-artwork-img"
          className="mph-fade-in absolute inset-0 h-full w-full object-cover"
          onError={() => setFailed(shown)}
        />
      ) : (
        <Music
          className="absolute inset-0 m-auto h-8 w-8 text-foreground-subtle"
          aria-hidden="true"
        />
      )}
    </div>
  )
}

interface NowPlayingProps {
  readonly media: NowPlayingView
  /** Position to draw in ms (advanced locally when the status is stamped); null = unknown. */
  readonly positionMs: number | null
}

function NowPlaying({ media, positionMs }: NowPlayingProps): ReactNode {
  const t = useUiText()
  const progress = media.progress
  return (
    <div className="flex flex-col items-center gap-2 text-center" data-testid="media-now-playing">
      {media.artworkUrl !== null ? (
        <Artwork url={media.artworkUrl} />
      ) : (
        <Music className="h-6 w-6 text-foreground-subtle" aria-hidden="true" />
      )}
      <span
        className="text-base font-semibold text-foreground line-clamp-1"
        data-testid="media-title"
      >
        {media.title ?? t('uiLibrary.mediaPlayerHero.nothing', 'Nothing playing')}
      </span>
      {media.subtitle !== null && (
        <span className="text-xs text-foreground-subtle line-clamp-1" data-testid="media-subtitle">
          {media.subtitle}
        </span>
      )}
      {progress !== null && (
        <div className="flex w-full flex-col gap-1" data-testid="media-progress">
          <GripTrack
            readOnly
            fraction={progressFraction(positionMs ?? progress.positionMs, progress.durationMs)}
          />
          <div className="flex justify-between text-[11px] tabular-nums text-foreground-subtle">
            <span>{formatClock(positionMs ?? progress.positionMs)}</span>
            <span>{formatClock(progress.durationMs)}</span>
          </div>
        </div>
      )}
    </div>
  )
}

// ── State line ────────────────────────────────────────────────────────────────

const STATE_LABEL: Readonly<Record<MediaPlayerState, string>> = {
  off: 'Off',
  on: 'On',
  idle: 'Idle',
  playing: 'Playing',
  paused: 'Paused',
  buffering: 'Buffering',
  standby: 'Standby',
}

interface StateLineProps {
  /** The reported state; undefined while the status has not arrived (shown as unknown). */
  readonly state: MediaPlayerState | undefined
  /** Some of what is shown is the driver's own bookkeeping (infrared), not a reading. */
  readonly assumed: boolean
  /** The active source as plain text; empty when it is a picker or absent. */
  readonly source: string
  readonly running: ReactNode
}

function StateLine({ state, assumed, source, running }: StateLineProps): ReactNode {
  const t = useUiText()
  return (
    <div
      className="flex flex-wrap items-center justify-center gap-2 text-xs text-foreground-muted"
      data-testid="media-state"
    >
      {running}
      {state === undefined ? (
        <span className="font-medium text-foreground-subtle" data-testid="media-state-unknown">
          {t('uiLibrary.mediaPlayerHero.state.unknown', 'State unknown')}
        </span>
      ) : (
        <span className="font-medium text-foreground">
          {t(`uiLibrary.mediaPlayerHero.state.${state}`, STATE_LABEL[state])}
        </span>
      )}
      {assumed && (
        <span
          className="rounded border border-dashed border-border px-1.5 py-0.5 text-[11px] text-foreground-subtle"
          title={t(
            'uiLibrary.mediaPlayerHero.assumedHint',
            'No feedback from the device: this is what was last sent.',
          )}
          data-testid="media-assumed"
        >
          {t('uiLibrary.mediaPlayerHero.assumed', 'assumed')}
        </span>
      )}
      {source !== '' && <span data-testid="media-source">{source}</span>}
    </div>
  )
}

// ── Buttons ───────────────────────────────────────────────────────────────────

interface TransportButtonProps {
  readonly label: string
  readonly busy: boolean
  readonly onPress: () => void
  readonly children: ReactNode
  readonly primary?: boolean
  readonly active?: boolean
  readonly testId?: string
}

function TransportButton({
  label,
  busy,
  onPress,
  children,
  primary,
  active,
  testId,
}: TransportButtonProps): ReactNode {
  return (
    // ui-check-ok: round state-toned control (transport key / mute / power orb); no IconButton size
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={busy}
      data-testid={testId}
      onClick={(e) => {
        e.stopPropagation()
        if (!busy) onPress()
      }}
      className={cn(
        'inline-flex items-center justify-center rounded-full transition-colors',
        primary
          ? 'h-12 w-12 bg-primary text-primary-foreground hover:bg-primary/90 shadow-md'
          : 'h-10 w-10 text-foreground-muted hover:bg-surface-hover',
        active === true && 'bg-primary/15 text-primary',
        busy && 'opacity-40 cursor-not-allowed',
      )}
    >
      {children}
    </button>
  )
}

interface ModeFlagProps {
  readonly label: string
  readonly active: boolean
  readonly testId: string
  readonly children: ReactNode
}

/** A shuffle / repeat value the device reports but cannot be told to change: drawn, not pressable. */
function ModeFlag({ label, active, testId, children }: ModeFlagProps): ReactNode {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-testid={testId}
      data-active={active}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-full',
        active ? 'bg-primary/15 text-primary' : 'text-foreground-subtle',
      )}
    >
      {children}
    </span>
  )
}

// ── MediaPlayerHeroCard ─────────────────────────────────────────────────────

/**
 * MediaPlayerHeroCard — the state of a MediaPlayer device and every control it
 * exposes, drawn from `deriveMediaPlayerView` (the state → view mapping and
 * its spec live in `media-player-view.ts`).
 *
 *  - Power orb: glowing when on, amber in standby, flat when off, dashed with a
 *    question mark while the state is unknown (never drawn as off). It is the
 *    power switch when the device declares `MediaPlayerPower`.
 *  - Running line: equalizer while playing, spinner while buffering, pause
 *    glyph when paused; a value the driver only guesses carries an "assumed" mark.
 *  - Only while the device is on: now-playing, seek, transport (previous /
 *    play-pause / stop / next), volume (slider with mute, or steps when the
 *    device has no level reading), the source (a picker when it can switch),
 *    shuffle and repeat. Each appears only when the status fills it or a
 *    `DeviceFeature` declares it — no per-vendor list.
 *
 * Cap-gated on `media-player` — returns null when the device lacks the cap.
 * Motion respects `prefers-reduced-motion`.
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

  const { display, applyOptimisticAction } = useOptimisticSlice<MediaPlayerStatus>(slice, {
    enabled: optimistic ?? true,
  })

  // While the device reports a stamped position the progress advances locally, once a second.
  const ticking = isPositionTicking(display)
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    setNowMs(Date.now())
    const timer = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ticking])

  // A sibling `running-state` cap on the same device (an infrared TV composed with it) can
  // settle the power guess; the running line and the draw are the device page's hero line
  // and the power-meter hero widget (D1004), not this card's.
  const runningSlice = useDeviceState<RunningStateStatus>(trpc, deviceId, (st) => st.runningState)

  if (cap === undefined) return null

  const view = deriveMediaPlayerView(display, features, {
    running: runningSlice?.running,
  })
  const busy = !available
  const status = display
  const powered = status !== undefined && view.power === 'on'
  const action = toggleAction(status?.state ?? 'off')

  const switchPower = (): void => {
    if (busy) return
    if (view.power === 'on') {
      applyOptimisticAction({ state: 'off' }, () => cap.turnOff({}))
    } else {
      applyOptimisticAction({ state: 'on' }, () => cap.turnOn({}))
    }
  }
  const powerLabel = powerLabelOf(view.power, t)

  const handleToggle = (): void => {
    if (busy) return
    if (action === 'play') {
      applyOptimisticAction({ state: 'playing' }, () => cap.play({}))
    } else {
      applyOptimisticAction({ state: 'paused' }, () => cap.pause({}))
    }
  }

  // What plays is shown whenever the device reports it, whatever the power reading says.
  const nowPlaying = view.nowPlaying
  const positionMs = status === undefined ? null : projectedPositionMs(status, nowMs)
  const assumedAny =
    view.stateAssumed || view.volumeAssumed || view.muteAssumed || view.sourceAssumed
  // A source that cannot be switched is plain text on the state line; a picker replaces it.
  const sourcePicker = powered && view.source !== null && view.source.selectable
  const sourceText =
    !sourcePicker && view.power !== 'off' && view.power !== 'standby'
      ? typeof status?.source === 'string'
        ? status.source.trim()
        : ''
      : ''
  const volumeLevel = status?.volumeLevel ?? null

  return (
    <div
      className={cn(
        'flex flex-col items-stretch gap-4 rounded-lg border bg-surface p-6',
        'transition-colors duration-500 motion-reduce:transition-none',
        view.power === 'on' ? 'border-success/40' : 'border-border',
      )}
      data-testid="media-hero"
      data-power={view.power}
    >
      <style>{MEDIA_HERO_KEYFRAMES}</style>

      {/* ── Power + running state ───────────────────────────────────────────── */}
      <div className="flex flex-col items-center gap-2">
        <PowerOrb
          power={view.power}
          label={powerLabel}
          busy={busy}
          onPress={view.canSwitchPower ? switchPower : undefined}
        />
        <StateLine
          state={status?.state}
          assumed={assumedAny}
          source={sourceText}
          running={<RunningIndicator running={view.running} />}
        />
      </div>
      {nowPlaying !== null && <NowPlaying media={nowPlaying} positionMs={positionMs} />}

      {/* ── Source picker ───────────────────────────────────────────────────── */}
      {sourcePicker && view.source !== null && (
        <div data-testid="media-source-select" className="flex items-center gap-2">
          <span className="text-xs text-foreground-subtle">
            {t('uiLibrary.mediaPlayerHero.source', 'Source')}
          </span>
          <Select
            aria-label={t('uiLibrary.mediaPlayerHero.source', 'Source')}
            value={view.source.current}
            disabled={busy}
            wrapperClassName="relative min-w-0 flex-1"
            options={view.source.options.map((o) => ({ value: o, label: o }))}
            onChange={(e) => {
              if (busy) return
              applyOptimisticAction({ source: e.target.value }, () =>
                cap.selectSource({ source: e.target.value }),
              )
            }}
          />
        </div>
      )}

      {/* ── Seek track (only when seekable + duration known) ────────────────── */}
      {powered && view.seek && status !== undefined && (
        <div data-testid="media-seek" className="flex flex-col gap-1">
          <label className="relative block">
            <span className="sr-only">{t('uiLibrary.mediaPlayerHero.seek', 'Seek')}</span>
            <input
              aria-label={t('uiLibrary.mediaPlayerHero.seek', 'Seek')}
              type="range"
              min={0}
              max={status.duration ?? 0}
              step={1000}
              className="absolute inset-0 h-4 w-full cursor-pointer opacity-0"
              value={positionMs ?? 0}
              disabled={busy}
              onChange={(e) => {
                if (busy) return
                const positionMs = Number(e.target.value)
                applyOptimisticAction({ position: positionMs }, () =>
                  cap.seek({ position: positionMs }),
                )
              }}
            />
            <div className="pointer-events-none">
              <GripTrack fraction={progressFraction(positionMs, status.duration)} />
            </div>
          </label>
          <div className="flex justify-between text-[11px] tabular-nums text-foreground-subtle">
            <span>{formatClock(positionMs)}</span>
            <span>{formatClock(status.duration)}</span>
          </div>
        </div>
      )}

      {/* ── Transport: prev / play-pause / stop / next ──────────────────────── */}
      {powered && view.transport.playPause && (
        <div className="flex items-center justify-center gap-4" data-testid="media-transport">
          {view.transport.previous && (
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
          {view.transport.stop && (
            <TransportButton
              label={t('uiLibrary.mediaPlayerHero.stop', 'Stop')}
              busy={busy}
              onPress={() => void cap.stop({})}
            >
              <Square className="h-4 w-4" aria-hidden="true" />
            </TransportButton>
          )}
          {view.transport.next && (
            <TransportButton
              label={t('uiLibrary.mediaPlayerHero.next', 'Next')}
              busy={busy}
              onPress={() => void cap.next({})}
            >
              <SkipForward className="h-5 w-5" aria-hidden="true" />
            </TransportButton>
          )}
        </div>
      )}

      {/* ── Volume: a track + mute when the level is read, steps when it is not ─ */}
      {powered && view.volume === 'slider' && (
        <div data-testid="media-volume" className="flex items-center gap-2">
          {view.mute && (
            // ui-check-ok: round state-toned control (transport key / mute / power orb); no IconButton size
            <button
              type="button"
              aria-label={
                status?.isMuted === true
                  ? t('uiLibrary.mediaPlayerHero.unmute', 'Unmute')
                  : t('uiLibrary.mediaPlayerHero.mute', 'Mute')
              }
              title={
                status?.isMuted === true
                  ? t('uiLibrary.mediaPlayerHero.unmute', 'Unmute')
                  : t('uiLibrary.mediaPlayerHero.mute', 'Mute')
              }
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation()
                if (busy) return
                const muted =
                  status?.isMuted === null || status === undefined ? true : !status.isMuted
                applyOptimisticAction({ isMuted: muted }, () => cap.setMute({ muted }))
              }}
              className={cn(
                'inline-flex h-7 w-7 items-center justify-center rounded text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors',
                busy && 'opacity-40 cursor-not-allowed',
              )}
            >
              {status?.isMuted === true ? (
                <VolumeX className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Volume2 className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          )}
          <label className="relative block flex-1">
            <span className="sr-only">{t('uiLibrary.mediaPlayerHero.volume', 'Volume')}</span>
            <input
              aria-label={t('uiLibrary.mediaPlayerHero.volume', 'Volume')}
              type="range"
              min={0}
              max={100}
              step={1}
              className="absolute inset-0 h-4 w-full cursor-pointer opacity-0"
              value={volumeLevel ?? 0}
              disabled={busy}
              onChange={(e) => {
                if (busy) return
                const next = Number(e.target.value)
                applyOptimisticAction({ volumeLevel: next }, () =>
                  cap.setVolume({ volumeLevel: next }),
                )
              }}
            />
            <div className="pointer-events-none">
              <div
                className={cn(volumeLevel === null && 'opacity-40')}
                data-testid="media-volume-track"
                data-known={volumeLevel !== null}
              >
                <GripTrack
                  fraction={
                    status?.isMuted === true || volumeLevel === null ? 0 : volumeLevel / 100
                  }
                />
              </div>
            </div>
          </label>
          <span className="w-9 text-right text-[11px] tabular-nums text-foreground-subtle">
            {volumeLevel === null ? '—' : `${volumeLevel}%`}
          </span>
        </div>
      )}
      {powered && view.volume === 'steps' && (
        <div
          data-testid="media-volume-steps"
          className="flex items-center justify-center gap-3 text-xs text-foreground-subtle"
        >
          <TransportButton
            label={t('uiLibrary.mediaPlayerHero.volumeDown', 'Volume down')}
            busy={busy}
            onPress={() => void cap.volumeDown({ steps: 1 })}
          >
            <Minus className="h-4 w-4" aria-hidden="true" />
          </TransportButton>
          <Volume2 className="h-4 w-4" aria-hidden="true" />
          <TransportButton
            label={t('uiLibrary.mediaPlayerHero.volumeUp', 'Volume up')}
            busy={busy}
            onPress={() => void cap.volumeUp({ steps: 1 })}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
          </TransportButton>
        </div>
      )}

      {/* ── Shuffle / repeat ────────────────────────────────────────────────── */}
      {status !== undefined &&
        ((powered && (view.shuffle || view.repeat)) ||
          view.shuffleReadOnly ||
          view.repeatReadOnly) && (
          <div className="flex items-center justify-center gap-2" data-testid="media-modes">
            {view.shuffleReadOnly && status.shuffle !== null && (
              <ModeFlag
                label={t('uiLibrary.mediaPlayerHero.shuffle', 'Shuffle')}
                active={status.shuffle}
                testId="media-shuffle-flag"
              >
                <Shuffle className="h-4 w-4" aria-hidden="true" />
              </ModeFlag>
            )}
            {view.repeatReadOnly && status.repeat !== null && (
              <ModeFlag
                label={t('uiLibrary.mediaPlayerHero.repeat', 'Repeat')}
                active={status.repeat !== 'off'}
                testId="media-repeat-flag"
              >
                {status.repeat === 'one' ? (
                  <Repeat1 className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Repeat className="h-4 w-4" aria-hidden="true" />
                )}
              </ModeFlag>
            )}
            {powered && view.shuffle && status.shuffle !== null && (
              <TransportButton
                label={t('uiLibrary.mediaPlayerHero.shuffle', 'Shuffle')}
                busy={busy}
                active={status.shuffle}
                onPress={() => {
                  const shuffle = !status.shuffle
                  applyOptimisticAction({ shuffle }, () => cap.setShuffle({ shuffle }))
                }}
              >
                <Shuffle className="h-4 w-4" aria-hidden="true" />
              </TransportButton>
            )}
            {powered && view.repeat && status.repeat !== null && (
              <TransportButton
                label={t('uiLibrary.mediaPlayerHero.repeat', 'Repeat')}
                busy={busy}
                active={status.repeat !== 'off'}
                onPress={() => {
                  if (status.repeat === null) return
                  const repeat = NEXT_REPEAT[status.repeat]
                  applyOptimisticAction({ repeat }, () => cap.setRepeat({ repeat }))
                }}
              >
                {status.repeat === 'one' ? (
                  <Repeat1 className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Repeat className="h-4 w-4" aria-hidden="true" />
                )}
              </TransportButton>
            )}
          </div>
        )}
    </div>
  )
}

function powerLabelOf(power: PowerView, t: (key: string, english: string) => string): string {
  if (power === 'on') return t('uiLibrary.mediaPlayerHero.turnOff', 'Turn off')
  if (power === 'unknown') return t('uiLibrary.mediaPlayerHero.powerUnknown', 'Power state unknown')
  return t('uiLibrary.mediaPlayerHero.turnOn', 'Turn on')
}
