/**
 * Timelapse delivery — a finished render, turned into ORDINARY outbox rows.
 *
 * The operator's constraint, verbatim: *"il modello di invio deve essere lo
 * stesso delle detection rules, niente da reinventare per quanto riguarda
 * l'invio ai notifiers"* [the sending model must be the same as the detection rules, nothing to reinvent regarding sending to the notifiers]. So this module builds `NcOutboxEnqueueInput`s and
 * stops. Everything after that is the path a detection rule already takes:
 * the durable row, the drain loop's backoff, `NcDispatcher`, the degrade
 * engine, `notification-output.send`. There is no timelapse notifier, no
 * timelapse send, no second delivery leg to keep in sync.
 *
 * Pure — no clock, no store, no I/O. `generatedAt` and the coverage figure are
 * supplied by the caller.
 *
 * Two decisions worth the words:
 *
 *  - `recordId` is `timelapse:<deviceId>:<windowEndMs>`. The outbox dedup key
 *    is `(ruleId, recordId, targetId)`, so THAT is what makes a retry safe: a
 *    second attempt at the same closed window re-enqueues nothing, whatever
 *    the row's status. A timestamp-based id would double-send the moment a
 *    render was retried.
 *
 *  - The video rides as an artifact URL, never as bytes. The outbox row is
 *    durable JSON in SQLite; an mp4 on it would be a multi-megabyte row
 *    rewritten on every delivery attempt.
 */

import type { NcRuleTarget, TimelapseTemplate } from '@camstack/types'
import { DEFAULT_TIMELAPSE_PREVIEW_TEXT } from '@camstack/types'
import { ncClockText } from '../clock-text.js'
import { renderTemplate } from '../dispatcher.js'
import type { NcOutboxEnqueueInput, NcOutboxPayload } from '../outbox.js'
import type { NcTextCatalog } from '../text-catalog.js'
import { type DetectionCounts, detectionTemplateVars } from './detection-counts.js'
import type { FootageCoverage } from './footage-coverage.js'
import type { ClosedWindow } from './window-bounds.js'

/** What a caller that counted nothing looks like — so `{{detections}}` renders
 *  `0` and `{{detectionSummary}}` renders empty, never the literal braces. */
const NO_DETECTIONS: DetectionCounts = { total: 0, byClass: {}, classes: [] }

/**
 * What joins the derived body's clauses.
 *
 * A module constant and not a catalog key on purpose: it is punctuation, not
 * prose. A translator has nothing to say about it, and every key the guard has
 * to check is a key somebody can get wrong.
 */
const BODY_SEPARATOR = ' · '

/** The already-public link to the rendered video (artifact plane). */
export interface TimelapseArtifactRef {
  readonly url: string
  readonly mime: string
  readonly name: string
}

export interface TimelapseDeliveryInput {
  /**
   * Every word this delivery can print, in the hub's language AT ENQUEUE.
   *
   * The timelapse is the one notification rendered before the row is written
   * rather than at send time, and that is deliberate: the row's `template` is
   * what the dispatcher reads, so the frozen row says exactly what will be
   * delivered — a property worth keeping, because a night's video is the one
   * notification an operator goes back and checks against history. The
   * consequence, stated rather than discovered: the LANGUAGE is frozen at
   * enqueue too. A hub switched from Italian to English at midnight delivers
   * the 23:00 window in Italian.
   */
  readonly texts: NcTextCatalog
  readonly ruleId: string
  readonly ruleName: string
  readonly deviceId: number
  /** Display name, already resolved. Falls back to `camera <id>` when absent. */
  readonly deviceName?: string
  readonly window: ClosedWindow
  readonly targets: readonly NcRuleTarget[]
  /** Target ids the rule owner opted out of (same semantics as `NcRule`). */
  readonly disabledTargetIds?: readonly string[]
  readonly priority: number
  readonly coverage: FootageCoverage
  /** Absent when the render produced no reachable link — still delivered. */
  readonly artifact?: TimelapseArtifactRef
  /**
   * Captioned still for the notification card, published on the same artifact
   * plane as {@link TimelapseDeliveryInput.artifact}.
   *
   * The operator's ask, verbatim: the timelapse must carry a preview image
   * *"come per le altre rule"* [as for the other rules]. Independent of the video: a preview that could
   * not be produced never costs the video, and vice versa.
   */
  readonly preview?: TimelapseArtifactRef
  /**
   * Tap-through link to the rendered video.
   *
   * Distinct from {@link TimelapseDeliveryInput.artifact}, and both are worth
   * having: an ATTACHMENT is fetched by the notifier BACKEND (so it must be
   * publicly reachable), while `clickUrl` is opened by the RECIPIENT, in an
   * app or browser where they already hold a session. The export's own
   * download route is served `access: 'authenticated'`, which makes it a
   * perfectly good `clickUrl` and a useless attachment URL.
   */
  readonly clickUrl?: string
  readonly exportId: string
  /** How many dense ranges the plan carried (0 when uniform). */
  readonly denseRanges: number
  /** The plan exceeded the range ceiling and rendered at base cadence only. */
  readonly denseCapped?: boolean
  readonly generatedAt: number
  readonly template?: TimelapseTemplate
  /**
   * What the window CONTAINED, per class — aggregated from the tracks the
   * render already fetched for its dense plan (never a second query).
   *
   * Absent behaves as "nothing counted": the placeholders still resolve (to `0`
   * and to the empty string) and the derived body gains no line. Absent is
   * therefore always safe, which matters because a durable outbox row enqueued
   * by an older build carries no counts.
   */
  readonly detections?: DetectionCounts
}

/** What {@link timelapsePreviewText} needs, and no more. */
export interface TimelapsePreviewTextInput {
  readonly deviceId: number
  readonly deviceName?: string
  readonly ruleName?: string
  readonly window?: ClosedWindow
  /** The rule's caption. Absent ⇒ the default; `''` ⇒ no caption. */
  readonly text?: string
}

/** `HH:MM` in the host timezone — the two numbers a body actually needs. */
function clockOf(atMs: number): string {
  const d = new Date(atMs)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Template vocabulary. Deliberately the same NAMES the rule templates use
 *  (`camera`, `rule`, `time`) plus the timelapse-only ones.
 *
 * Exported as `timelapseTemplateVars` — not just an implementation detail of
 * {@link buildTimelapseOutboxInputs} — so the parity spec
 * (`template-var-parity.spec.ts`) can assert this map directly against the
 * catalog, the same way `buildTemplateVars` is asserted for rule rows. */
export function timelapseTemplateVars(
  input: TimelapseDeliveryInput,
): Readonly<Record<string, string>> {
  const deviceName = input.deviceName ?? `camera ${input.deviceId}`
  return {
    camera: deviceName,
    rule: input.ruleName,
    from: clockOf(input.window.startMs),
    to: clockOf(input.window.endMs),
    // In the NOTIFICATION language, exactly like the rule family's `{{time}}`
    // (`buildTemplateVars`) — the catalog declares ONE `time` for all three
    // families, so the three producers must mean the same thing by it.
    time: ncClockText(input.texts.language, input.generatedAt),
    coverage: String(input.coverage.percent),
    events: String(input.denseRanges),
    // `detections`, `detectionSummary`, `count_<class>` — one vocabulary for
    // title, body and preview text alike. `detectionSummary` is a COMPOSITE:
    // built from the class fragments and the language's own conjunction, then
    // injected here as a plain string.
    ...detectionTemplateVars(input.texts, input.detections ?? NO_DETECTIONS),
  }
}

/**
 * The body an operator reads when he did not author one.
 *
 * **No coverage sentence.** It used to end with one whenever the window was
 * short, and it was removed on the operator's instruction: the clause fired on
 * every night the recorder had stumbled at all — including once at a printed
 * *100%* (2026-08-12, device 101: 141 s missing out of 10 h, so the window was
 * incomplete while the rounded figure was 100) — and a line that cries wolf is
 * a line the reader skips, which costs the clauses beside it too. The figure
 * is not lost: it rides the `timelapse produced` log line as `coveragePct`,
 * which is where a short video is diagnosed, and `{{coverage}}` still resolves
 * for an operator who puts it in a body HE wrote.
 */
function derivedBody(
  input: TimelapseDeliveryInput,
  vars: Readonly<Record<string, string>>,
): string {
  const texts = input.texts
  const parts = [texts.text({ key: 'timelapse.body.window', vars })]
  if (input.denseCapped === true) {
    parts.push(texts.text({ key: 'timelapse.body.tooManyEvents', vars }))
  } else if (input.denseRanges > 0) {
    // Plural by the LANGUAGE's rules, which is why this is a catalog key and
    // not a template string: the hard-coded line said "1 intervalli ripresi".
    parts.push(texts.text({ key: 'timelapse.body.denseRanges', count: input.denseRanges, vars }))
  }
  // What the night HELD, when it held anything. Only non-zero: a nightly
  // "0 rilevamenti" is a line nobody reads, which makes the lines beside it
  // slightly less likely to be read too. An operator who wrote his own body
  // never reaches here — `{{detectionSummary}}` is how he asks for it.
  const counted = input.detections ?? NO_DETECTIONS
  if (counted.total > 0) parts.push(texts.text({ key: 'timelapse.body.detections', vars }))
  return parts.filter((part) => part.length > 0).join(BODY_SEPARATOR)
}

/** Per-target params with the derived `clickUrl` filled in where absent. */
function paramsFor(
  target: NcRuleTarget,
  clickUrl: string | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (clickUrl === undefined) return target.params
  if (target.params === undefined) return { clickUrl }
  if (typeof target.params['clickUrl'] === 'string') return target.params
  return { ...target.params, clickUrl }
}

/**
 * The caption for the preview frame, resolved.
 *
 * Lives here rather than in the renderer because it needs the DISPLAY NAME and
 * the same `{{var}}` vocabulary the title and body use — one templating
 * dialect for the whole notification, not two.
 *
 * An empty string is a real answer ("the frame, no caption") and is preserved;
 * only an ABSENT `text` falls back to {@link DEFAULT_TIMELAPSE_PREVIEW_TEXT}.
 */
export function timelapsePreviewText(input: TimelapsePreviewTextInput): string {
  const deviceName = input.deviceName ?? `camera ${input.deviceId}`
  const vars: Record<string, string> = {
    camera: deviceName,
    ...(input.ruleName !== undefined ? { rule: input.ruleName } : {}),
    ...(input.window !== undefined
      ? { from: clockOf(input.window.startMs), to: clockOf(input.window.endMs) }
      : {}),
  }
  const template = input.text ?? DEFAULT_TIMELAPSE_PREVIEW_TEXT
  // `renderTemplate` answers null for a blank template — which is exactly the
  // "no caption" answer, so it collapses to the empty string rather than to
  // the default.
  return renderTemplate(template, vars) ?? ''
}

/** Stable, retry-safe outbox record id for one (device, closed window). */
function timelapseRecordId(deviceId: number, windowEndMs: number): string {
  return `timelapse:${deviceId}:${windowEndMs}`
}

/**
 * One outbox row per (still-enabled) target.
 *
 * @returns rows ready for `NcOutbox.enqueue` — never sent from here.
 */
export function buildTimelapseOutboxInputs(
  input: TimelapseDeliveryInput,
): readonly NcOutboxEnqueueInput[] {
  const vars = timelapseTemplateVars(input)
  const optedOut = new Set(input.disabledTargetIds ?? [])
  const title =
    renderTemplate(input.template?.title, vars) ??
    input.texts.text({ key: 'timelapse.title', vars })
  const body = renderTemplate(input.template?.body, vars) ?? derivedBody(input, vars)
  const recordId = timelapseRecordId(input.deviceId, input.window.endMs)
  const artifacts = [
    ...(input.preview !== undefined ? [{ mediaType: 'image' as const, ...input.preview }] : []),
    ...(input.artifact !== undefined ? [{ mediaType: 'video' as const, ...input.artifact }] : []),
  ]

  return input.targets
    .filter((t) => !optedOut.has(t.targetId))
    .map((target) => {
      const payload: NcOutboxPayload = {
        ruleName: input.ruleName,
        delivery: 'timelapse',
        priority: input.priority,
        // Fully rendered here, so the dispatcher's own `{{}}` pass is a no-op
        // and the frozen row reads exactly as it will be delivered.
        template: { title, body },
        // A timelapse owns no event and no track, so there is no media ladder
        // to climb. Asking for one would log "no still could be resolved" on
        // every single delivery — a real signal, turned into noise.
        media: 'none',
        // IMAGE FIRST. A notifier that shows one attachment shows the first,
        // and a card with a picture is the whole point of the preview; the
        // video is what the recipient taps through to.
        ...(artifacts.length > 0 ? { artifacts } : {}),
        // `clickUrl` rides the per-target passthrough because that is where
        // `pickParams` already reads it from — no new dispatcher field. A
        // value the operator set on the target WINS: he chose it, and the
        // derived link is only a default.
        ...(paramsFor(target, input.clickUrl) !== undefined
          ? { params: paramsFor(target, input.clickUrl) }
          : {}),
        subject: {
          deviceId: input.deviceId,
          className: 'timelapse',
          zones: [],
          timestamp: input.window.endMs,
        },
      }
      return {
        ruleId: input.ruleId,
        targetId: target.targetId,
        deviceId: input.deviceId,
        recordKind: 'timelapse' as const,
        recordId,
        payload,
      }
    })
}
