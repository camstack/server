/**
 * The tape review view for Events → Debug → Tracking tapes (D681), split out
 * of `EventsDebugTapes.tsx` (Task 24 fix round 1 — kept that file near the
 * 400-line guideline). One lane per live track; writes ground truth through
 * the SAME `debug.gt.*` body the viewer's cap methods use.
 *
 * Surfaces `GtMarks.truncated` (fix round 1, D315/D393): a marks read that
 * hit its `limit` says so on screen — `truncatedMarksNotice` — rather than
 * silently showing fewer badges than the window actually has.
 */
import { Badge, Button, ErrorBox, Input, Checkbox } from '@camstack/ui-library'
import { useQuery } from '@tanstack/react-query'
import { type JSX, useState } from 'react'
import { mediaOwnerPath, useAuthedImage } from '../lib/authed-media'
import { formatDuration } from './events-debug.helpers'
import {
  type ActionInput,
  type CallAction,
  differentSubjectPairs,
  errorText,
  GT_ACTIONS,
  GT_MARGIN_MS,
  laneMarks,
  parseGtMarks,
  parseTapeTracks,
  sameSubjectPairs,
  TAPE_ACTIONS,
  type TapeLaneItem,
  type TrackPair,
  truncatedMarksNotice,
  UNREADABLE,
} from './events-debug-tapes.helpers'
import { useTranslation } from 'react-i18next'

export interface TapeReviewProps {
  readonly tapeId: string
  readonly call: CallAction
  readonly onClose: () => void
  readonly onChanged: () => void
}

export function TapeReview({ tapeId, call, onClose, onChanged }: TapeReviewProps): JSX.Element {
  const { t } = useTranslation()
  const tracks = useQuery({
    queryKey: ['events-debug', 'tapes', 'tracks', tapeId],
    queryFn: async () => parseTapeTracks(await call(TAPE_ACTIONS.tracks, { tapeId })),
  })
  const tape = tracks.data ?? null
  const marks = useQuery({
    queryKey: ['events-debug', 'tapes', 'marks', tapeId],
    enabled: tape !== null,
    queryFn: async () =>
      tape === null
        ? null
        : parseGtMarks(
            await call(GT_ACTIONS.list, {
              deviceId: tape.deviceId,
              since: tape.fromMs - GT_MARGIN_MS,
              until: tape.toMs + GT_MARGIN_MS,
              limit: 5_000,
            }),
          ),
  })
  const [selected, setSelected] = useState<readonly string[]>([])
  const [switchSec, setSwitchSec] = useState('')
  const [error, setError] = useState<string | null>(null)

  const toggle = (trackId: string): void =>
    setSelected((prev) =>
      prev.includes(trackId) ? prev.filter((t) => t !== trackId) : [...prev, trackId],
    )

  const write = async (writes: readonly (readonly [string, ActionInput])[]): Promise<void> => {
    setError(null)
    try {
      for (const [action, input] of writes) await call(action, input)
      setSelected([])
      await marks.refetch()
      onChanged()
    } catch (err: unknown) {
      setError(errorText(err))
    }
  }

  if (tape === null) {
    if (tracks.isLoading)
      return (
        <p className="text-xs">{t('eventsDebugTapesReview.loadingTheTape', 'Loading the tape…')}</p>
      )
    return <ErrorBox message={UNREADABLE} />
  }
  const deviceId = tape.deviceId
  const relate = (pairs: readonly TrackPair[], relation: 'same-subject' | 'different-subjects') =>
    write(pairs.map((p) => [GT_ACTIONS.setRelation, { deviceId, ...p, relation }] as const))
  const purity = (value: 'mixed' | 'not-a-subject') => {
    const seconds = Number.parseFloat(switchSec)
    const switchAtMs =
      value === 'mixed' && Number.isFinite(seconds) ? tape.fromMs + seconds * 1_000 : undefined
    return write(
      selected.map(
        (trackId) =>
          [
            GT_ACTIONS.setPurity,
            {
              deviceId,
              trackId,
              purity: value,
              ...(switchAtMs !== undefined ? { switchAtMs: Math.round(switchAtMs) } : {}),
            },
          ] as const,
      ),
    )
  }
  const truncatedNotice = marks.data == null ? null : truncatedMarksNotice(marks.data)

  return (
    <div className="space-y-2 rounded-md border border-primary/40 px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium">
          {t('eventsDebugTapes.reviewLanes', { id: tape.tapeId, count: tape.lanes.length })}
        </span>
        <Button
          disabled={selected.length < 2}
          onClick={() => void relate(sameSubjectPairs(selected), 'same-subject')}
        >
          {t('eventsDebugTapesReview.sameSubject', 'Same subject')}
        </Button>
        <Button
          variant="secondary"
          disabled={selected.length < 2}
          onClick={() => void relate(differentSubjectPairs(selected), 'different-subjects')}
        >
          {t('eventsDebugTapesReview.differentSubjects', 'Different subjects')}
        </Button>
        <Input
          aria-label={t(
            'eventsDebugTapesReview.changedAtSFromTape',
            'Changed at (s from tape start)',
          )}
          placeholder={t('eventsDebugTapesReview.changedAtS', 'changed at s')}
          value={switchSec}
          onChange={(e) => setSwitchSec(e.target.value)}
          className="w-28"
        />
        <Button
          variant="secondary"
          disabled={selected.length !== 1}
          onClick={() => void purity('mixed')}
        >
          {t('eventsDebugTapesReview.mixed', 'Mixed')}
        </Button>
        <Button
          variant="secondary"
          disabled={selected.length === 0}
          onClick={() => void purity('not-a-subject')}
        >
          {t('eventsDebugTapesReview.notASubject', 'Not a subject')}
        </Button>
        <Button
          variant={tape.reviewed ? 'secondary' : 'primary'}
          onClick={() =>
            void write([
              [TAPE_ACTIONS.review, { tapeId: tape.tapeId, reviewed: !tape.reviewed }],
            ]).then(() => tracks.refetch())
          }
        >
          {tape.reviewed
            ? t('eventsDebugTapesReview.markNotReviewed', 'Mark not reviewed')
            : t('eventsDebugTapesReview.markReviewed', 'Mark reviewed')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('common.close', 'Close')}
        </Button>
      </div>
      {error !== null && <ErrorBox message={error} />}
      {truncatedNotice !== null && <ErrorBox variant="warning" message={truncatedNotice} />}
      <ul className="space-y-1">
        {tape.lanes
          .toSorted((a, b) => a.firstT - b.firstT)
          .map((lane) => (
            <LaneRow
              key={lane.trackId}
              lane={lane}
              marks={
                marks.data === null || marks.data === undefined
                  ? []
                  : laneMarks(lane.trackId, marks.data)
              }
              selected={selected.includes(lane.trackId)}
              onToggle={() => toggle(lane.trackId)}
            />
          ))}
      </ul>
    </div>
  )
}

interface LaneRowProps {
  readonly lane: TapeLaneItem
  readonly marks: readonly string[]
  readonly selected: boolean
  readonly onToggle: () => void
}

function LaneRow({ lane, marks, selected, onToggle }: LaneRowProps): JSX.Element {
  const { t } = useTranslation()
  const { src } = useAuthedImage(
    lane.stillStored ? mediaOwnerPath('track', lane.trackId) : undefined,
  )
  return (
    <li className="flex items-center gap-2 text-xs">
      <Checkbox
        aria-label={t('eventsDebugTapesReview.select', 'select {{trackId}}', {
          trackId: lane.trackId,
        })}
        checked={selected}
        onChange={onToggle}
      />
      {src !== null ? (
        <img src={src} alt={lane.trackId} className="h-10 w-10 rounded object-cover" />
      ) : (
        <div className="h-10 w-10 rounded bg-surface-hover" />
      )}
      <span className="font-mono">{lane.trackId}</span>
      <span>{lane.cls}</span>
      <span className="text-foreground-subtle">
        {t('eventsDebugTapes.laneFrames', {
          range: `${formatDuration(lane.firstT)} → ${formatDuration(lane.lastT)}`,
          count: lane.boundFrames,
        })}
      </span>
      {!lane.stillStored && (
        <span className="text-foreground-subtle">
          {t(
            'eventsDebugTapesReview.notStoredMarkedThroughThe',
            'not stored — marked through the tape',
          )}
        </span>
      )}
      {marks.map((m) => (
        <Badge key={m} variant="info">
          {m}
        </Badge>
      ))}
    </li>
  )
}
