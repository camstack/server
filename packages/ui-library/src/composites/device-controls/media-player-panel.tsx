import { Select } from '../../primitives/select'
import { useUiText, type UiTextFn } from '../../contexts/ui-text'
import type { ReactNode } from 'react'
import { Pause, Play } from 'lucide-react'
import { useDeviceCapability } from '../../hooks/use-device-capability.js'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice.js'
import { deriveMediaPlayerView } from '@camstack/types'
import { cn } from '../../lib/cn.js'
import type { ControlPanelProps } from './types.js'
import type { MediaPlayerStatus, MediaPlayerState, MediaPlayerRepeat } from '@camstack/types'

/**
 * Exhaustive colour map — one entry per MediaPlayerState.
 * Build fails if a state is added and not reflected here.
 */
export const STATE_COLOR: Record<MediaPlayerState, string> = {
  playing: 'border-success/50 bg-success/10',
  paused: 'border-warning/50 bg-warning/10',
  buffering: 'border-info/50 bg-info/10',
  on: 'border-foreground-subtle/40 bg-surface-hover',
  idle: 'border-foreground-subtle/40 bg-surface-hover',
  off: 'border-border bg-surface',
  standby: 'border-border bg-surface',
} satisfies Record<MediaPlayerState, string>

/** Dot indicator colour (small circle) per state. */
const STATE_DOT_COLOR: Record<MediaPlayerState, string> = {
  playing: 'bg-success',
  paused: 'bg-warning',
  buffering: 'bg-info',
  on: 'bg-foreground-subtle',
  idle: 'bg-foreground-subtle',
  off: 'bg-border',
  standby: 'bg-border',
} satisfies Record<MediaPlayerState, string>

/** Exhaustive tuple of valid repeat values — single source of truth. */
const REPEAT_VALUES = ['off', 'all', 'one'] as const satisfies readonly MediaPlayerRepeat[]

function isRepeat(v: string): v is MediaPlayerRepeat {
  return (REPEAT_VALUES as readonly string[]).includes(v)
}

/** Repeat mode display labels. */
function repeatLabel(t: UiTextFn, repeat: MediaPlayerRepeat): string {
  switch (repeat) {
    case 'off':
      return t('uiLibrary.mediaPlayerPanel.repeatOff', 'Off')
    case 'all':
      return t('uiLibrary.mediaPlayerPanel.repeatAll', 'All')
    case 'one':
      return t('uiLibrary.mediaPlayerPanel.repeatOne', 'One')
  }
}

/** Which states map to play() vs pause() on the toggle button. */
function toggleAction(state: MediaPlayerState): 'play' | 'pause' {
  if (state === 'playing' || state === 'buffering') return 'pause'
  return 'play'
}

export function MediaPlayerPanel({
  trpc,
  deviceId,
  features,
  layout,
  optimistic,
}: ControlPanelProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.mediaPlayer,
    slice: (d) => d.state.mediaPlayer,
  })

  const { display, applyOptimisticAction } = useOptimisticSlice<MediaPlayerStatus>(slice, {
    enabled: optimistic ?? true,
  })

  if (display === undefined) return null
  const declared = deriveMediaPlayerView(display, features, {})

  const busy = !available
  const action = toggleAction(display.state)

  return (
    <div
      data-state={display.state}
      className={cn(
        'inline-flex items-center gap-2 rounded border px-2 py-1 transition-colors',
        STATE_COLOR[display.state],
        layout === 'full' && 'flex-col items-stretch gap-3',
      )}
    >
      {/* ── State indicator + primary toggle ──────────────────────────── */}
      <div className="inline-flex items-center gap-2">
        {/* State dot indicator */}
        <span
          role="status"
          aria-label={display.state}
          className={cn(
            'inline-block h-2 w-2 rounded-full flex-shrink-0',
            STATE_DOT_COLOR[display.state],
          )}
        />

        {/* Play/Pause toggle */}
        <button // ui-check-ok: compact inline control; no library size at this density
          type="button"
          aria-label={
            action === 'play'
              ? t('uiLibrary.mediaPlayerPanel.play', 'Play')
              : t('uiLibrary.mediaPlayerPanel.pause', 'Pause')
          }
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation()
            if (busy) return
            if (action === 'play') {
              applyOptimisticAction({ state: 'playing' }, () => cap?.play({}))
            } else {
              applyOptimisticAction({ state: 'paused' }, () => cap?.pause({}))
            }
          }}
          className={cn(
            'inline-flex h-5 w-5 items-center justify-center rounded text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors text-xs',
            busy && 'opacity-40 cursor-not-allowed',
          )}
        >
          {action === 'play' ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
        </button>
      </div>

      {/* ── Full-layout extras ──────────────────────────────────────────── */}
      {layout === 'full' && (
        <>
          {/* Transport controls: previous / next */}
          <div className="inline-flex items-center gap-1">
            <button // ui-check-ok: compact inline control; no library size at this density
              type="button"
              aria-label={t('uiLibrary.mediaPlayerPanel.previous', 'Previous')}
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation()
                if (!busy) void cap?.previous({})
              }}
              className={cn(
                'inline-flex h-5 w-5 items-center justify-center rounded text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors text-xs',
                busy && 'opacity-40 cursor-not-allowed',
              )}
            >
              ⏮
            </button>
            <button // ui-check-ok: compact inline control; no library size at this density
              type="button"
              aria-label={t('uiLibrary.mediaPlayerPanel.next', 'Next')}
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation()
                if (!busy) void cap?.next({})
              }}
              className={cn(
                'inline-flex h-5 w-5 items-center justify-center rounded text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors text-xs',
                busy && 'opacity-40 cursor-not-allowed',
              )}
            >
              ⏭
            </button>
          </div>

          {/* Volume slider */}
          {(declared.volume === 'slider' || display.volumeLevel !== null) && (
            <label className="flex items-center gap-2 text-xs text-foreground-subtle">
              <span>{t('uiLibrary.mediaPlayerPanel.vol', 'Vol')}</span>
              <input
                aria-label={t('uiLibrary.mediaPlayerPanel.volume', 'Volume')}
                type="range"
                min={0}
                max={100}
                step={1}
                value={display.volumeLevel ?? 0}
                disabled={busy}
                onChange={(e) => {
                  const volumeLevel = Number(e.target.value)
                  if (!busy)
                    applyOptimisticAction({ volumeLevel }, () => cap?.setVolume({ volumeLevel }))
                }}
              />
              <span className="tabular-nums w-8 text-right">
                {display.volumeLevel === null ? '—' : `${display.volumeLevel}%`}
              </span>
            </label>
          )}

          {/* Mute toggle */}
          {(declared.mute || display.isMuted !== null) && (
            <button // ui-check-ok: compact inline control; no library size at this density
              type="button"
              aria-label={
                display.isMuted
                  ? t('uiLibrary.mediaPlayerPanel.unmute', 'Unmute')
                  : t('uiLibrary.mediaPlayerPanel.mute', 'Mute')
              }
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation()
                if (!busy) {
                  const muted = display.isMuted === null ? true : !display.isMuted
                  applyOptimisticAction({ isMuted: muted }, () => cap?.setMute({ muted }))
                }
              }}
              className={cn(
                'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors',
                display.isMuted
                  ? 'bg-warning-fill text-warning-on'
                  : 'text-foreground-subtle hover:text-foreground hover:bg-surface-hover',
                busy && 'opacity-40 cursor-not-allowed',
              )}
            >
              {display.isMuted ? '🔇' : '🔊'}
            </button>
          )}

          {/* Source select */}
          {display.availableSources.length > 0 && (
            <label className="flex items-center gap-2 text-xs text-foreground-subtle">
              <span>{t('uiLibrary.mediaPlayerPanel.source', 'Source')}</span>
              <Select // ui-check-ok: compact inline control; no library size at this density
                aria-label={t('uiLibrary.mediaPlayerPanel.source', 'Source')}
                value={display.source}
                disabled={busy}
                onChange={(e) => {
                  const source = e.target.value
                  if (!busy && source) {
                    applyOptimisticAction({ source }, () => cap?.selectSource({ source }))
                  }
                }}
                className="rounded border border-border bg-surface px-1 py-0.5"
              >
                <option value="" disabled>
                  —
                </option>
                {display.availableSources.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </label>
          )}

          {/* Shuffle toggle */}
          {display.shuffle !== null && (
            <button // ui-check-ok: compact inline control; no library size at this density
              type="button"
              aria-label={t('uiLibrary.mediaPlayerPanel.shuffle', 'Shuffle')}
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation()
                if (!busy && display.shuffle !== null) {
                  const shuffle = !display.shuffle
                  applyOptimisticAction({ shuffle }, () => cap?.setShuffle({ shuffle }))
                }
              }}
              className={cn(
                'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors',
                display.shuffle
                  ? 'bg-success-fill text-success-on'
                  : 'text-foreground-subtle hover:text-foreground hover:bg-surface-hover',
                busy && 'opacity-40 cursor-not-allowed',
              )}
            >
              ⇌ {t('uiLibrary.mediaPlayerPanel.shuffle', 'Shuffle')}
            </button>
          )}

          {/* Repeat mode selector */}
          {display.repeat !== null && (
            <label className="flex items-center gap-2 text-xs text-foreground-subtle">
              <span>{t('uiLibrary.mediaPlayerPanel.repeat', 'Repeat')}</span>
              <Select // ui-check-ok: compact inline control; no library size at this density
                aria-label={t('uiLibrary.mediaPlayerPanel.repeat', 'Repeat')}
                value={display.repeat}
                disabled={busy}
                onChange={(e) => {
                  const v = e.target.value
                  if (!busy && isRepeat(v)) {
                    applyOptimisticAction({ repeat: v }, () => cap?.setRepeat({ repeat: v }))
                  }
                }}
                className="rounded border border-border bg-surface px-1 py-0.5"
              >
                {REPEAT_VALUES.map((r) => (
                  <option key={r} value={r}>
                    {repeatLabel(t, r)}
                  </option>
                ))}
              </Select>
            </label>
          )}
        </>
      )}
    </div>
  )
}
