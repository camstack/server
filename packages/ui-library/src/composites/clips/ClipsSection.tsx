/**
 * `host/clips-browser` — a camera's clips, from EVERY source it has, as the
 * LAST SECTION of the Recording tab.
 *
 * Mounted by the framework, not by hand: `videoclips.cap.ts` declares
 * `deviceConfig.ui = { kind:'widget', widgetId:'host/clips-browser',
 * tab:'recording', topTab:true, order:100 }` and
 * `deriveDeviceConfigContribution` emits the section (D14). `DeviceDetail.tsx`
 * is not edited — placement is data. Because the admin Recordings page renders
 * every `location:'top-tab'` + `tab:'recording'` section behind its camera
 * picker (`CameraRecordingSettingsSection`), the same declaration puts this on
 * both surfaces with no second wiring.
 *
 * ## Built from the library, not from scratch
 *
 * It shipped as its own top tab made of five bespoke components, and the
 * operator rejected both: *"La UI è orribile, non segue la nostra UI affatto …
 * Io in realtà utilizzerei la stessa tab recordings, lì abbiamo già tutto il
 * necessario, una nuova sezione alla fine per le clips dove possiamo
 * selezionare le source con un multiselect common, non componenti nuovi
 * anonimi."* [The UI is horrible, it does not follow our UI at all … I would actually use the same recordings tab, we already have everything necessary there, a new section at the end for the clips where we can select the sources with a common multiselect, no new anonymous components.] So every piece of chrome here is a component this repo already
 * has: `Select`, `DataTable`, `EmptyState`, `ErrorBox`, `Pagination`, `Card`,
 * `Badge`, `Button`, `Skeleton`. What the chrome CARRIES is unchanged, and it
 * is the feature:
 *
 *  - **The source list is complete, always.** Every source the camera has,
 *    with its availability and the age of its catalog, whichever provider is
 *    being asked. A source never leaves the table.
 *  - **Nothing is deduped.** A clip held in two storages appears twice, once
 *    per source, and every tile says which (D549).
 *  - **Four states are tellable apart**: loading, empty-with-a-cause,
 *    degraded-per-source, and each silent source in its own words. Every one
 *    of them used to render as "no clips", which is the defect this whole line
 *    of work is about — a camera with no SD card (106) is not quiet, and a
 *    camera whose own index disagrees with its own calendar (108, 6–20
 *    September) is not quiet either.
 *
 * ## The period comes from the recording section's timebar, not a day picker
 *
 * It shipped with its own `‹ day ›` pair and the operator replaced it the same
 * way he replaced the chrome: *"Possiamo utilizzare lo stesso componente della
 * sezione recording con la timebar dove selezionare un periodo e mostrare le
 * clip solo di quella banda selezionata, espandibile."* [We can use the same component as the recording section with the timebar where a period can be selected and show the clips of that selected band only, expandable.] So the list follows a
 * BAND (D564) — `TimelineControls` for the day, the zoom and the pan,
 * `EventHeatmap` for picking a narrower window out of it, both of them the
 * pieces `RecordingTimeline` is itself built from, over the same
 * `recording-timeline-model`. Three things that are decisions, not details:
 *
 *  - **The band lives HERE, once.** `ClipBandBar` is presentational. Two
 *    components holding two ideas of the selected period is the defect this
 *    repo keeps paying for, and the period is what the query is made of.
 *  - **`CoverageTrack` stayed behind**, because there it is the seek surface
 *    that moves the hero player's playhead. A copy here would be a dead bar or
 *    a second claimant on that position.
 *  - **A band is asked for only if it is affordable.** `clip-band.ts` counts
 *    the LOCAL days it touches — the camera's own search is clamped to one per
 *    call, and a day listing is 4.3–6.0 s on 592 — and refuses past the bound
 *    by name rather than asking and rendering whichever days answered.
 *
 * ## The picker WRITES nothing, and there is nothing for it to write
 *
 * A clip source is not enabled or disabled — it EXISTS, because of a
 * configuration that lives somewhere else. The operator put it exactly:
 * *"non è affatto necessario lo stato di abilitato o meno delle sources. Loro
 * vivono lì, ad esempio hksv c'è se la camera è esportata su homekit, reolink
 * la dà di suo così come il camstack."* [the enabled-or-not state of the sources is not necessary at all. They live there, for example hksv is there if the camera is exported to homekit, reolink provides it on its own, as does camstack.] HKSV is there if the camera is
 * exported to HomeKit; the Reolink source is there because Reolink is that
 * camera's provider; CamStack's is always there. None of that is a decision to
 * make in a clips list, so this surface offers no switch and writes no
 * authority (D557, amended). A directory-wide guard in
 * `clips-section-sources.test.tsx` keeps it that way.
 *
 * ## Why the picker is a SELECT and not a multiselect
 *
 * The operator asked for *"un multiselect common"* while `listClips` still
 * took `sources?: string[]`. It now takes ONE `provider` —
 * *"l'utilizzatore è uno solo"* [there is only one user] — and a multi-pick control over a
 * one-at-a-time argument offers a sum the hub cannot answer. So the control is
 * the shared single-choice one, `Select`: the same component the Recordings
 * page's own camera picker uses, which is what *"segue la nostra UI"* means
 * here.
 *
 * ## The control's value is ALWAYS what the query carries
 *
 * There is no "default" option and no empty value. This section used to send
 * no `provider` at all until the operator chose, because the cap documented
 * absence as "the device's bound provider, which is CamStack on every camera".
 * No code implemented that: measured on device 107 (2026-09-20, bound to
 * `recorder` AND `provider-reolink`) a bare `listClips` with `limit: 3`
 * answered SIX rows — three per source, merged — while the default option read
 * "CamStack recordings". The label named one thing and the query asked two.
 *
 * Naming a provider is now required (D554 amended), and the default is this surface's
 * to make: the FIRST source the camera lists, shown selected in the control, so
 * what is on screen and what was asked are the same fact. A camera that lists
 * no source is asked NOTHING — the query never fires and the body says nobody
 * answered, rather than spinning against a question with no addressee.
 *
 * ## One provider is a fleet STATE
 *
 * `listSources` derives from `deviceManager.getBindings`. A camera bound to one
 * provider makes the selector inert, and it SAYS why: an empty or silently
 * single-entry control would read as a defect.
 */
import { useEffect, useMemo, useState, type JSX } from 'react'
import { Clapperboard, Film } from 'lucide-react'
import type { CamProfile, Clip } from '@camstack/types'
import {
  usePipelineAnalyticsGetEventDensity,
  useVideoclipsListClips,
  useVideoclipsListSources,
} from '../../generated/system-hooks.js'
import { useUiText } from '../../contexts/ui-text.js'
import { useCapabilityPresence } from '../../hooks/use-capability-presence.js'
import { Button } from '../../primitives/button.js'
import { Select, type SelectOption } from '../../primitives/select.js'
import { Skeleton } from '../../primitives/skeleton.js'
import {
  bucketMsForSpan,
  dayWindow,
  densityRowsToBuckets,
  type DayWindow,
} from '../cap-settings/recording-timeline-model.js'
import { Pagination } from '../device-list/pagination.js'
import { EmptyState } from '../empty-state.js'
import { ErrorBox } from '../error-box.js'
import { ClipBandBar } from './ClipBandBar.js'
import { ClipPanel } from './ClipPanel.js'
import { ClipTile } from './ClipTile.js'
import { bandForSelection, formatBandLabel, planClipBand } from './clip-band.js'
import type { ClipSourceNotice } from './clip-source-state.js'
import { resolveClipsView } from './clip-view-state.js'

/** Newest-first, and bounded: a busy day on 592 lists 546 clips. */
const CLIP_PAGE_LIMIT = 500
/** Tiles per page. The rest are a `Pagination` click away, never dropped. */
const TILES_PER_PAGE = 60

export interface ClipsSectionProps {
  readonly deviceId: number
}

/** The sources that contributed NOTHING to what is on screen, and why. */
function SilentSources({ silent }: { readonly silent: readonly ClipSourceNotice[] }) {
  const t = useUiText()
  if (silent.length === 0) return null
  return (
    <ErrorBox
      variant="warning"
      title={t(
        'uiLibrary.clipsSection.silentSources',
        {
          one: 'One source contributed nothing to this list',
          other: '{{count}} sources contributed nothing to this list',
        },
        { count: silent.length },
      )}
      message={
        <div className="space-y-1">
          {silent.map((notice) => (
            <div key={notice.source}>
              <span className="font-medium">{notice.label}</span>
              <span className="opacity-70"> ({notice.source})</span>
              <div>{notice.headline}</div>
              {notice.detail === null ? null : (
                <div className="opacity-80 break-words">{notice.detail}</div>
              )}
            </div>
          ))}
        </div>
      }
    />
  )
}

export function ClipsSection({ deviceId }: ClipsSectionProps): JSX.Element | null {
  const t = useUiText()
  // The band's state, and the ONLY copy of it. `ClipBandBar` is
  // presentational: a bar that kept its own day or its own selection would be
  // a second authority on the period, one component below the query that has
  // to spell it.
  const [day, setDay] = useState<Date>(() => new Date())
  const [view, setView] = useState<DayWindow>(() => dayWindow(new Date(), Date.now()))
  const [selectedBucket, setSelectedBucket] = useState<number | null>(null)
  // WHICH provider is being asked, once the operator has said. The empty
  // string is "he has not said yet" — never a value that travels: the query
  // carries `askedProvider` below, which falls back to the camera's FIRST
  // listed source. An absent argument is refused by the cap (D554 amended).
  const [provider, setProvider] = useState<string>('')
  const [page, setPage] = useState(1)
  const [selectedClip, setSelectedClip] = useState<Clip | null>(null)
  const [profile, setProfile] = useState<CamProfile>('low')

  // D315: the registry is ASKED, and all four answers are rendered. A
  // `boolean` can carry two of them, and the one it drops — "the query has not
  // answered" — is what an operator sees first. Collapsing it says in words
  // that a component is not installed while it is installed and running.
  const presence = useCapabilityPresence('videoclips')

  // The day the window lives inside — the clamp every zoom and pan obeys, and
  // the reason a band can never be wider than one calendar day today.
  const dayBounds = useMemo(() => dayWindow(day, Date.now()), [day])
  const bucketMs = bucketMsForSpan(view.toMs - view.fromMs)

  // The heatmap is what makes a PERIOD selectable: a bar is a bucket, and a
  // bucket is the narrow band. It is read over the whole visible window, not
  // over the band, because its job is to show where to select NEXT.
  const density = usePipelineAnalyticsGetEventDensity({
    deviceId,
    since: view.fromMs,
    until: view.toMs,
    bucketMs,
  })
  const buckets = useMemo(
    () => densityRowsToBuckets(density.data ?? [], view.fromMs, bucketMs),
    [density.data, view.fromMs, bucketMs],
  )
  // Selection is by logical bucket index, stable across a background refetch,
  // because the bucket array is sparse (the recording timeline's own rule).
  const selected =
    selectedBucket === null ? undefined : buckets.find((b) => b.index === selectedBucket)

  const band = useMemo(
    () =>
      bandForSelection(
        view,
        selected === undefined ? null : { startMs: selected.startMs, endMs: selected.endMs },
      ),
    [view, selected],
  )
  const plan = planClipBand(band)

  const sources = useVideoclipsListSources({ deviceId })
  const sourceRows = sources.data ?? []
  /**
   * The provider the list is ASKED of: the operator's pick, else the first
   * source the camera lists. Empty only while the camera has no source at all
   * — and then nothing is asked, because there is nobody to ask.
   */
  const askedProvider = useMemo<string>(() => {
    if (provider !== '') return provider
    return sourceRows.find((row) => row.addonId !== undefined)?.addonId ?? ''
  }, [provider, sourceRows])

  const clips = useVideoclipsListClips(
    {
      deviceId,
      since: band.fromMs,
      until: band.toMs,
      limit: CLIP_PAGE_LIMIT,
      // Required (D554 amended). Never a source id: the argument names the ADDON that
      // answers (D557, amended).
      provider: askedProvider,
    },
    // A band past the bound is never ASKED. The refusal is rendered instead;
    // firing it and showing whichever days answered is the partial range
    // dressed as the whole one (`clip-band.ts`). Nor is a camera with no
    // source to name: an unanswerable question is not asked.
    { enabled: plan.kind === 'askable' && askedProvider !== '' },
  )

  const clipsView = resolveClipsView(
    {
      plan,
      provider: askedProvider === '' ? null : askedProvider,
      clipsStatus: clips.status,
      clips: clips.data ?? [],
      sourcesStatus: sources.status,
      sources: sourceRows,
      ...(clips.error ? { clipsError: clips.error.message } : {}),
      ...(sources.error ? { sourcesError: sources.error.message } : {}),
    },
    t,
  )

  // One option per PROVIDER, labelled by the sources it serves — an addon may
  // serve several of a camera's sources and the argument names the addon, so
  // collapsing here is what keeps the control honest about what it sends.
  const options = useMemo<SelectOption[]>(() => {
    const byAddon = new Map<string, string[]>()
    for (const row of sourceRows) {
      const addonId = row.addonId
      if (addonId === undefined) continue
      const labels = byAddon.get(addonId)
      if (labels === undefined) byAddon.set(addonId, [row.label])
      else labels.push(row.label)
    }
    // One option per provider and nothing else. There is no "default" entry:
    // it used to carry the FIRST provider's label while sending no argument at
    // all, so on a two-provider camera the control said "CamStack recordings"
    // and the query asked both.
    return [...byAddon].map(([value, labels]) => ({ value, label: labels.join(' · ') }))
  }, [sourceRows])
  // A new band is a new list: page 1, always. Keyed on the band's own bounds
  // so every path that moves it (day, zoom, pan, bucket) resets once.
  useEffect(() => {
    setPage(1)
  }, [band.fromMs, band.toMs])

  const handleDayChange = (next: Date): void => {
    setDay(next)
    setView(dayWindow(next, Date.now()))
    setSelectedBucket(null)
  }
  const handleViewChange = (next: DayWindow): void => {
    setView(next)
    setSelectedBucket(null)
  }
  const handleSelectBucket = (index: number): void => {
    setSelectedBucket((current) => (current === index ? null : index))
  }
  const pick = (next: string): void => {
    setProvider(next)
    setPage(1)
  }

  if (presence === 'pending') {
    return (
      <div className="space-y-2">
        <div role="status" className="text-xs text-foreground-subtle">
          {t(
            'uiLibrary.clipsSection.asking',
            'Asking the registry whether this cluster serves clips…',
          )}
        </div>
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }
  if (presence === 'unknown') {
    return (
      <ErrorBox
        variant="warning"
        title={t('uiLibrary.clipsSection.unknownTitle', 'Clip sources unknown')}
        message={t(
          'uiLibrary.clipsSection.unknownMessage',
          'The capability registry could not be reached, so whether this camera has clip sources is unknown — not absent.',
        )}
      />
    )
  }
  if (presence === 'absent') {
    return (
      <div role="status">
        <EmptyState
          icon={Clapperboard}
          title={t(
            'uiLibrary.clipsSection.absentTitle',
            'No provider of videoclips in this cluster',
          )}
          description={t(
            'uiLibrary.clipsSection.absentDescription',
            "Nothing is installed that could list a camera's stored clips.",
          )}
        />
      </div>
    )
  }

  const visible = clipsView.kind === 'listed' ? clipsView.clips : []
  const pageClips = visible.slice((page - 1) * TILES_PER_PAGE, page * TILES_PER_PAGE)

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">
          {t('uiLibrary.clipsSection.clips', 'Clips')}
        </h3>
        <p className="mt-1 text-[11px] text-foreground-subtle">
          {t(
            'uiLibrary.clipsSection.intro',
            "Every source this camera has, side by side — CamStack's own recordings and whatever the camera or an export keeps of its own. A source is listed because it exists, not because it was switched on here; pick sources to narrow the view.",
          )}
        </p>
        <p className="mt-1 text-[11px] text-foreground-subtle">
          {t(
            'uiLibrary.clipsSection.periodHint',
            "The list follows the period selected on the timebar below — the recording section's own control. Zoom out to widen it, pan or pick a day to move it, click a density bar to narrow it to that window.",
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor="clips-provider"
          className="text-[10px] uppercase tracking-wide text-foreground-subtle"
        >
          {t('uiLibrary.clipsSection.source', 'Source')}
        </label>
        <div className="w-60">
          <Select
            id="clips-provider"
            options={options}
            value={askedProvider}
            disabled={options.length < 2}
            onChange={(e) => pick(e.target.value)}
          />
        </div>
        {options.length < 2 ? (
          // Not an empty control and not a defect: `listSources` derives from
          // `getBindings`, and this camera is bound to exactly one provider
          // today. Saying so is the difference between a fleet state and a
          // surface that looks broken.
          <span className="text-[11px] text-foreground-subtle">
            {t(
              'uiLibrary.clipsSection.oneProvider',
              'This camera is bound to one clip provider today.',
            )}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {/* The band, spelled out beside the list it produced. Every state
              below names it too — this is the one an operator reads while the
              list is still arriving. */}
          <span className="px-1 text-xs font-medium text-foreground">{formatBandLabel(band)}</span>
          {selectedBucket === null ? null : (
            // "Espandibile", concretely: the picked bucket is released back to
            // the whole visible window. Widening PAST the window is the
            // timebar's own zoom-out, which is why there is no second widener
            // here.
            <Button variant="outline" onClick={() => setSelectedBucket(null)}>
              {t('uiLibrary.clipsSection.expand', 'Expand to the visible window')}
            </Button>
          )}
        </div>
      </div>

      <ClipBandBar
        day={day}
        onDayChange={handleDayChange}
        view={view}
        dayBounds={dayBounds}
        onViewChange={handleViewChange}
        buckets={buckets}
        selectedBucketIndex={selectedBucket}
        onSelectBucket={handleSelectBucket}
        densityLoading={density.status === 'pending'}
      />

      {/* The per-source diagnostics TABLE (Source / State / Reason / Catalog
          read) was removed on 2026-09-21: *"non è necessaria e confusa"*.
          It restated, as four columns on every camera, what the body already
          says in context — and on a fleet where most cameras legitimately hold
          no clips of a given kind it read as a wall of faults.

          Nothing was lost. A source that contributed NOTHING is still named,
          with its own words, by `SilentSources` below — next to the list it is
          missing from, which is the only place that reading means anything.
          `describeSource` is unchanged and still feeds it. */}

      <section aria-label={t('uiLibrary.clipsSection.clips', 'Clips')} className="space-y-2">
        {clipsView.kind === 'refused' ? (
          // Nothing was asked, so there is nothing to spin. The band and both
          // numbers are on screen because the operator's only move is to
          // narrow it, and a refusal that does not say by how much cannot be
          // acted on.
          <ErrorBox
            variant="warning"
            title={t('uiLibrary.clipsSection.tooWideTitle', 'That period is too wide to list')}
            message={t(
              'uiLibrary.clipsSection.tooWideMessage',
              '{{band}} covers {{days}} local days, and a clip listing is asked one local day at a time — at most {{max}}. Nothing was asked for; narrow the band and the list follows it.',
              {
                band: formatBandLabel(clipsView.band),
                days: clipsView.localDays,
                max: clipsView.maxLocalDays,
              },
            )}
          />
        ) : clipsView.kind === 'loading' ? (
          <>
            <div role="status" className="text-xs text-foreground-subtle">
              {t('uiLibrary.clipsSection.loadingFor', 'Loading clips for {{band}}…', {
                band: formatBandLabel(band),
              })}
            </div>
            <Skeleton className="h-24 w-full" />
          </>
        ) : clipsView.kind === 'failed' ? (
          <ErrorBox
            title={t('uiLibrary.clipsSection.listFailed', 'The clip list could not be read')}
            message={clipsView.message}
          />
        ) : clipsView.kind === 'empty' ? (
          <>
            <div role="status">
              <EmptyState
                icon={Film}
                title={
                  clipsView.nobodyAnswered
                    ? t(
                        'uiLibrary.clipsSection.noSourceAnswered',
                        'No source could answer for {{band}}',
                        { band: formatBandLabel(clipsView.band) },
                      )
                    : t('uiLibrary.clipsSection.noClips', 'No clips in {{band}}', {
                        band: formatBandLabel(clipsView.band),
                      })
                }
                {...(clipsView.nobodyAnswered
                  ? {}
                  : {
                      description: t('uiLibrary.clipsSection.asked', 'Asked {{sources}}.', {
                        sources: clipsView.answered.map((notice) => notice.label).join(', '),
                      }),
                    })}
              />
            </div>
            <SilentSources silent={clipsView.silent} />
          </>
        ) : (
          <>
            <SilentSources silent={clipsView.silent} />
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {pageClips.map((clip) => (
                <ClipTile
                  key={`${clip.source}:${clip.id}`}
                  clip={clip}
                  selected={selectedClip?.id === clip.id}
                  onSelect={setSelectedClip}
                />
              ))}
            </ul>
            <Pagination
              currentPage={page}
              totalItems={visible.length}
              pageSize={TILES_PER_PAGE}
              onPageChange={setPage}
              itemNoun={t('uiLibrary.clipsSection.itemNoun', 'clips')}
            />
          </>
        )}
      </section>

      {selectedClip === null ? null : (
        <ClipPanel
          deviceId={deviceId}
          clip={selectedClip}
          profile={profile}
          onProfileChange={setProfile}
        />
      )}
    </div>
  )
}
