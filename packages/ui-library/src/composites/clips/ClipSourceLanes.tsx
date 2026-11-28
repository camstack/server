/**
 * One lane per clip SOURCE on a recording timeline — what each place that keeps
 * this camera's clips holds inside the visible window.
 *
 * The sources are the camera's `videoclips.listSources` rows grouped by the
 * provider that answers them (`clipProviderOptions`); none is named here. A
 * lane is the same bar shape as the timeline's own coverage track, so the
 * lanes read as part of it, and a click on a clip hands it to the caller —
 * the surface decides which player plays it.
 *
 * A lane that could not answer says so in its own row; an empty bar is only
 * drawn for a source that answered with nothing.
 */
import type { Clip } from '@dominevo/types'
import type { JSX } from 'react'
import { useVideoclipsListClips } from '../../generated/system-hooks.js'
import { useUiText } from '../../contexts/ui-text.js'
import type { DayWindow } from '../cap-settings/recording-timeline-model.js'
import { planClipBand } from './clip-band.js'
import { clipLaneSpans, type ClipProviderOption } from './clip-source-options.js'
import { describeSource } from './clip-source-state.js'

/** Newest-first, bounded — the clips section's own page size. */
const LANE_CLIP_LIMIT = 500

/** What one lane's query answered. */
export interface ClipLaneClips {
  readonly status: 'refused' | 'pending' | 'error' | 'success'
  readonly clips: readonly Clip[]
  readonly error: string | null
}

const NO_CLIPS: readonly Clip[] = []

/**
 * The clips one provider holds in `view`. One hook for the lane and for any
 * caller that needs the same answer (a player picking the clip at an instant),
 * so both ask the identical question and share one cached read.
 */
export function useClipLaneClips(
  deviceId: number,
  provider: string | null,
  view: DayWindow,
): ClipLaneClips {
  const plan = planClipBand({ fromMs: view.fromMs, toMs: view.toMs })
  const askable = plan.kind === 'askable' && provider !== null
  const query = useVideoclipsListClips(
    {
      deviceId,
      since: view.fromMs,
      until: view.toMs,
      limit: LANE_CLIP_LIMIT,
      provider: provider ?? '',
    },
    { enabled: askable },
  )
  if (!askable) return { status: 'refused', clips: NO_CLIPS, error: null }
  if (query.status === 'pending') return { status: 'pending', clips: NO_CLIPS, error: null }
  if (query.status === 'error') {
    return { status: 'error', clips: NO_CLIPS, error: query.error.message }
  }
  return { status: 'success', clips: query.data, error: null }
}

export interface ClipSourceLaneProps {
  readonly deviceId: number
  readonly option: ClipProviderOption
  readonly view: DayWindow
  /** This lane's source is the one the player plays. */
  readonly selected: boolean
  readonly onPickClip: (provider: string, clip: Clip) => void
}

function ClipSourceLane({
  deviceId,
  option,
  view,
  selected,
  onPickClip,
}: ClipSourceLaneProps): JSX.Element {
  const t = useUiText()
  const lane = useClipLaneClips(deviceId, option.value, view)
  const silent = option.sources
    .map((row) => describeSource(row, t))
    .filter((notice) => !notice.answered)
  const spans = clipLaneSpans(lane.clips, view.fromMs, view.toMs)

  const notice =
    lane.status === 'error'
      ? t('uiLibrary.clipSourceLanes.failed', 'Could not be read — {{reason}}', {
          reason: lane.error ?? '',
        })
      : silent.length > 0 && lane.clips.length === 0
        ? silent.map((n) => n.headline).join(' · ')
        : lane.status === 'refused'
          ? t('uiLibrary.clipSourceLanes.refused', 'This window is too wide to list clips.')
          : null

  // One compact row: the bar spans the full window width so its marks line up
  // with the coverage bar above; the label sits inline at its left edge.
  return (
    <div
      className={`relative h-4 overflow-hidden rounded bg-background/40 ${
        lane.status === 'pending' ? 'animate-pulse' : ''
      }`}
      data-testid={`clip-source-lane-${option.value}`}
    >
      {notice === null &&
        spans.map((span) => (
          <button // ui-check-ok: a positioned span on the lane bar, not a control row
            key={`${span.clip.source}:${span.clip.id}`}
            type="button"
            onClick={() => onPickClip(option.value, span.clip)}
            title={new Date(span.clip.timeRange.startMs).toLocaleTimeString()}
            aria-label={t('uiLibrary.clipSourceLanes.playClip', 'Play clip at {{time}}', {
              time: new Date(span.clip.timeRange.startMs).toLocaleTimeString(),
            })}
            className={`absolute top-0.5 h-3 rounded-sm ${
              selected
                ? 'bg-primary/70 hover:bg-primary'
                : 'bg-foreground-subtle/50 hover:bg-foreground-subtle/80'
            }`}
            // ui-check-ok: computed geometry — the clip's place on the window
            style={{
              left: `${String(span.leftPct)}%`,
              width: `${String(span.widthPct)}%`,
            }}
          />
        ))}
      <span
        className={`pointer-events-none absolute inset-y-0 left-0 flex max-w-full items-center gap-1.5 rounded-r bg-surface/80 px-1.5 text-[10px] leading-none ${
          selected ? 'text-primary' : 'text-foreground-subtle'
        }`}
      >
        <span className="truncate font-semibold uppercase tracking-wider">{option.label}</span>
        {lane.status === 'success' && notice === null ? (
          <span className="shrink-0 tabular-nums">
            {t(
              'uiLibrary.clipSourceLanes.count',
              { one: '{{count}} clip', other: '{{count}} clips' },
              { count: lane.clips.length },
            )}
          </span>
        ) : null}
        {notice !== null ? (
          <span
            className={`truncate ${lane.status === 'refused' ? '' : 'text-warning'}`}
            title={notice}
          >
            {notice}
          </span>
        ) : null}
      </span>
    </div>
  )
}

export interface ClipSourceLanesProps {
  readonly deviceId: number
  readonly options: readonly ClipProviderOption[]
  readonly view: DayWindow
  /** The provider the player plays, or null. */
  readonly selectedProvider: string | null
  readonly onPickClip: (provider: string, clip: Clip) => void
}

/** Every provider's lane, in the order the camera listed its sources. */
export function ClipSourceLanes({
  deviceId,
  options,
  view,
  selectedProvider,
  onPickClip,
}: ClipSourceLanesProps): JSX.Element | null {
  if (options.length === 0) return null
  return (
    <div className="space-y-1" data-testid="clip-source-lanes">
      {options.map((option) => (
        <ClipSourceLane
          key={option.value}
          deviceId={deviceId}
          option={option}
          view={view}
          selected={option.value === selectedProvider}
          onPickClip={onPickClip}
        />
      ))}
    </div>
  )
}
