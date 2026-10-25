/**
 * Pure, caps-driven composer for the notification test panel (T15).
 *
 * The panel renders EXACTLY the controls a kind's `TargetKind.caps`
 * advertises, and sends a canonical `Notification` sample gated by those
 * same caps. Both the "which controls" decision (`visibleControls`) and
 * the "what gets sent" assembly (`composeTestSample`) live here as pure
 * functions so they can be exhaustively unit-tested over the real kind
 * descriptors without mounting React or touching the network.
 *
 * The composer applies the SAME capability gates the degrade engine would
 * (filter attachments to `mediaTypes`, cap counts to `max`/`actions`,
 * null out `clickUrl`/`sound`/`ttl` when the flag is false, clamp format
 * to `caps.format`) so the operator sees the honest payload before the
 * server-side degrade engine ever runs — the `renderedAs` report then
 * confirms what actually happened on the wire.
 */
import type {
  Attachment,
  AttachmentMediaType,
  Notification,
  NotificationAction,
  NotificationFormat,
  TargetKindCaps,
  TargetKindLevel,
} from '@camstack/types'
import { hubPath } from '../../lib/mount'
import i18n from '../../i18n/index'

/** One editable action row in the panel. */
export interface TestActionDraft {
  readonly label: string
  readonly url: string
}

/**
 * The mutable form the panel drives. Every field is present regardless of
 * caps; `composeTestSample` is responsible for dropping anything the kind
 * does not support, so the panel can keep a single stable state shape.
 */
export interface TestFormState {
  /** Selected kind-native level id (`caps.levels[].id`), or `''` for none. */
  readonly level: string
  /** Ordinal priority slider value (1..5). */
  readonly priority: number
  readonly format: NotificationFormat
  readonly title: string
  readonly body: string
  /** One URL per media type (only the kind's supported types are read). */
  readonly attachmentUrls: Partial<Record<AttachmentMediaType, string>>
  readonly actions: readonly TestActionDraft[]
  readonly clickUrl: string
  readonly sound: string
  /** TTL in seconds, as typed (empty string = unset). */
  readonly ttl: string
  readonly tag: string
}

/** The render descriptor: exactly which controls the panel should show. */
export interface VisibleControls {
  readonly levels: readonly TargetKindLevel[]
  readonly formats: readonly NotificationFormat[]
  readonly bodyMaxLen: number
  /** Media-type URL slots to render (the kind's `mediaTypes`). */
  readonly attachmentSlots: readonly AttachmentMediaType[]
  readonly attachmentMode: TargetKindCaps['attachments']['mode']
  readonly attachmentMax: number
  readonly attachmentMaxBytes?: number
  readonly maxActions: number
  readonly showActions: boolean
  readonly showClickUrl: boolean
  readonly showSound: boolean
  readonly showTtl: boolean
  /**
   * `tag` has no dedicated cap flag — it's a universal dedup hint that
   * every kind accepts or silently ignores, so it's always offered.
   */
  readonly showTag: boolean
}

/**
 * The presets an OPERATOR needs, phrased as the questions they actually have:
 * "does this target deliver a picture / an animation / a video / buttons",
 * plus the two engineering probes.
 *
 * The previous set (`minimal` / `everything` / `overflow` / `critical`) was QA
 * vocabulary — `everything` was the only path that attached anything at all,
 * and it attached `https://example.com/sample.*`, the IANA reserved
 * documentation domain, which serves no media. So no media test in the product
 * had ever verified anything.
 *
 * `overflow` is retained but marked advanced: deliberately sending an
 * over-length body is a real check of the degrade engine, and a useless first
 * thing to hand a new operator.
 */
export type TestPresetId =
  | 'text'
  | 'image'
  | 'gif'
  | 'video'
  | 'audio'
  | 'actions'
  | 'critical'
  | 'overflow'

const NON_EMPTY = (s: string | undefined): s is string => typeof s === 'string' && s.length > 0

/** Which controls a kind's caps expose. */
export function visibleControls(caps: TargetKindCaps): VisibleControls {
  return {
    levels: caps.levels,
    formats: caps.format,
    bodyMaxLen: caps.bodyMaxLen,
    attachmentSlots: caps.attachments.mediaTypes,
    attachmentMode: caps.attachments.mode,
    attachmentMax: caps.attachments.max,
    attachmentMaxBytes: caps.attachments.maxBytes,
    maxActions: caps.actions,
    showActions: caps.actions > 0,
    showClickUrl: caps.clickUrl,
    showSound: caps.sound,
    showTtl: caps.ttl,
    showTag: true,
  }
}

/** Clamp a chosen format to the kind's supported set (first supported wins). */
function resolveFormat(caps: TargetKindCaps, format: NotificationFormat): NotificationFormat {
  if (caps.format.includes(format)) return format
  return caps.format[0] ?? 'text'
}

/** Build the attachment list gated by `mediaTypes` + `max`. */
function resolveAttachments(
  caps: TargetKindCaps,
  urls: Partial<Record<AttachmentMediaType, string>>,
): Attachment[] {
  const out: Attachment[] = []
  for (const mediaType of caps.attachments.mediaTypes) {
    if (out.length >= caps.attachments.max) break
    const url = urls[mediaType]
    if (NON_EMPTY(url)) out.push({ mediaType, url })
  }
  return out
}

/** Build the action list gated by `caps.actions`. */
function resolveActions(
  caps: TargetKindCaps,
  drafts: readonly TestActionDraft[],
): NotificationAction[] {
  if (caps.actions <= 0) return []
  const out: NotificationAction[] = []
  for (const draft of drafts) {
    if (out.length >= caps.actions) break
    const hasLabel = NON_EMPTY(draft.label)
    const hasUrl = NON_EMPTY(draft.url)
    if (!hasLabel && !hasUrl) continue
    out.push({
      id: `test-${out.length + 1}`,
      label: hasLabel
        ? draft.label
        : i18n.t('helpers.notificationTestComposer.actionN', { n: out.length + 1 }),
      ...(hasUrl ? { url: draft.url } : {}),
    })
  }
  return out
}

/**
 * Assemble the canonical `Notification` the panel will send, applying every
 * capability gate so what the operator sees is what travels the wire.
 */
export function composeTestSample(caps: TargetKindCaps, form: TestFormState): Notification {
  const level = caps.levels.some((l) => l.id === form.level) ? form.level : undefined
  const attachments = resolveAttachments(caps, form.attachmentUrls)
  const actions = resolveActions(caps, form.actions)
  const ttlSeconds = caps.ttl && NON_EMPTY(form.ttl) ? Number(form.ttl) : undefined

  const sample: Notification = {
    body: form.body,
    format: resolveFormat(caps, form.format),
    priority: clampPriority(form.priority),
    ...(NON_EMPTY(form.title) ? { title: form.title } : {}),
    ...(level ? { level } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(actions.length > 0 ? { actions } : {}),
    ...(caps.clickUrl && NON_EMPTY(form.clickUrl) ? { clickUrl: form.clickUrl } : {}),
    ...(caps.sound && NON_EMPTY(form.sound) ? { sound: form.sound } : {}),
    ...(ttlSeconds !== undefined && Number.isFinite(ttlSeconds) ? { ttl: ttlSeconds } : {}),
    ...(NON_EMPTY(form.tag) ? { tag: form.tag } : {}),
  }
  return sample
}

function clampPriority(p: number): number {
  if (!Number.isFinite(p)) return 3
  return Math.min(5, Math.max(1, Math.round(p)))
}

/** The critical-most declared level (explicit `flags.critical`, else highest ordinal). */
export function criticalLevel(caps: TargetKindCaps): TargetKindLevel | undefined {
  const flagged = caps.levels.find((l) => l.flags?.critical === true)
  if (flagged) return flagged
  const ordered = caps.levels
    .filter((l): l is TargetKindLevel & { ordinal: number } => typeof l.ordinal === 'number')
    .sort((a, b) => b.ordinal - a.ordinal)
  return ordered[0]
}

/** An empty form seeded to the kind's first supported format. */
export function emptyForm(caps: TargetKindCaps): TestFormState {
  return {
    level: '',
    priority: 3,
    format: caps.format[0] ?? 'text',
    title: '',
    body: '',
    attachmentUrls: {},
    actions: [],
    clickUrl: '',
    sound: '',
    ttl: '',
    tag: '',
  }
}

/**
 * Sample media SERVED BY THE NOTIFIERS ADDON, not by a third party.
 *
 * Root-relative on purpose: the server fetches these itself when it resolves a
 * `needsFetch` attachment, so they must resolve against the hub — and they must
 * work on an install with no internet, which is the normal case for an NVR.
 *
 * These paths mirror `sampleUrlFor` in
 * `packages/addon-notifiers/src/sample-routes.ts`. That module's own test pins
 * the same strings, so the two sides are pinned against each other rather than
 * only documented.
 */
const SAMPLE_URLS: Record<AttachmentMediaType, string> = {
  image: hubPath('/addon/notifiers/samples/image'),
  video: hubPath('/addon/notifiers/samples/video'),
  gif: hubPath('/addon/notifiers/samples/gif'),
  audio: hubPath('/addon/notifiers/samples/audio'),
  icon: hubPath('/addon/notifiers/samples/icon'),
}

/** `true` when the kind can carry this media type at all. */
function supportsMedia(caps: TargetKindCaps, mediaType: AttachmentMediaType): boolean {
  return caps.attachments.max > 0 && caps.attachments.mediaTypes.includes(mediaType)
}

/**
 * Which presets are worth offering for a kind. A preset that the kind cannot
 * honour is not shown at all — offering "With video" on a target that declares
 * no video support teaches the operator that the product is broken when it is
 * the target that is limited.
 */
export function availablePresets(caps: TargetKindCaps): readonly TestPresetId[] {
  const out: TestPresetId[] = ['text']
  for (const mediaType of ['image', 'gif', 'video', 'audio'] as const) {
    if (supportsMedia(caps, mediaType)) out.push(mediaType)
  }
  if (caps.actions > 0) out.push('actions')
  if (caps.levels.length > 0) out.push('critical')
  out.push('overflow')
  return out
}

/** Presets kept out of the default view — engineering probes, not first-run. */
export const ADVANCED_PRESETS: ReadonlySet<TestPresetId> = new Set<TestPresetId>(['overflow'])

/** A single-media preset: one attachment of `mediaType`, if the kind takes it. */
function mediaPreset(
  caps: TargetKindCaps,
  mediaType: AttachmentMediaType,
  body: string,
): TestFormState {
  const base = emptyForm(caps)
  if (!supportsMedia(caps, mediaType)) return { ...base, body }
  return { ...base, body, attachmentUrls: { [mediaType]: SAMPLE_URLS[mediaType] } }
}

/**
 * Build one of the canned presets, gated by caps so a preset never sets a
 * control the kind doesn't have. Pure — the panel calls it to seed state.
 */
export function buildPreset(caps: TargetKindCaps, preset: TestPresetId): TestFormState {
  const base = emptyForm(caps)
  switch (preset) {
    case 'text':
      return {
        ...base,
        title: 'CamStack', // i18n-ignore: brand name
        body: i18n.t('helpers.notificationTestComposer.presetText'),
      }

    case 'image':
      return mediaPreset(caps, 'image', i18n.t('helpers.notificationTestComposer.presetImage'))
    case 'gif':
      return mediaPreset(caps, 'gif', i18n.t('helpers.notificationTestComposer.presetGif'))
    case 'video':
      return mediaPreset(caps, 'video', i18n.t('helpers.notificationTestComposer.presetVideo'))
    case 'audio':
      return mediaPreset(caps, 'audio', i18n.t('helpers.notificationTestComposer.presetAudio'))

    case 'actions': {
      // Action targets are intentionally the hub's own UI: an action button
      // that opens a page the operator recognises proves the button arrived
      // AND that its URL survived, without depending on an external site.
      const actions: TestActionDraft[] = Array.from({ length: caps.actions }, (_v, i) => ({
        label: i18n.t('helpers.notificationTestComposer.actionN', { n: i + 1 }),
        url: '/',
      }))
      return {
        ...base,
        title: 'CamStack', // i18n-ignore: brand name
        body: i18n.t('helpers.notificationTestComposer.presetActions'),
        actions,
        ...(caps.clickUrl ? { clickUrl: '/' } : {}),
      }
    }

    case 'critical': {
      const lvl = criticalLevel(caps)
      return {
        ...base,
        title: 'CamStack', // i18n-ignore: brand name
        body: i18n.t('helpers.notificationTestComposer.presetCritical'),
        priority: 5,
        level: lvl?.id ?? '',
      }
    }

    case 'overflow':
      // Deliberately over the kind's limit — the point is to SEE the degrade
      // engine truncate it and report `truncated` in `renderedAs`.
      return { ...base, body: 'X'.repeat(caps.bodyMaxLen + 50) }
  }
}
