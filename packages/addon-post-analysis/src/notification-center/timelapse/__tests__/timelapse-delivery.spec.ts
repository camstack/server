/**
 * Timelapse delivery — the outbox rows a finished render produces.
 *
 * The operator's constraint, verbatim: "il modello di invio deve essere lo
 * stesso delle detection rules, niente da reinventare per quanto riguarda
 * l'invio ai notifiers" [the sending model must be the same as the detection rules, nothing to reinvent regarding sending to the notifiers]. So this builds ORDINARY `NcOutboxEnqueueInput`s —
 * same durable row, same drain loop, same dispatcher, same degrade engine,
 * same notifier. Nothing here talks to a notifier.
 */
import { describe, expect, it } from 'vitest'
import { NcTextCatalog } from '../../text-catalog.js'
import type { TimelapseTrackInterval } from '../dense-ranges.js'
import { countDetections } from '../detection-counts.js'
import { footageCoverage } from '../footage-coverage.js'
import type { TimelapseDeliveryInput } from '../timelapse-delivery.js'
import { buildTimelapseOutboxInputs, timelapsePreviewText } from '../timelapse-delivery.js'

const WINDOW = { startMs: Date.UTC(2026, 0, 5, 22), endMs: Date.UTC(2026, 0, 6, 6) }

/** Same rule as {@link timelapse-delivery.ts} `clockOf` — host-local wall clock. */
function windowClock(atMs: number): string {
  const d = new Date(atMs)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const WINDOW_FROM = windowClock(WINDOW.startMs)
const WINDOW_TO = windowClock(WINDOW.endMs)

/** Three people, two vehicles, one animal — the same fixture the counts spec
 *  uses, so the two files cannot drift on what "the night held" means. */
const NIGHT: readonly TimelapseTrackInterval[] = [
  { firstSeen: 1, lastSeen: 2, className: 'person' },
  { firstSeen: 1, lastSeen: 2, className: 'person' },
  { firstSeen: 1, lastSeen: 2, className: 'person' },
  { firstSeen: 1, lastSeen: 2, className: 'vehicle' },
  { firstSeen: 1, lastSeen: 2, className: 'vehicle' },
  { firstSeen: 1, lastSeen: 2, className: 'animal' },
]

function makeInput(over: Partial<TimelapseDeliveryInput> = {}): TimelapseDeliveryInput {
  return {
    // Italian, because that is what this body used to be hard-coded in — the
    // assertions below are the equivalence proof for the rewiring.
    texts: new NcTextCatalog({ language: 'it' }),
    ruleId: 'tl-1',
    ruleName: 'Notte retro',
    deviceId: 1441,
    deviceName: 'Camera retro',
    window: WINDOW,
    targets: [{ targetId: 'zentik-alice' }],
    priority: 3,
    coverage: footageCoverage(
      [{ startMs: WINDOW.startMs, endMs: WINDOW.endMs }],
      WINDOW.startMs,
      WINDOW.endMs,
    ),
    artifact: {
      url: 'https://hub.example/addon/pipeline-analytics/nc-artifact/a1.mp4?exp=1&sig=x',
      mime: 'video/mp4',
      name: 'timelapse-1441.mp4',
    },
    exportId: 'exp-9',
    denseRanges: 3,
    generatedAt: WINDOW.endMs + 300_000,
    ...over,
  }
}

describe('buildTimelapseOutboxInputs', () => {
  it('produces one ordinary outbox row per target', () => {
    const rows = buildTimelapseOutboxInputs(
      makeInput({ targets: [{ targetId: 't1' }, { targetId: 't2' }] }),
    )
    expect(rows.map((r) => r.targetId)).toEqual(['t1', 't2'])
    expect(rows.every((r) => r.ruleId === 'tl-1')).toBe(true)
    expect(rows.every((r) => r.deviceId === 1441)).toBe(true)
  })

  it('keys the row on (rule, device, window) so a retry can never double-send', () => {
    // The outbox dedup id is `(ruleId, recordId, targetId)`. Making `recordId`
    // the window close means a second tick that re-renders the SAME window
    // after a partial failure re-enqueues nothing.
    const rows = buildTimelapseOutboxInputs(makeInput())
    const again = buildTimelapseOutboxInputs(makeInput({ generatedAt: WINDOW.endMs + 900_000 }))
    expect(rows[0]?.recordId).toBe(again[0]?.recordId)
    expect(rows[0]?.recordId).toContain('1441')
    expect(rows[0]?.recordId).toContain(String(WINDOW.endMs))
  })

  it('carries the video as an already-public artifact, not as bytes on the row', () => {
    // A durable JSON row must never hold an mp4. The URL is the artefact-plane
    // link the dispatcher already knows how to attach.
    const [row] = buildTimelapseOutboxInputs(makeInput())
    expect(row?.payload.artifacts?.[0]?.url).toContain('nc-artifact')
    expect(row?.payload.artifacts?.[0]?.mediaType).toBe('video')
    expect(JSON.stringify(row).length).toBeLessThan(4000)
  })

  it('asks for NO event media — a timelapse has no track and no snapshot to ladder to', () => {
    const [row] = buildTimelapseOutboxInputs(makeInput())
    expect(row?.payload.media).toBe('none')
    expect(row?.payload.mediaClip).toBeUndefined()
    expect(row?.payload.mediaGif).toBeUndefined()
  })

  it('freezes a complete body that names the camera and the window', () => {
    const [row] = buildTimelapseOutboxInputs(makeInput())
    expect(row?.payload.template?.title).toContain('Camera retro')
    expect(row?.payload.template?.body).toContain('Notte retro')
  })

  /**
   * COVERAGE IS NOT A NOTIFICATION, it is a log field.
   *
   * The sentence went out every night the recorder had stumbled at all, and it
   * had already fired at 100% once (2026-08-12: 35,858,961 / 36,000,000 ms is
   * `complete === false` and `Math.round(99.608) === 100`, so the body read
   * *"disponibile solo per il 100%"* [available only for 100%]). The operator's answer was to remove it
   * from the body outright — the figure still rides the `timelapse produced`
   * log line as `coveragePct`, where whoever is diagnosing a short video is
   * already looking.
   *
   * The `{{coverage}}` placeholder SURVIVES: an operator who writes his own
   * body is asking for it explicitly, which is a different act from a derived
   * sentence he never chose.
   */
  it('never mentions coverage in the derived body, however short the window', () => {
    for (const endMs of [
      WINDOW.startMs + 2 * 3600_000, // 25% — visibly short
      WINDOW.endMs - 288_000, // 99% — short past the slack
      WINDOW.endMs - 141_039, // rounds up to 100%
      WINDOW.endMs, // complete
    ]) {
      const coverage = footageCoverage(
        [{ startMs: WINDOW.startMs, endMs }],
        WINDOW.startMs,
        WINDOW.endMs,
      )
      const [row] = buildTimelapseOutboxInputs(makeInput({ coverage }))
      expect(row?.payload.template?.body).not.toContain('%')
      expect(row?.payload.template?.body).not.toContain('ATTENZIONE')
      expect(row?.payload.template?.body).not.toContain('WARNING')
    }
  })

  /**
   * The operator's ask: *"come per le altre rule"* [as for the other rules] — a detection rule's card
   * shows a picture, a timelapse's showed only text.
   */
  it('carries the preview still AND the video, image first', () => {
    const [row] = buildTimelapseOutboxInputs(
      makeInput({
        preview: {
          url: 'https://hub.example/addon/pipeline-analytics/nc-artifact/p1.jpg?exp=1&sig=y',
          mime: 'image/jpeg',
          name: 'timelapse-preview.jpg',
        },
      }),
    )
    expect(row?.payload.artifacts?.map((a) => a.mediaType)).toEqual(['image', 'video'])
    expect(row?.payload.artifacts?.[0]?.url).toContain('p1.jpg')
    expect(row?.payload.artifacts?.[1]?.url).toContain('a1.mp4')
  })

  it('ships the video alone when no preview could be made', () => {
    const [row] = buildTimelapseOutboxInputs(makeInput())
    expect(row?.payload.artifacts?.map((a) => a.mediaType)).toEqual(['video'])
  })

  it('carries no artifacts key at all when the render published nothing', () => {
    const [row] = buildTimelapseOutboxInputs(makeInput({ artifact: undefined }))
    expect(row?.payload.artifacts).toBeUndefined()
  })

  it('says so when the dense plan was dropped for the range ceiling', () => {
    const [row] = buildTimelapseOutboxInputs(makeInput({ denseRanges: 0, denseCapped: true }))
    expect(row?.payload.template?.body?.toLowerCase()).toContain('uniform')
  })

  it('APPENDS the detection summary to the derived body, when there was something', () => {
    // The operator's ask: the card should say what the night held. Appended and
    // not prefixed, so the line an operator already knows how to read (rule —
    // from→to) still leads.
    const [row] = buildTimelapseOutboxInputs(
      makeInput({ detections: countDetections({ tracks: NIGHT }) }),
    )
    expect(row?.payload.template?.body).toContain('3 persone, 2 veicoli e 1 animale')
    expect(row?.payload.template?.body?.startsWith('Notte retro — ')).toBe(true)
  })

  it('says NOTHING about detections on a night that held none', () => {
    // A nightly "0 rilevamenti" is a line nobody reads, which makes every other
    // line in the body slightly less likely to be read too.
    const [row] = buildTimelapseOutboxInputs(
      makeInput({ denseRanges: 0, detections: countDetections({ tracks: [] }) }),
    )
    expect(row?.payload.template?.body).toBe(`Notte retro — ${WINDOW_FROM}→${WINDOW_TO}`)
  })

  it('appends NOTHING when the operator wrote his own body — he owns the text', () => {
    const [row] = buildTimelapseOutboxInputs(
      makeInput({
        detections: countDetections({ tracks: NIGHT }),
        template: { body: 'solo questo' },
      }),
    )
    expect(row?.payload.template?.body).toBe('solo questo')
  })

  it('resolves the detection placeholders in an operator template', () => {
    const [row] = buildTimelapseOutboxInputs(
      makeInput({
        detections: countDetections({ tracks: NIGHT }),
        template: {
          title: '{{camera}}: {{detections}}',
          body: '{{detectionSummary}} · p={{count_person}} v={{count_vehicle}}',
        },
      }),
    )
    expect(row?.payload.template?.title).toBe('Camera retro: 6')
    expect(row?.payload.template?.body).toBe('3 persone, 2 veicoli e 1 animale · p=3 v=2')
  })

  it('renders the detection placeholders EMPTY rather than literal when nothing was counted', () => {
    // A card reading "{{detections}}" is worse than one reading nothing.
    const [row] = buildTimelapseOutboxInputs(
      makeInput({ template: { body: 'x{{detections}}y{{detectionSummary}}z' } }),
    )
    expect(row?.payload.template?.body).toBe('x0yz')
  })

  it('honours an operator template over the derived text', () => {
    const [row] = buildTimelapseOutboxInputs(
      makeInput({ template: { title: 'TL {{camera}}', body: 'copertura {{coverage}}' } }),
    )
    expect(row?.payload.template?.title).toBe('TL Camera retro')
    expect(row?.payload.template?.body).toBe('copertura 100')
  })

  it('defaults the preview caption to the camera name and renders {{camera}}', () => {
    expect(timelapsePreviewText({ deviceId: 1441, deviceName: 'Camera retro' })).toBe(
      'Timelapse Camera retro',
    )
  })

  it('honours an operator caption, including the empty one', () => {
    expect(
      timelapsePreviewText({ deviceId: 1441, deviceName: 'retro', text: '{{camera}} — notte' }),
    ).toBe('retro — notte')
    expect(timelapsePreviewText({ deviceId: 1441, deviceName: 'retro', text: '' })).toBe('')
  })

  it('falls back to `camera <id>` when no display name resolved', () => {
    expect(timelapsePreviewText({ deviceId: 1441 })).toBe('Timelapse camera 1441')
  })

  it('passes the rule priority and the per-target params through untouched', () => {
    const [row] = buildTimelapseOutboxInputs(
      makeInput({ priority: 5, targets: [{ targetId: 't1', params: { sound: 'gong' } }] }),
    )
    expect(row?.payload.priority).toBe(5)
    expect(row?.payload.params).toEqual({ sound: 'gong' })
  })

  it('drops a target the rule owner opted out of', () => {
    const rows = buildTimelapseOutboxInputs(
      makeInput({
        targets: [{ targetId: 't1' }, { targetId: 't2' }],
        disabledTargetIds: ['t1'],
      }),
    )
    expect(rows.map((r) => r.targetId)).toEqual(['t2'])
  })

  it('puts the video link on clickUrl so tapping the notification opens it', () => {
    const [row] = buildTimelapseOutboxInputs(
      makeInput({ clickUrl: 'https://hub.example/addon/recorder/exports/exp-9.mp4' }),
    )
    expect(row?.payload.params?.['clickUrl']).toBe(
      'https://hub.example/addon/recorder/exports/exp-9.mp4',
    )
  })

  it('never overrides a clickUrl the operator set on the target', () => {
    const [row] = buildTimelapseOutboxInputs(
      makeInput({
        clickUrl: 'https://hub.example/exports/exp-9.mp4',
        targets: [{ targetId: 't1', params: { clickUrl: 'https://mine' } }],
      }),
    )
    expect(row?.payload.params?.['clickUrl']).toBe('https://mine')
  })

  it('still delivers when there is no artifact — a render that produced no link is still news', () => {
    const rows = buildTimelapseOutboxInputs(makeInput({ artifact: undefined }))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.payload.artifact).toBeUndefined()
  })
})

/**
 * The derived body, in BOTH languages and clause by clause.
 *
 * The Italian assertions are the equivalence proof: every one of these
 * sentences was hard-coded Italian in this file before the catalog, so an
 * identical string means the rewiring changed nothing an operator will notice.
 * The two exceptions are deliberate and asserted as such — the dense-range
 * clause is now plural-correct at 1, and the class list uses the language's own
 * conjunction instead of a comma.
 *
 * The English ones are the point of the exercise: the same body, in a language
 * this notification could not previously be delivered in at all.
 */
describe('the derived body, per language', () => {
  const PARTIAL = footageCoverage(
    [{ startMs: WINDOW.startMs, endMs: WINDOW.startMs + 2 * 3600_000 }],
    WINDOW.startMs,
    WINDOW.endMs,
  )
  const bodyOf = (over: Partial<TimelapseDeliveryInput>): string =>
    buildTimelapseOutboxInputs(makeInput(over))[0]?.payload.template?.body ?? ''

  it('the whole body — window, dense ranges and counts, and NOTHING about coverage', () => {
    const over = { coverage: PARTIAL, detections: countDetections({ tracks: NIGHT }) }
    expect(bodyOf(over)).toBe(
      `Notte retro — ${WINDOW_FROM}→${WINDOW_TO} · 3 intervalli ripresi a cadenza fitta · 3 persone, 2 veicoli e 1 animale`,
    )
    expect(bodyOf({ ...over, texts: new NcTextCatalog() })).toBe(
      `Notte retro — ${WINDOW_FROM}→${WINDOW_TO} · 3 stretches filmed at a dense cadence · 3 people, 2 vehicles, and 1 animal`,
    )
  })

  it('the dense-range clause is SINGULAR at one — the hard-coded line said "1 intervalli"', () => {
    expect(bodyOf({ denseRanges: 1 })).toContain('1 intervallo ripreso a cadenza fitta')
    expect(bodyOf({ denseRanges: 1, texts: new NcTextCatalog() })).toContain(
      '1 stretch filmed at a dense cadence',
    )
  })

  it('the too-many-events clause replaces the dense one, in both languages', () => {
    expect(bodyOf({ denseCapped: true })).toContain(
      'troppi eventi per il campionamento denso: video a cadenza uniforme',
    )
    expect(bodyOf({ denseCapped: true, texts: new NcTextCatalog() })).toContain(
      'too many events for dense sampling: video at a uniform cadence',
    )
  })

  it('the title is the camera, in both languages', () => {
    const titleOf = (texts: NcTextCatalog): string =>
      buildTimelapseOutboxInputs(makeInput({ texts }))[0]?.payload.template?.title ?? ''
    expect(titleOf(new NcTextCatalog({ language: 'it' }))).toBe('Timelapse — Camera retro')
    expect(titleOf(new NcTextCatalog())).toBe('Timelapse — Camera retro')
  })

  it('a hub OVERRIDE reaches the derived body', () => {
    expect(
      bodyOf({
        texts: new NcTextCatalog({
          language: 'it',
          overrides: { it: { 'timelapse.body.window': '{{camera}} · {{from}}-{{to}}' } },
        }),
      }),
    ).toContain(`Camera retro · ${WINDOW_FROM}-${WINDOW_TO}`)
  })
})
