/**
 * SemanticEventSearch — CLIP text→event semantic search over object events.
 *
 * An operator types a natural-language query ("person in a red jacket", "dog")
 * and the pipeline-analytics CLIP index returns the best-matching object events,
 * scored 0..1. Results render through the SAME `EventCard` grid + `EventDetailPanel`
 * as the normal key-events feed — a hit is visually identical to a feed event,
 * plus a semantic-match score badge — so there is ONE card/detail surface.
 *
 * The query is debounced (~350ms) and only fires for a non-empty term
 * (`enabled: text.length > 0`), so keystrokes don't spam the backend. When the
 * debounced term is empty the component reports `active: false` up to the page,
 * which restores the normal `EventsSection` view.
 *
 * `searchObjectEvents` returns `ScoredObjectEvent[]` (an `ObjectEvent` + `score`).
 * The card/detail surface speaks `KeyEventRow` (a {@link TrackSubject}), so each
 * scored event is adapted via `scoredEventToRow` into a {@link SemanticEventRow}:
 * `bestEventId` is the event's own id, same as every other `TrackSubject`
 * producer (D482 — it is no longer read for media addressing), and `mediaId`
 * carries the event's own resolved media row when it has one
 * (`keyFrameMediaId` — the native full frame — else the tighter `mediaId`
 * crop). `EventCard`'s tile prefers `mediaId` and falls back to the OWNER form
 * on `trackId` (which falls back to the event id when the row predates
 * tracking) — never a raw id/key spliced into a path. One field is no longer
 * overloaded to mean three different kinds of id.
 */

import type { ClipSearchStrictness, ScoredObjectEvent } from '@camstack/types'
import {
  eventKindLabel,
  MediaGrid,
  Select,
  useDebouncedString,
  useDeviceManagerListAll,
  usePipelineAnalyticsListEventKindsBatch,
  usePipelineAnalyticsSearchObjectEvents,
  useSearchFieldHotkey,
  Input,
} from '@camstack/ui-library'
import { Loader2, Search, X } from 'lucide-react'
import { type JSX, useEffect, useMemo, useState, useRef } from 'react'
import { EventCard } from './EventCard.js'
import { EventDetailPanel } from './EventDetailPanel.js'
import { searchableMacros } from './event-kind-vocabulary.js'
import type { KeyEventRow } from './key-events-merge.js'
import { DELETE_TRACKS_AVAILABLE } from './use-delete-tracks.js'
import { useTranslation } from 'react-i18next'

/** Max hits requested from the CLIP index. */
const SEARCH_LIMIT = 50

/** Debounce so keystrokes don't spam the CLIP query. */
const SEARCH_DEBOUNCE_MS = 350

/**
 * Match presets — MODEL-RELATIVE strictness (D649). The hub turns each into the
 * searched model's own cosine floor: on MobileCLIP exactly the 0.20 / 0.25 /
 * 0.30 these buttons always sent, on SigLIP2 0.10 / 0.125 / 0.15 — an absolute
 * 0.2 there dropped 97% of true matches.
 */
const STRICTNESS_PRESETS: readonly {
  readonly value: ClipSearchStrictness
  readonly labelKey: string
  readonly titleKey: string
}[] = [
  {
    value: 'loose',
    labelKey: 'detectionIntelligence.semanticEventSearch.looseLabel',
    titleKey: 'detectionIntelligence.semanticEventSearch.looseTitle',
  },
  {
    value: 'balanced',
    labelKey: 'detectionIntelligence.semanticEventSearch.balancedLabel',
    titleKey: 'detectionIntelligence.semanticEventSearch.balancedTitle',
  },
  {
    value: 'strict',
    labelKey: 'detectionIntelligence.semanticEventSearch.strictLabel',
    titleKey: 'detectionIntelligence.semanticEventSearch.strictTitle',
  },
]

/**
 * A search hit adapted onto the shared card/detail shape, plus its OWN media
 * address (D482) — kept separate from `bestEventId` rather than folded into
 * it, since a field meaning "event id OR track id OR media key" is exactly
 * the ambiguity D482 removes.
 */
export interface SemanticEventRow extends KeyEventRow {
  /** The event's own resolved media row, when it has one. Absent (never `0`)
   *  means no media row was named — the tile then falls back to the owner
   *  form on `trackId`. */
  readonly mediaId?: number
}

/**
 * Adapt a scored object event onto the shared `KeyEventRow` card/detail shape.
 * `bestEventId` is the event's own id — the same thing every other
 * `TrackSubject` producer puts there — and is no longer read for media
 * addressing (see `track-subject.ts`). `mediaId` carries the event's own
 * resolved media row (prefer the native `keyFrameMediaId` full frame, else
 * the tighter `mediaId` crop); `EventCard` falls back to the owner form on
 * `trackId` when neither is present (a bare object event's own id has no
 * media, which was leaving search hits blank before D482's owner ladder).
 * `importance` is the propagated track importance, independent of the
 * semantic `score` (rendered as its own badge).
 */
function scoredEventToRow(event: ScoredObjectEvent): SemanticEventRow {
  // `KeyEventRow.id` / `bestEventId` stay TEXT (D474 — events are numbers,
  // but the shared shape spells every id as a string).
  const eventId = String(event.id)
  return {
    id: eventId,
    trackId: event.trackId ?? eventId,
    deviceId: event.deviceId,
    timestamp: event.timestamp,
    className: event.className,
    label: event.label,
    subLabel: event.subLabel,
    importance: event.importance ?? 0,
    bestEventId: eventId,
    mediaId: event.keyFrameMediaId ?? event.mediaId,
    windowMs: undefined,
  }
}

interface SemanticEventSearchProps {
  /** Reports whether a non-empty search is active, so the page can hide the feed. */
  readonly onActiveChange: (active: boolean) => void
}

export function SemanticEventSearch({ onActiveChange }: SemanticEventSearchProps): JSX.Element {
  const searchFieldRef = useRef<HTMLInputElement>(null)
  useSearchFieldHotkey(searchFieldRef)
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [strictness, setStrictness] = useState<ClipSearchStrictness>('loose')
  const [classFilter, setClassFilter] = useState<string | null>(null)
  const [deviceId, setDeviceId] = useState<number | null>(null)
  const [detailRow, setDetailRow] = useState<SemanticEventRow | null>(null)

  const debounced = useDebouncedString(text, SEARCH_DEBOUNCE_MS).trim()
  const active = debounced.length > 0

  useEffect(() => {
    onActiveChange(active)
  }, [active, onActiveChange])

  // Coarse clock tick (60s) for stable relative timestamps on the cards.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  // Cameras only, filtered server-side — the device manager otherwise
  // returns the whole smart-home (sensors, switches, …) and this panel only
  // ever resolves a camera's name. `slim` + the query client's fleet window (D274): same
  // camera-roster shape the other detection-intelligence sections read, so
  // they share one fetch instead of each re-triggering their own.
  const { data: devices = [] } = useDeviceManagerListAll({ isCamera: true, projection: 'slim' })
  const nameById = useMemo(() => {
    const map = new Map<number, string>()
    for (const d of devices) map.set(d.id, d.name)
    return map
  }, [devices])
  const cameraName = (id: number): string =>
    nameById.get(id) ?? t('detectionIntelligence.cameraFallback', { id: String(id) })

  // The class chips are DERIVED from what the cameras advertise, not declared:
  // the literal they replace was ['person','vehicle','animal'] on every camera,
  // which offered `animal` to cameras that detect none and could never narrow a
  // search to `package`. Scoped to the selected camera when there is one.
  const cameraIds = useMemo(() => devices.map((c) => c.id), [devices])
  const { data: eventKindsPerDevice } = usePipelineAnalyticsListEventKindsBatch(
    { deviceIds: cameraIds },
    { enabled: cameraIds.length > 0, staleTime: 5 * 60_000 },
  )
  const classChips = useMemo(
    () => searchableMacros(eventKindsPerDevice ?? [], new Set(deviceId === null ? [] : [deviceId])),
    [eventKindsPerDevice, deviceId],
  )

  // A chip that just left the scoped camera's vocabulary must not stay latched:
  // the search would keep filtering by a class the camera cannot produce, and
  // the operator would see an empty result set with no visible cause.
  useEffect(() => {
    if (classFilter === null) return
    if (classChips.some((c) => c.kind === classFilter)) return
    setClassFilter(null)
  }, [classChips, classFilter])

  const {
    data: results,
    isFetching,
    isError,
    error,
  } = usePipelineAnalyticsSearchObjectEvents(
    {
      text: debounced,
      strictness,
      limit: SEARCH_LIMIT,
      classFilter: classFilter ?? undefined,
      deviceId: deviceId ?? undefined,
    },
    { enabled: active },
  )

  // Backend returns descending score; re-sort defensively so the badge order
  // always reads top-down.
  const rows = useMemo<readonly (SemanticEventRow & { readonly score: number })[]>(() => {
    return [...(results ?? [])]
      .sort((a, b) => b.score - a.score)
      .map((e) => ({ ...scoredEventToRow(e), score: e.score }))
  }, [results])

  function toggleClass(cls: string) {
    setClassFilter((prev) => (prev === cls ? null : cls))
  }

  return (
    <div className="space-y-3">
      {/* Search bar */}
      <div className="rounded-lg border border-border bg-surface p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[16rem] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
            <Input
              ref={searchFieldRef}
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t(
                'detectionIntelligence.semanticEventSearch.semanticSearchDescribeWhatYou',
                "Semantic search — describe what you're looking for…",
              )}
              className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-8 text-sm text-foreground placeholder:text-foreground-subtle focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              aria-label={t(
                'detectionIntelligence.semanticEventSearch.semanticEventSearch',
                'Semantic event search',
              )}
            />
            {text && (
              <button // ui-check-ok: clear affordance inside the search field
                type="button"
                onClick={() => setText('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
                aria-label={t(
                  'detectionIntelligence.semanticEventSearch.clearSearch',
                  'Clear search',
                )}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {isFetching && active && (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-foreground-subtle" />
          )}
        </div>

        {/* Refinements — only meaningful once a query is active */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {/* Class filter (single) */}
          <div className="flex items-center gap-1">
            {classChips.map((chip) => {
              const activeChip = classFilter === chip.kind
              return (
                <button // ui-check-ok: CHIP_* class filter pill
                  key={chip.kind}
                  type="button"
                  onClick={() => toggleClass(chip.kind)}
                  className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                    activeChip
                      ? 'bg-primary/12 text-primary font-medium'
                      : 'text-foreground-subtle hover:bg-surface-hover hover:text-foreground'
                  }`}
                >
                  {eventKindLabel(chip)}
                </button>
              )
            })}
          </div>

          {/* Device filter (single) */}
          <label className="flex items-center gap-1.5 text-[11px] text-foreground-subtle">
            <span>{t('detectionIntelligence.semanticEventSearch.camera', 'Camera')}</span>
            <Select
              value={deviceId === null ? '' : String(deviceId)}
              onChange={(e) => setDeviceId(e.target.value === '' ? null : Number(e.target.value))}
              className="h-7 text-xs"
              aria-label={t(
                'detectionIntelligence.semanticEventSearch.filterByCamera',
                'Filter by camera',
              )}
              options={[
                { value: '', label: t('detectionIntelligence.semanticEventSearch.all', 'All') },
                ...devices.map((d) => ({ value: String(d.id), label: d.name })),
              ]}
            />
          </label>

          {/* strictness presets — model-relative floors */}
          <div className="flex items-center gap-1.5 text-[11px] text-foreground-subtle">
            <span>{t('detectionIntelligence.semanticEventSearch.match', 'Match')}</span>
            <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
              {STRICTNESS_PRESETS.map((p) => (
                <button // ui-check-ok: CHIP_* match-strictness segment
                  key={p.value}
                  type="button"
                  onClick={() => setStrictness(p.value)}
                  className={`rounded px-2 py-1 text-[11px] transition-colors ${
                    strictness === p.value
                      ? 'bg-primary/12 text-primary font-medium'
                      : 'text-foreground-subtle hover:bg-surface-hover hover:text-foreground'
                  }`}
                  title={t(p.titleKey)}
                >
                  {t(p.labelKey)}
                </button>
              ))}
            </div>
          </div>

          {active && !isFetching && !isError && (
            <span className="ml-auto text-[10px] text-foreground-subtle">
              {t('common.matches', { count: rows.length })}
            </span>
          )}
        </div>
      </div>

      {/* Results (only when a query is active) */}
      {active && (
        <div className="space-y-3">
          {isError && (
            <p className="py-4 text-xs text-danger">
              {t('detectionIntelligence.semanticEventSearch.searchFailed', 'Search failed:')}{' '}
              {error instanceof Error
                ? error.message
                : t('detectionIntelligence.semanticEventSearch.unknownError', 'unknown error')}
              . Check that the CLIP embedding step is enabled.
            </p>
          )}
          {!isError && isFetching && rows.length === 0 && (
            <MediaGrid status="pending" pendingMessage="Searching…" testId="semantic-events-grid" />
          )}
          {!isError && !isFetching && rows.length === 0 && (
            <MediaGrid
              status="empty"
              emptyMessage={t(
                'detectionIntelligence.semanticEventSearch.noSemanticMatchesForTry',
                'No semantic matches for “{{debounced}}”. Try a looser match threshold or a different phrasing.',
                { debounced },
              )}
              testId="semantic-events-grid"
            />
          )}
          {!isError && rows.length > 0 && (
            <MediaGrid status="ready" testId="semantic-events-grid">
              {rows.map((row) => (
                <EventCard
                  key={row.id}
                  row={row}
                  cameraName={cameraName(row.deviceId)}
                  nowMs={nowMs}
                  score={row.score}
                  onOpenDetail={setDetailRow}
                />
              ))}
            </MediaGrid>
          )}
        </div>
      )}

      {/* Detail modal — the SAME panel the feed uses */}
      {detailRow && (
        <EventDetailPanel
          row={detailRow}
          cameraName={cameraName(detailRow.deviceId)}
          deleteAvailable={DELETE_TRACKS_AVAILABLE}
          onClose={() => setDetailRow(null)}
          onDeleted={() => setDetailRow(null)}
        />
      )}
    </div>
  )
}
