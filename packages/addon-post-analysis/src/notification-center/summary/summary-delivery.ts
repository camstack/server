/**
 * A rendered digest, turned into ORDINARY outbox rows.
 *
 * The operator's standing constraint, verbatim: *"il modello di invio deve
 * essere lo stesso delle detection rules"* [the sending model must be the same as the detection rules]. So this module builds
 * `NcOutboxEnqueueInput`s and stops. Everything after is the path a detection
 * rule already takes — the durable row, the drain loop's backoff,
 * `NcDispatcher`, the degrade engine, `notification-output.send`. There is no
 * summary notifier, no summary send, no second delivery leg to keep in sync.
 *
 * Pure: no clock, no store, no I/O.
 *
 * ## `recordId` carries NO deviceId
 *
 * `summary:<ruleId>:<windowEndMs>`. The outbox dedup key is
 * `(ruleId, recordId, targetId)`, and a window is CROSS-CAMERA — one artefact,
 * one row per target. Putting a camera in the id would enqueue N copies of the
 * same mosaic, and a timestamp in it would double-send the moment a render was
 * retried.
 *
 * ## The text is written HERE, at enqueue
 *
 * Like the timelapse and unlike a detection rule: the frozen row then reads
 * exactly as it will be delivered, which is the property that makes a digest
 * checkable against history days later. The consequence, stated rather than
 * discovered: the LANGUAGE is frozen at enqueue too.
 */

import type { NcRuleTarget } from '@camstack/types'
import { ncClockText } from '../clock-text.js'
import { renderTemplate, templatePlaceholders } from '../render-template.js'
import type { NcOutboxEnqueueInput, NcOutboxPayload } from '../outbox.js'
import type { NcTextCatalog } from '../text-catalog.js'
import { type DetectionCounts, detectionTemplateVars } from '../timelapse/detection-counts.js'
import type { ClosedWindow } from '../timelapse/window-bounds.js'
import type { NcSummaryTemplate } from './summary-rule.js'

const NO_DETECTIONS: DetectionCounts = { total: 0, byClass: {}, classes: [] }

/** Punctuation, not prose — a module constant rather than a catalog key,
 *  because a translator has nothing to say about it and every key the guard
 *  has to check is a key somebody can get wrong. */
const BODY_SEPARATOR = ' · '

/** The already-public link to a published artefact. */
export interface SummaryArtifactRef {
  readonly url: string
  readonly mime: string
  readonly name: string
}

export interface SummaryDeliveryInput {
  readonly texts: NcTextCatalog
  readonly ruleId: string
  readonly ruleName: string
  readonly window: ClosedWindow
  /** Every camera the RULE covers — not only the ones that produced a tile. */
  readonly deviceIds: readonly number[]
  /**
   * The camera the outbox row is filed under.
   *
   * A digest spans cameras and the row needs exactly one, so this is the first
   * camera of the rule — stable across windows, which keeps the per-device
   * history of a rule from scattering across whichever camera happened to be
   * busiest that night.
   */
  readonly primaryDeviceId: number
  readonly targets: readonly NcRuleTarget[]
  readonly disabledTargetIds?: readonly string[]
  readonly priority: number
  /** Tiles actually rendered into the mosaic. */
  readonly tileCount: number
  /** Cameras that contributed at least one tile. */
  readonly cameraCount: number
  /** Candidates the window held after filtering — `tileCount` when nothing was cut. */
  readonly matchedCount: number
  /** Per-class counts over the SAME tracks the tiles came from. */
  readonly detections?: DetectionCounts
  /** Absent when no reachable public link could be minted — still delivered. */
  readonly mosaic?: SummaryArtifactRef
  /** Tap-through for the recipient (session-gated route), never an attachment. */
  readonly clickUrl?: string
  readonly generatedAt: number
  readonly template?: NcSummaryTemplate
  /**
   * The model's account of the window (#35 P2).
   *
   * ABSENT is the ordinary case and must stay indistinguishable from P1: the
   * AI pass fails open, so every unreachable model, every cold start and every
   * rule with `ai` switched off arrives here with nothing — and the body it
   * produces has to be byte-for-byte the one this file produced before P2, or
   * "fail open" is a claim rather than a behaviour.
   */
  readonly aiText?: string
}

/** `HH:MM` in the host timezone. */
function clockOf(atMs: number): string {
  const d = new Date(atMs)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Template vocabulary. Deliberately the SAME names the detection and timelapse
 *  bodies use (`rule`, `from`, `to`, `time`) plus the digest-only ones.
 *
 * Exported as `summaryTemplateVars` — not just an implementation detail of
 * {@link buildSummaryOutboxInputs} — so the parity spec
 * (`template-var-parity.spec.ts`) can assert this map directly against the
 * catalog, the same way `buildTemplateVars` is asserted for rule rows. */
export function summaryTemplateVars(input: SummaryDeliveryInput): Readonly<Record<string, string>> {
  return {
    rule: input.ruleName,
    from: clockOf(input.window.startMs),
    to: clockOf(input.window.endMs),
    // In the NOTIFICATION language, exactly like the rule family's `{{time}}`
    // (`buildTemplateVars`) — the catalog declares ONE `time` for all three
    // families, so the three producers must mean the same thing by it.
    time: ncClockText(input.texts.language, input.generatedAt),
    events: String(input.tileCount),
    cameras: String(input.cameraCount),
    matched: String(input.matchedCount),
    shown: String(input.tileCount),
    total: String(input.matchedCount),
    ai: aiSentence(input),
    ...detectionTemplateVars(input.texts, input.detections ?? NO_DETECTIONS),
  }
}

/** The model's sentence, or `''`. Whitespace is NOT a sentence: a model that
 *  satisfied its schema with spaces must not put a blank line on a phone. */
function aiSentence(input: SummaryDeliveryInput): string {
  return input.aiText?.trim() ?? ''
}

/**
 * Where the model's sentence goes.
 *
 * Three cases, and the third is the one that would otherwise be reported as a
 * bug:
 *
 *  - no sentence  → the P1 body, unchanged, on one line.
 *  - no custom template → the sentence LEADS, counts underneath. It is the part
 *    worth reading, and the counts are the part you check afterwards.
 *  - a custom template that never names `{{ai}}` → APPENDED on its own line.
 *    Every template authored before P2 is in this case, and an operator who
 *    switches AI on and sees nothing change has a feature that looks broken.
 *    A template that DOES name `{{ai}}` placed it deliberately and is left
 *    exactly as written.
 */
function composeSummaryBody(input: {
  readonly aiText: string
  readonly renderedTemplateBody: string | null
  readonly derivedBody: string
  readonly templateNamesAi: boolean
}): string {
  const custom = input.renderedTemplateBody
  if (input.aiText.length === 0) return custom ?? input.derivedBody
  if (custom === null) return `${input.aiText}\n${input.derivedBody}`
  return input.templateNamesAi ? custom : `${custom}\n${input.aiText}`
}

/**
 * The body an operator reads when he did not write one.
 *
 * Every clause is a catalog key with real CLDR plurals rather than a template
 * string, for the reason the timelapse learned: a hand-rolled `n === 1` shipped
 * "1 intervalli ripresi" to a live phone.
 */
function derivedBody(input: SummaryDeliveryInput, vars: Readonly<Record<string, string>>): string {
  const texts = input.texts
  const parts = [texts.text({ key: 'summary.body.window', vars })]
  if (input.tileCount === 0) {
    parts.push(texts.text({ key: 'summary.body.empty', vars }))
    return parts.filter((p) => p.length > 0).join(BODY_SEPARATOR)
  }
  parts.push(texts.text({ key: 'summary.body.events', count: input.tileCount, vars }))
  parts.push(texts.text({ key: 'summary.body.cameras', count: input.cameraCount, vars }))
  const counted = input.detections ?? NO_DETECTIONS
  if (counted.total > 0) parts.push(texts.text({ key: 'summary.body.detections', vars }))
  // Only when the budget actually bit. A digest that always says "showing 9 of
  // 9" trains the reader to skip the line beside it.
  if (input.matchedCount > input.tileCount) {
    parts.push(texts.text({ key: 'summary.body.truncated', vars }))
  }
  return parts.filter((p) => p.length > 0).join(BODY_SEPARATOR)
}

/** Per-target params with the derived `clickUrl` filled in where absent. A
 *  value the operator set on the target WINS — he chose it. */
function paramsFor(
  target: NcRuleTarget,
  clickUrl: string | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (clickUrl === undefined) return target.params
  if (target.params === undefined) return { clickUrl }
  if (typeof target.params['clickUrl'] === 'string') return target.params
  return { ...target.params, clickUrl }
}

/** Stable, retry-safe outbox record id for one closed window of one rule. */
export function summaryRecordId(ruleId: string, windowEndMs: number): string {
  return `summary:${ruleId}:${windowEndMs}`
}

/** The caption burned onto the mosaic's title band, with the same `{{var}}`
 *  vocabulary the title and body use. `''` is a real answer ("no caption"). */
export function summaryCaptionText(input: {
  readonly captionText?: string
  readonly ruleName: string
  readonly window: ClosedWindow
}): string {
  if (input.captionText === undefined) {
    return `${input.ruleName} — ${clockOf(input.window.startMs)}→${clockOf(input.window.endMs)}`
  }
  return (
    renderTemplate(input.captionText, {
      rule: input.ruleName,
      from: clockOf(input.window.startMs),
      to: clockOf(input.window.endMs),
    }) ?? ''
  )
}

/**
 * One outbox row per (still-enabled) target.
 *
 * @returns rows ready for `NcOutbox.enqueue` — never sent from here.
 */
export function buildSummaryOutboxInputs(
  input: SummaryDeliveryInput,
): readonly NcOutboxEnqueueInput[] {
  const vars = summaryTemplateVars(input)
  const optedOut = new Set(input.disabledTargetIds ?? [])
  const title =
    renderTemplate(input.template?.title, vars) ?? input.texts.text({ key: 'summary.title', vars })
  const body = composeSummaryBody({
    aiText: aiSentence(input),
    renderedTemplateBody: renderTemplate(input.template?.body, vars),
    derivedBody: derivedBody(input, vars),
    templateNamesAi: templatePlaceholders(input.template?.body ?? '').includes('ai'),
  })
  const recordId = summaryRecordId(input.ruleId, input.window.endMs)
  const artifacts =
    input.mosaic !== undefined ? [{ mediaType: 'image' as const, ...input.mosaic }] : []

  return input.targets
    .filter((t) => !optedOut.has(t.targetId))
    .map((target) => {
      const payload: NcOutboxPayload = {
        ruleName: input.ruleName,
        delivery: 'ai-summary',
        priority: input.priority,
        // Fully rendered here, so the dispatcher's own `{{}}` pass is a no-op.
        template: { title, body },
        // A digest owns no event and no track, so there is no media ladder to
        // climb. Asking for one would log "no still could be resolved" on every
        // delivery — a real signal turned into noise.
        media: 'none',
        ...(artifacts.length > 0 ? { artifacts } : {}),
        ...(paramsFor(target, input.clickUrl) !== undefined
          ? { params: paramsFor(target, input.clickUrl) }
          : {}),
        subject: {
          deviceId: input.primaryDeviceId,
          className: 'summary',
          zones: [],
          timestamp: input.window.endMs,
        },
      }
      return {
        ruleId: input.ruleId,
        targetId: target.targetId,
        deviceId: input.primaryDeviceId,
        recordKind: 'ai-summary' as const,
        recordId,
        payload,
      }
    })
}
