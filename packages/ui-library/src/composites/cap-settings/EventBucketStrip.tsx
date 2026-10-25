import { Loader2, Play } from 'lucide-react'
import { EventThumb, EventKindIcon, type ClipKind } from './event-thumb'
import { type JSX } from 'react'
import { useUiText } from '../../contexts/ui-text'

export interface BucketClip {
  readonly id: string
  readonly timestamp: number
  readonly kind: ClipKind
  readonly label: string
  readonly mediaUrl?: string
}

/** All recognized clip kinds, in display order. */
const KIND_ORDER: readonly ClipKind[] = ['motion', 'object', 'audio']

interface EventBucketStripProps {
  readonly clips: readonly BucketClip[]
  readonly loading: boolean
  /** Key of the clip whose manifest is resolving, for the spinner. */
  readonly busyKey: string | null
  readonly onPlay: (clip: BucketClip) => void
  /** Which kinds are currently enabled for display. */
  readonly enabledKinds: ReadonlySet<ClipKind>
  /** Called when the user toggles a kind checkbox. */
  readonly onToggleKind: (kind: ClipKind) => void
  /** True when more results may exist beyond the current page. */
  readonly hasMore: boolean
  /** Called when the user clicks "Load more". */
  readonly onLoadMore: () => void
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

// Drill-down strip: thumbnails for the events inside the selected heatmap
// bucket. Reuses the shared EventThumb. Click a thumb to play that clip.
export function EventBucketStrip({
  clips,
  loading,
  busyKey,
  onPlay,
  enabledKinds,
  onToggleKind,
  hasMore,
  onLoadMore,
}: EventBucketStripProps): JSX.Element {
  const t = useUiText()
  const kindFilterRow = (
    <div className="flex items-center gap-3 pb-1">
      {KIND_ORDER.map((kind) => (
        <label
          key={kind}
          className="flex cursor-pointer items-center gap-1 text-xs text-foreground-subtle select-none"
        >
          <input
            type="checkbox"
            checked={enabledKinds.has(kind)}
            onChange={() => onToggleKind(kind)}
            className="h-3.5 w-3.5 accent-primary"
          />
          {kind}
        </label>
      ))}
    </div>
  )

  if (loading && clips.length === 0) {
    return (
      <div className="space-y-2">
        {kindFilterRow}
        <div className="px-1 py-2 text-xs text-foreground-subtle">
          {t('uiLibrary.eventBucketStrip.loading', 'Loading events…')}
        </div>
      </div>
    )
  }
  if (clips.length === 0) {
    return (
      <div className="space-y-2">
        {kindFilterRow}
        <div className="px-1 py-2 text-xs text-foreground-subtle">
          {t('uiLibrary.eventBucketStrip.empty', 'No events in this window.')}
        </div>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {kindFilterRow}
      {loading ? (
        <div className="px-1 text-[10px] text-foreground-subtle">
          {t('uiLibrary.eventBucketStrip.loading', 'Loading events…')}
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {clips.map((clip) => {
          // A busy/React key only — never parsed as a media-owner key (the
          // thumbnail comes from `clip.mediaUrl`, stamped server-side). Still
          // prefixed with the clip's OWN kind (D476: `motion`/`object`/`audio`
          // ids are no longer unique across kinds) so two clips of different
          // kinds sharing a numeric id can never share a busy-key or a React
          // key.
          const key = `${clip.kind}:${clip.id}`
          return (
            <button
              key={key}
              type="button"
              disabled={busyKey !== null}
              onClick={() => onPlay(clip)}
              className="group overflow-hidden rounded-lg border border-border text-left transition-colors hover:border-primary disabled:opacity-60"
            >
              <div className="relative aspect-video bg-black/90">
                <EventThumb mediaUrl={clip.mediaUrl} kind={clip.kind} />
                <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/30">
                  {busyKey === key ? (
                    <Loader2 className="h-6 w-6 animate-spin text-white" />
                  ) : (
                    <Play className="h-6 w-6 text-white opacity-0 transition-opacity group-hover:opacity-100" />
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1.5 bg-surface px-2 py-1.5">
                <EventKindIcon kind={clip.kind} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground">{clip.label}</div>
                  <div className="text-[10px] text-foreground-subtle">
                    {formatTime(clip.timestamp)}
                  </div>
                </div>
              </div>
            </button>
          )
        })}
      </div>
      {clips.length > 0 ? (
        <div className="flex items-center gap-2 pt-1 text-[11px] text-foreground-subtle">
          <span>
            {t('uiLibrary.eventBucketStrip.shown', '({{count}} shown)', { count: clips.length })}
          </span>
          {hasMore ? (
            <button
              type="button"
              onClick={onLoadMore}
              className="rounded px-2 py-0.5 text-[11px] font-medium text-primary hover:underline"
            >
              {t('uiLibrary.eventBucketStrip.loadMore', 'Load more')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
