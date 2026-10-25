import { useUiText, type UiTextFn } from '../../contexts/ui-text'
import type { ReactNode } from 'react'
import { useDeviceCapability } from '../../hooks/use-device-capability.js'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice.js'
import { cn } from '../../lib/cn.js'
import type { ControlPanelProps } from './types.js'
import type { MediaPlayerStatus, MediaPlayerState, MediaPlayerRepeat } from '@camstack/types'

/**
 * Exhaustive colour map — one entry per MediaPlayerState.
 * Build fails if a state is added and not reflected here.
 */
export const STATE_COLOR: Record<MediaPlayerState, string> = {
  playing: 'border-green-400 bg-green-50 dark:bg-green-950',
  paused: 'border-amber-400 bg-amber-50 dark:bg-amber-950',
  buffering: 'border-blue-400 bg-blue-50 dark:bg-blue-950',
  on: 'border-slate-400 bg-slate-50 dark:bg-slate-950',
  idle: 'border-slate-400 bg-slate-50 dark:bg-slate-950',
  off: 'border-zinc-300 bg-zinc-50 dark:bg-zinc-900',
  standby: 'border-zinc-300 bg-zinc-50 dark:bg-zinc-900',
} satisfies Record<MediaPlayerState, string>

/** Dot indicator colour (small circle) per state. */
const STATE_DOT_COLOR: Record<MediaPlayerState, string> = {
  playing: 'bg-green-500',
  paused: 'bg-amber-400',
  buffering: 'bg-blue-400',
  on: 'bg-slate-400',
  idle: 'bg-slate-400',
  off: 'bg-zinc-300',
  standby: 'bg-zinc-300',
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
  features: _features,
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

  const { display, applyOptimistic } = useOptimisticSlice<MediaPlayerStatus>(slice, {
    enabled: optimistic ?? true,
  })

  if (display === undefined) return null

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
        <button
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
              applyOptimistic({ state: 'playing' })
              void cap?.play({})
            } else {
              applyOptimistic({ state: 'paused' })
              void cap?.pause({})
            }
          }}
          className={cn(
            'inline-flex h-5 w-5 items-center justify-center rounded text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors text-xs',
            busy && 'opacity-40 cursor-not-allowed',
          )}
        >
          {action === 'play' ? '▶' : '⏸'}
        </button>
      </div>

      {/* ── Full-layout extras ──────────────────────────────────────────── */}
      {layout === 'full' && (
        <>
          {/* Transport controls: previous / next */}
          <div className="inline-flex items-center gap-1">
            <button
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
            <button
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
          {display.volumeLevel !== null && (
            <label className="flex items-center gap-2 text-xs text-foreground-subtle">
              <span>{t('uiLibrary.mediaPlayerPanel.vol', 'Vol')}</span>
              <input
                aria-label={t('uiLibrary.mediaPlayerPanel.volume', 'Volume')}
                type="range"
                min={0}
                max={100}
                step={1}
                value={display.volumeLevel}
                disabled={busy}
                onChange={(e) => {
                  const volumeLevel = Number(e.target.value)
                  applyOptimistic({ volumeLevel })
                  if (!busy) void cap?.setVolume({ volumeLevel })
                }}
              />
              <span className="tabular-nums w-8 text-right">{display.volumeLevel}%</span>
            </label>
          )}

          {/* Mute toggle */}
          {display.isMuted !== null && (
            <button
              type="button"
              aria-label={
                display.isMuted
                  ? t('uiLibrary.mediaPlayerPanel.unmute', 'Unmute')
                  : t('uiLibrary.mediaPlayerPanel.mute', 'Mute')
              }
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation()
                if (!busy && display.isMuted !== null) {
                  const muted = !display.isMuted
                  applyOptimistic({ isMuted: muted })
                  void cap?.setMute({ muted })
                }
              }}
              className={cn(
                'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors',
                display.isMuted
                  ? 'bg-amber-400 text-amber-950'
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
              <select
                aria-label={t('uiLibrary.mediaPlayerPanel.source', 'Source')}
                value={display.source}
                disabled={busy}
                onChange={(e) => {
                  const source = e.target.value
                  if (!busy && source) {
                    applyOptimistic({ source })
                    void cap?.selectSource({ source })
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
              </select>
            </label>
          )}

          {/* Shuffle toggle */}
          {display.shuffle !== null && (
            <button
              type="button"
              aria-label={t('uiLibrary.mediaPlayerPanel.shuffle', 'Shuffle')}
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation()
                if (!busy && display.shuffle !== null) {
                  const shuffle = !display.shuffle
                  applyOptimistic({ shuffle })
                  void cap?.setShuffle({ shuffle })
                }
              }}
              className={cn(
                'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors',
                display.shuffle
                  ? 'bg-green-400 text-green-950'
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
              <select
                aria-label={t('uiLibrary.mediaPlayerPanel.repeat', 'Repeat')}
                value={display.repeat}
                disabled={busy}
                onChange={(e) => {
                  const v = e.target.value
                  if (!busy && isRepeat(v)) {
                    applyOptimistic({ repeat: v })
                    void cap?.setRepeat({ repeat: v })
                  }
                }}
                className="rounded border border-border bg-surface px-1 py-0.5"
              >
                {REPEAT_VALUES.map((r) => (
                  <option key={r} value={r}>
                    {repeatLabel(t, r)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
    </div>
  )
}
