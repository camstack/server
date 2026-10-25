/**
 * Events → Debug — the tracks an operator marked `debug`, and what is wrong with
 * them.
 *
 * The `debug` flag has existed since [D81](../../../../docs/decisions/adr-0081.md)
 * with no consumer: `setTrackFlags({ debug })` wrote a column nothing read. This
 * is that consumer. Marking a track is how an operator says "this one looked
 * wrong"; this tab turns the mark into a list of named, checkable statements
 * about what the pipeline did not produce for it, and hands the whole set over
 * as a bundle.
 *
 * ## What it reads
 *
 * Two `addons.custom` actions on the `pipeline-analytics` addon — NOT capability
 * methods. The tab is a hub-local diagnostic over a store the hub already owns,
 * so it needs no codegen, no `@camstack/system` publish and no release train: it
 * ships with one `camstack deploy` of the addon and one of this bundle. That
 * property survived the 2026-08-28 rework: everything new here — the tile
 * provenance, the miss reason, the subject fields the shared card needs — rides
 * the SAME two actions, and the bulk actions write the `setTrackFlags` cap
 * method that already existed.
 *
 *   - `debug.listTracks` — the marked set, one indexed query per camera.
 *   - `debug.analyze`    — the expensive half (media inventory + tile
 *                          provenance + event count per track), asked for by id
 *                          once the list is known.
 *
 * The split is the point: opening the tab must not cost the analysis of every
 * marked track on every camera. It is also why the CARD renders from the list
 * alone — picture, name, camera, time, flags — and only the findings strip waits
 * for the second call.
 *
 * ## Why it looks like the Events feed
 *
 * Because it is the Events feed's components. `EventCard` and
 * `EventDetailPanel` take a `TrackSubject` (`components/detection-intelligence/
 * track-subject.ts`), not the feed's own row, so this tab renders the same card
 * and opens the same detail surface — one filmstrip, one trajectory, one set of
 * flag toggles, one delete. Before that this tab was a stack of grey text lines
 * beside a screen that showed pictures, and an operator asking "why is this
 * track wrong" had to go and find the same track somewhere else to look at it.
 *
 * ## What it deliberately does not claim
 *
 * A `debug` mark does NOT pin retention. A marked track whose media has been
 * evicted is gone, and its absence is indistinguishable from a track that never
 * captured anything — so the tab shows what still EXISTS and says so, rather
 * than implying the mark preserved it. `debug.analyze` reports ids that
 * disappeared between the list and the analysis; those are surfaced too. That is
 * also why **Keep** is a bulk action: it is the only thing on this page that
 * stops the evidence ageing out while it is being investigated.
 *
 * And a tile is never shown as if it were a best shot when it is not
 * ([D276](../../../../docs/decisions/adr-0276-a-stand-in-tile-is-provisional-and-a-close-says-why.md)):
 * a `standin` (a face or plate detail crop) and a `raster` (a sub-native subject
 * crop) are badged on the picture, and the close's own `previewMissReason` is
 * printed under it. `native` — and a row too old to classify, which ranks
 * `native` for exactly that reason — say nothing at all.
 *
 * ## "Close the debug" is un-marking, and it is called Analyzed
 *
 * The operator asked to be able to close a debug. It resolves to
 * `setTrackFlags({ debug: false })`: the row leaves this list, the debug export
 * stops carrying it, no new state is stored anywhere, and re-marking is one
 * click on any track surface. The word is the viewer's — its track detail has
 * shipped an **Analyzed** toggle doing exactly this write — so the two clients
 * name one action the same way. A "dismissed but still marked" state was
 * rejected: it needs a store nobody has, and it would leave the export shipping
 * tracks the operator has finished with, which is the thing the action is for.
 *
 * ## Tracking tapes (D681)
 *
 * A collapsed section at the top, `EventsDebugTapes.tsx`: the tracking-tape
 * recorder's per-camera state, window promotion, the promoted list and the
 * ground-truth review. It rides `debug.tape.*` and `debug.gt.*` on the same
 * addon, asks nothing until opened, and never flips the recording switch —
 * that is the camera's Tracking setting.
 */
import {
  Badge,
  Button,
  EmptyState,
  ErrorBox,
  MediaGrid,
  Select,
  useDeviceManagerListAll,
  useSystem,
} from '@camstack/ui-library'
import { useQuery } from '@tanstack/react-query'
import { Bug, Check, Download, Loader2, RefreshCw, Star, Undo2, X } from 'lucide-react'
import { type JSX, useMemo, useState } from 'react'
import { EventCard } from '../components/detection-intelligence/EventCard'
import { EventDetailPanel } from '../components/detection-intelligence/EventDetailPanel'
import { describePreviewMiss } from '../components/detection-intelligence/media-provenance'
import {
  TRACK_FLAGS_AVAILABLE,
  TRACK_FLAGS_UNAVAILABLE_TITLE,
  useSetTrackFlagsMutation,
} from '../components/detection-intelligence/use-track-flags'
import { DELETE_TRACKS_AVAILABLE } from '../components/detection-intelligence/use-delete-tracks'
import { authedDownload } from '../lib/authed-media'
import { EventsDebugTapes } from './EventsDebugTapes'
import {
  DEBUG_ADDON_ID,
  DEBUG_ANALYZE_ACTION,
  DEBUG_LIST_ACTION,
  type DebugFinding,
  type DebugSelectionTarget,
  type DebugSeverity,
  type DebugTrackListItem,
  type DebugTrackReport,
  debugExportUrl,
  debugSelectionKey,
  findingLabel,
  parseDebugAnalyze,
  parseDebugList,
  resolveSelection,
  sortFindings,
} from './events-debug.helpers'
import { Trans, useTranslation } from 'react-i18next'

const ALL_CAMERAS = 'all'
const UNREADABLE = 'The server answered in a shape this build does not understand.'

/** Badge tone per severity — the same three the finding vocabulary uses. */
const SEVERITY_VARIANT: Readonly<Record<DebugSeverity, 'danger' | 'warning' | 'info'>> = {
  error: 'danger', // i18n-ignore: badge variant
  warn: 'warning',
  info: 'info',
}

function FindingBadges({ findings }: { readonly findings: readonly DebugFinding[] }) {
  const { t } = useTranslation()
  if (findings.length === 0) {
    return <Badge variant="success">{t('eventsDebug.noAnomalyFound', 'no anomaly found')}</Badge>
  }
  return (
    <div className="flex flex-wrap gap-1">
      {sortFindings(findings).map((f) => (
        // `title` carries the addon's own sentence, with the number that
        // triggered the rule — the badge is the scannable half, not the whole.
        <Badge key={f.code} variant={SEVERITY_VARIANT[f.severity]} title={f.detail}>
          {findingLabel(f.code)}
        </Badge>
      ))}
    </div>
  )
}

interface TrackFindingsProps {
  readonly track: DebugTrackListItem
  readonly report: DebugTrackReport | undefined
  readonly analyzing: boolean
}

/**
 * The diagnostic tail under a card: the findings, the inventory counts, and the
 * close's own account of the best shot.
 *
 * The counts stay even though the card now shows a picture — "6 media" and
 * "0 events" are the two numbers the whole triage turns on, and a thumbnail
 * cannot report either.
 */
function TrackFindings({ track, report, analyzing }: TrackFindingsProps): JSX.Element {
  const { t } = useTranslation()
  // The list carries the reason too, so this line appears with the card rather
  // than after the second round-trip.
  const miss = describePreviewMiss(report?.previewMissReason ?? track.previewMissReason)
  return (
    <div className="space-y-1 border-t border-border pt-1.5">
      {report === undefined ? (
        <span className="text-[10px] text-foreground-subtle">
          {analyzing
            ? t('eventsDebug.analysing', 'analysing…')
            : t('eventsDebug.notAnalysed', 'not analysed')}
        </span>
      ) : (
        <>
          <FindingBadges findings={report.findings} />
          <p
            className="text-[10px] text-foreground-subtle"
            title={
              report.mediaKinds.length > 0
                ? report.mediaKinds.join(', ')
                : t('eventsDebug.noMediaOfAnyKind', 'no media of any kind')
            }
          >
            {t('eventsDebug.reportCounts', {
              media: String(report.mediaCount),
              events: String(report.eventCount),
              positions: String(report.positionCount),
            })}
          </p>
        </>
      )}
      {miss !== null && (
        <p className="text-[10px] text-foreground-subtle" title={miss.raw}>
          {miss.sentence}
        </p>
      )}
    </div>
  )
}

/** A bulk write's outcome — how many landed, and the ones the server refused. */
interface BulkOutcome {
  readonly applied: number
  readonly refused: readonly string[]
}

export function EventsDebugPage(): JSX.Element {
  const { t } = useTranslation()
  const system = useSystem()
  const [camera, setCamera] = useState<string>(ALL_CAMERAS)
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [detailRow, setDetailRow] = useState<DebugTrackListItem | null>(null)
  const [bulkPending, setBulkPending] = useState<'analyzed' | 'keep' | null>(null)
  const [bulkError, setBulkError] = useState<string | null>(null)
  /**
   * What the last "Analyzed" un-marked, so it can be put back.
   *
   * Component state, not storage: this is the undo of one click, not a
   * "reviewed" lifecycle. Inventing a durable reviewed-state would be a new
   * store nobody reads — see the module docblock.
   */
  const [undoable, setUndoable] = useState<readonly DebugSelectionTarget[]>([])

  const flagsMutation = useSetTrackFlagsMutation()

  // Cameras only, filtered server-side (the picker below is "All cameras" +
  // one option per camera — the unfiltered fleet was listing every
  // sensor/switch as a "camera" option), slim, and the query client's fleet window (D274).
  const devicesQuery = useDeviceManagerListAll({
    isCamera: true,
    projection: 'slim',
  })
  const cameraOptions = useMemo(
    () => [
      { value: ALL_CAMERAS, label: t('eventsDebug.allCameras', 'All cameras') },
      ...(devicesQuery.data ?? []).map((d) => ({
        value: String(d.id),
        label: d.name,
      })),
    ],
    [devicesQuery.data, t],
  )
  const cameraNameById = useMemo(() => {
    const map = new Map<number, string>()
    for (const d of devicesQuery.data ?? []) map.set(d.id, d.name)
    return map
  }, [devicesQuery.data])
  const cameraName = (deviceId: number): string =>
    cameraNameById.get(deviceId) ?? t('eventsDebug.cameraFallback', { deviceId })

  const deviceIds = useMemo(
    () => (camera === ALL_CAMERAS ? [] : [Number.parseInt(camera, 10)]),
    [camera],
  )

  const listQuery = useQuery({
    queryKey: ['events-debug', 'list', deviceIds],
    queryFn: async () => {
      const raw = await system.trpcClient.addons.custom.mutate({
        addonId: DEBUG_ADDON_ID,
        action: DEBUG_LIST_ACTION,
        input: deviceIds.length === 0 ? {} : { deviceIds },
      })
      return parseDebugList(raw)
    },
  })

  const trackIds = useMemo(
    () => (listQuery.data?.tracks ?? []).map((t) => t.trackId),
    [listQuery.data],
  )

  const analyzeQuery = useQuery({
    queryKey: ['events-debug', 'analyze', trackIds],
    enabled: trackIds.length > 0,
    queryFn: async () => {
      const raw = await system.trpcClient.addons.custom.mutate({
        addonId: DEBUG_ADDON_ID,
        action: DEBUG_ANALYZE_ACTION,
        input: { trackIds },
      })
      return parseDebugAnalyze(raw)
    },
  })

  const reportByTrack = useMemo(() => {
    const map = new Map<string, DebugTrackReport>()
    for (const r of analyzeQuery.data?.reports ?? []) map.set(r.trackId, r)
    return map
  }, [analyzeQuery.data])

  const tracks = listQuery.data?.tracks ?? []
  const unreadable = listQuery.data === null || analyzeQuery.data === null

  const refresh = (): void => {
    void listQuery.refetch()
    void analyzeQuery.refetch()
  }

  const toggleSelect = (key: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const selectAll = (): void => {
    setSelected(new Set(tracks.map((t) => debugSelectionKey(t.deviceId, t.trackId))))
  }
  const clearSelection = (): void => setSelected(new Set())

  /**
   * Write one flag across a selection, ONE track at a time.
   *
   * `setTrackFlags` is per-track and there is no batch form; adding one would
   * be a cap change, which is exactly the release train this tab exists without.
   * Sequential rather than parallel because the hub runs this on the thread that
   * also decodes frames, and because the server can REFUSE a write (the
   * per-camera pin budget) — a refusal has to be attributable to its track, not
   * lost in a settled array.
   */
  const applyToSelection = async (
    kind: 'analyzed' | 'keep',
    targets: readonly DebugSelectionTarget[],
  ): Promise<BulkOutcome> => {
    const flags = kind === 'analyzed' ? { debug: false } : { favourited: true }
    let applied = 0
    const refused: string[] = []
    for (const target of targets) {
      try {
        await flagsMutation.mutateAsync({
          deviceId: target.deviceId,
          trackId: target.trackId,
          flags,
        })
        applied += 1
      } catch {
        refused.push(target.trackId)
      }
    }
    return { applied, refused }
  }

  const runBulk = (kind: 'analyzed' | 'keep'): void => {
    if (!TRACK_FLAGS_AVAILABLE || bulkPending !== null) return
    const targets = resolveSelection(tracks, selected)
    if (targets.length === 0) return
    setBulkPending(kind)
    setBulkError(null)
    void (async () => {
      const outcome = await applyToSelection(kind, targets)
      setBulkPending(null)
      // Only the tracks that actually moved leave the selection — a refused one
      // stays selected so the operator can retry it.
      const refusedIds = new Set(outcome.refused)
      setSelected(
        new Set(
          targets
            .filter((t) => refusedIds.has(t.trackId))
            .map((t) => debugSelectionKey(t.deviceId, t.trackId)),
        ),
      )
      if (kind === 'analyzed') {
        setUndoable(targets.filter((t) => !refusedIds.has(t.trackId)))
      }
      if (outcome.refused.length > 0) {
        setBulkError(
          `${String(outcome.refused.length)} of ${String(targets.length)} were refused by the server and are still selected. Check the hub log.`,
        )
      }
      void listQuery.refetch()
    })()
  }

  const undoAnalyzed = (): void => {
    const targets = undoable
    if (targets.length === 0 || bulkPending !== null) return
    setBulkPending('analyzed')
    setBulkError(null)
    void (async () => {
      for (const target of targets) {
        try {
          await flagsMutation.mutateAsync({
            deviceId: target.deviceId,
            trackId: target.trackId,
            flags: { debug: true },
          })
        } catch {
          // Re-marking cannot be refused by a budget (`debug` pins nothing), so
          // a failure here is a transport one — reported below, in one line.
          setBulkError('Some tracks could not be re-marked. Refresh and try again.')
        }
      }
      setBulkPending(null)
      setUndoable([])
      void listQuery.refetch()
    })()
  }

  const exportAll = async (): Promise<void> => {
    setDownloading(true)
    setDownloadError(null)
    try {
      await authedDownload(debugExportUrl(deviceIds), 'camstack-debug.zip')
    } catch (err: unknown) {
      setDownloadError(err instanceof Error ? err.message : 'Export failed.')
    } finally {
      setDownloading(false)
    }
  }

  const bulkBusy = bulkPending !== null

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-44">
          <Select
            value={camera}
            options={cameraOptions}
            onChange={(e) => setCamera(e.target.value)}
          />
        </div>
        <Button variant="secondary" onClick={refresh} disabled={listQuery.isFetching}>
          {listQuery.isFetching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {t('common.refresh', 'Refresh')}
        </Button>
        <Button onClick={() => void exportAll()} disabled={downloading || tracks.length === 0}>
          {downloading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {t('eventsDebug.exportAll', { count: String(tracks.length) })}
        </Button>
        {tracks.length > 0 && selected.size < tracks.length && (
          <Button variant="ghost" onClick={selectAll}>
            {t('eventsDebug.selectAll', 'Select all')}
          </Button>
        )}
      </div>

      <p className="text-xs text-foreground-subtle">
        <Trans
          i18nKey="eventsDebug.debugMarkNote"
          components={{ code: <code />, strong: <strong /> }}
        />
      </p>

      <EventsDebugTapes />

      {listQuery.isError && (
        <ErrorBox
          message={t('eventsDebug.couldNotLoadTheMarked', 'Could not load the marked tracks.')}
        />
      )}
      {unreadable && !listQuery.isError && <ErrorBox message={UNREADABLE} />}
      {downloadError !== null && <ErrorBox message={downloadError} />}
      {bulkError !== null && <ErrorBox message={bulkError} />}
      {listQuery.data?.truncated === true && (
        <ErrorBox
          message={t(
            'eventsDebug.aCameraFilledThePer',
            'A camera filled the per-camera cap — some marked tracks are not listed. Un-mark a few, or filter to one camera.',
          )}
        />
      )}
      {(analyzeQuery.data?.vanished.length ?? 0) > 0 && (
        <p className="text-xs text-foreground-subtle">
          {t('eventsDebug.vanished', { count: String(analyzeQuery.data?.vanished.length) })}
        </p>
      )}

      {/* Selection action bar — the same shape and placement as the Events
            feed's, so a multi-select means the same thing on both screens. */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/8 px-3 py-2">
          <span className="text-xs font-medium text-foreground">
            {t('common.selectedCount', { count: selected.size })}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <span title={TRACK_FLAGS_AVAILABLE ? undefined : TRACK_FLAGS_UNAVAILABLE_TITLE}>
              <Button
                variant="secondary"
                onClick={() => runBulk('keep')}
                disabled={!TRACK_FLAGS_AVAILABLE || bulkBusy}
              >
                {bulkPending === 'keep' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Star className="h-3.5 w-3.5" />
                )}{' '}
                {t('eventsDebug.keep', 'Keep')}
              </Button>
            </span>
            <span title={TRACK_FLAGS_AVAILABLE ? undefined : TRACK_FLAGS_UNAVAILABLE_TITLE}>
              <Button
                onClick={() => runBulk('analyzed')}
                disabled={!TRACK_FLAGS_AVAILABLE || bulkBusy}
              >
                {bulkPending === 'analyzed' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}{' '}
                {t('eventsDebug.analyzed', 'Analyzed')}
              </Button>
            </span>
            <Button variant="ghost" onClick={clearSelection} disabled={bulkBusy}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* Undo for the last un-mark. A reversible action says so on screen —
            an operator who un-marked the wrong five has no other way back. */}
      {undoable.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-3 py-2">
          <span className="text-xs text-foreground">
            {t('eventsDebug.markedAnalyzed', { count: String(undoable.length) })}
          </span>
          <Button variant="ghost" onClick={undoAnalyzed} disabled={bulkBusy}>
            <Undo2 className="h-3.5 w-3.5" /> {t('eventsDebug.undo')}
          </Button>
          <Button variant="ghost" onClick={() => setUndoable([])} disabled={bulkBusy}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {listQuery.isLoading ? (
        <MediaGrid status="pending" pendingMessage="Loading…" testId="debug-tracks-grid" />
      ) : tracks.length === 0 ? (
        <EmptyState
          icon={Bug}
          title={t('eventsDebug.noTrackIsMarkedFor', 'No track is marked for debug')}
          description={t(
            'eventsDebug.markOneFromATrack',
            "Mark one from a track's actions on the Feed to see it here.",
          )}
        />
      ) : (
        <MediaGrid status="ready" testId="debug-tracks-grid">
          {tracks.map((track) => {
            const report = reportByTrack.get(track.trackId)
            return (
              <EventCard
                key={debugSelectionKey(track.deviceId, track.trackId)}
                row={track}
                cameraName={cameraName(track.deviceId)}
                nowMs={track.lastSeen}
                selected={selected.has(debugSelectionKey(track.deviceId, track.trackId))}
                onToggleSelect={toggleSelect}
                onOpenDetail={setDetailRow}
                {...(report?.thumbnailProvenance === undefined
                  ? {}
                  : { provenance: report.thumbnailProvenance })}
                footer={
                  <TrackFindings
                    track={track}
                    report={report}
                    analyzing={analyzeQuery.isFetching}
                  />
                }
              />
            )
          })}
        </MediaGrid>
      )}

      {/* The SAME detail surface the Events feed opens — media, trajectory,
            metadata, the flag toggles and delete. Not a debug-only view. */}
      {detailRow && (
        <EventDetailPanel
          row={detailRow}
          cameraName={cameraName(detailRow.deviceId)}
          deleteAvailable={DELETE_TRACKS_AVAILABLE}
          onClose={() => setDetailRow(null)}
          onDeleted={() => {
            setDetailRow(null)
            void listQuery.refetch()
          }}
          onFlagsChanged={(flags) => {
            // A `debug` cleared from inside the panel takes the row off this
            // list, so the list is re-read. Anything else is a flag the list
            // does not filter on and the next natural refetch carries it.
            if (!flags.debug) {
              setDetailRow(null)
              void listQuery.refetch()
            }
          }}
        />
      )}
    </section>
  )
}
