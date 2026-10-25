/**
 * One clip, as a tile.
 *
 * The picture is resolved by `resolveTileMedia` — vouched JPEG, an offer, or
 * the reason there is none (D549 decision 5). An offer is fetched rather than
 * dropped into an `<img src>`, because the route's **204 + x-camstack-reason**
 * is invisible to an `<img>`: it fires `onerror` with nothing to say. The
 * refusal is LATCHED for the life of the tile and never retried behind the
 * operator's back.
 *
 * The row also carries what the camera itself said: its native types, the
 * behaviours beside the class, which storages hold it, and — for a row that
 * is an EVENT sitting inside no file — `playable: false` with its reason
 * (measured: 1 of 29 hub events on 3628). Such a row is SHOWN, never dropped
 * and never offered as playable-then-failing (D549 decision 19).
 *
 * The CHROME is the library's: a `Card` for the tile, `Badge` for every label
 * the camera gave it, `Skeleton` while a mint is in flight. Only the ladder
 * above is this file's own, because only it is a decision.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useUiText } from '../../contexts/ui-text.js'
import { hubPath } from '../../lib/hub-mount.js'
import type { Clip } from '@camstack/types'
import { Badge } from '../../primitives/badge.js'
import { Card } from '../../primitives/card.js'
import { Skeleton } from '../../primitives/skeleton.js'
import { formatDurationMs } from '../../lib/format-duration.js'
import { resolveTileMedia, type ClipTileMedia } from './clip-tile-media.js'
import { fetchMintedThumbnail } from './clip-thumbnail-fetch.js'
import { planStillRetry } from './clip-still-retry.js'

function clockOf(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/**
 * Ask a mint route, and come back only for the answers that say to.
 *
 * The offer is memoised on the three fields it is derived from, not rebuilt
 * per render: `resolveTileMedia` returns a fresh object every call, and an
 * effect keyed on that object re-runs on every commit — which, because the
 * effect sets state, is an infinite render loop. It was one here, and it hung
 * the suite rather than failing it.
 *
 * A FINAL refusal is latched for the life of the tile: a camera that just said
 * "asleep" is not asked again behind the operator's back. A DEFERRED one is
 * not a refusal at all — the still is queued — so the tile keeps showing
 * loading and re-asks on `planStillRetry`'s bounded, jittered schedule. When
 * that budget runs out the deferred answer becomes what the tile SAYS, so the
 * end state is words, never a blank box and never another request (D563).
 */
function useMintedStill(clip: Clip): ClipTileMedia {
  const t = useUiText()
  // The effect below must not re-run (and re-ask the camera) when the host hands
  // a new translator, so it reads the latest one through a ref.
  const tRef = useRef(t)
  tRef.current = t
  const offered = useMemo(
    () => resolveTileMedia(clip, t),
    [clip.thumbnail, clip.thumbnailMint, clip.thumbnailUnavailable?.reason, t],
  )
  const [latched, setLatched] = useState<ClipTileMedia | null>(null)
  const mintUrl = offered.kind === 'mint' ? offered.url : null

  useEffect(() => {
    setLatched(null)
    if (mintUrl === null || typeof fetch !== 'function') return undefined
    let objectUrl: string | null = null
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const ask = async (attempt: number): Promise<void> => {
      const answer = await fetchMintedThumbnail(hubPath(mintUrl), fetch, tRef.current)
      if (cancelled) return
      if (answer.kind === 'image') {
        objectUrl = URL.createObjectURL(answer.blob)
        setLatched({ kind: 'vouched', url: objectUrl })
        return
      }
      if (answer.kind !== 'deferred') {
        setLatched(answer)
        return
      }
      const plan = planStillRetry({
        attempt,
        serverHintMs: answer.retryAfterMs,
        random: Math.random,
      })
      if (plan === null) {
        // The budget is spent. The tile stops asking and starts SAYING.
        setLatched({ kind: 'unavailable', reason: answer.reason, text: answer.text })
        return
      }
      timer = setTimeout(() => {
        void ask(attempt + 1)
      }, plan.waitMs)
    }

    void ask(0)
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [mintUrl])

  return latched ?? offered
}

export interface ClipTileProps {
  readonly clip: Clip
  readonly selected: boolean
  readonly onSelect: (clip: Clip) => void
}

export function ClipTile({ clip, selected, onSelect }: ClipTileProps): JSX.Element {
  const t = useUiText()
  const media = useMintedStill(clip)
  const playable = clip.playable !== false
  const labels = [...(clip.labels ?? []), ...(clip.behaviours ?? [])]

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(clip)}
        disabled={!playable}
        aria-current={selected ? 'true' : undefined}
        className="block w-full text-left disabled:cursor-not-allowed"
      >
        <Card
          className={`flex gap-3 transition-colors ${selected ? 'border-primary' : ''} ${
            playable ? 'hover:bg-surface-hover' : 'opacity-70'
          }`}
        >
          <div className="flex h-16 w-28 shrink-0 items-center justify-center overflow-hidden rounded bg-surface-hover text-[10px] text-foreground-subtle">
            {media.kind === 'vouched' ? (
              <img src={media.url} alt="" className="h-full w-full object-cover" />
            ) : media.kind === 'mint' || media.kind === 'deferred' ? (
              // Loading, with a NAME: a bare skeleton is indistinguishable
              // from a tile nobody looked at, and a deferred still is the
              // majority answer on a first paint (43 of 60, measured on 592).
              <span
                role="status"
                aria-label={
                  media.kind === 'mint'
                    ? t('uiLibrary.clipTile.loadingStill', 'Loading the still')
                    : media.text
                }
                className="h-full w-full"
              >
                <Skeleton className="h-full w-full rounded-none" />
              </span>
            ) : (
              <span className="px-1 text-center leading-tight">{media.text}</span>
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-medium text-foreground">
                {clockOf(clip.timeRange.startMs)}
              </span>
              {/* The length was on every row all along. An in-progress clip
                  has no length to give: its `endMs` is a frozen index entry,
                  not an end (D563). */}
              <span className="text-[11px] text-foreground-subtle">
                {clip.inProgress === true
                  ? t('uiLibrary.clipTile.recording', 'Recording…')
                  : formatDurationMs(clip.timeRange.endMs - clip.timeRange.startMs)}
              </span>
            </div>
            <div className="text-[10px] text-foreground-subtle">{clip.source}</div>
            {labels.length === 0 && clip.nativeTypes === undefined ? null : (
              <div className="flex flex-wrap gap-1">
                {labels.map((label) => (
                  <Badge key={`label:${label}`} variant="info">
                    {label}
                  </Badge>
                ))}
                {(clip.nativeTypes ?? []).map((native) => (
                  <Badge key={`native:${native}`} style="outline">
                    {native}
                  </Badge>
                ))}
              </div>
            )}
            {playable ? null : (
              <div className="text-[11px] text-warning">
                {t('uiLibrary.clipTile.notPlayable', 'Not playable — {{reason}}', {
                  reason:
                    clip.unplayableReason ??
                    t('uiLibrary.clipTile.noReason', 'the source gave no reason'),
                })}
              </div>
            )}
          </div>
        </Card>
      </button>
    </li>
  )
}
