/**
 * rule-kinds — WHICH KIND OF RULE THIS IS, WHICH FIELDS IT ACTUALLY HAS, AND
 * WHICH LIST SECTION IT LIVES IN. Pure, UI-framework-free, RN-safe.
 *
 * WHY IT LIVES HERE
 * ─────────────────
 * Two editors author the same rules — the admin UI (React DOM, shipped with
 * `camstack deploy`) and the viewer (React Native / Hermes, shipped by EAS OTA)
 * — and the layer they were NOT sharing is this one: not the schema (already
 * shared) and not the widgets (they cannot be), but the model in between.
 * The divergence it caused is on the record: the viewer filtered conditions on
 * the served `appliesTo` alone, so a viewer-authored occupancy rule was still
 * offered `sensorKinds`, `eventTypeTokens` and `source` — the exact "in
 * occupancy alcuni campi non hanno senso" [in occupancy some fields make no sense] failure the admin UI fixed on
 * 2026-08-14 and the viewer never got. Beside it, the viewer's rule list had no
 * sections and no seeded creates, so the two features that have no delivery of
 * their own (sound, occupancy) were unauthorable from the phone.
 *
 * The CONTENT is what makes a second copy expensive: a dozen exclusions, each
 * traced to a subject field the engine reads and finds absent, each carrying
 * the sentence shown to the operator. Two tables disagreeing about which fields
 * an occupancy rule has is the same failure as two knobs writing a store nobody
 * read.
 *
 * THE MISSING DIMENSION
 * ─────────────────────
 * The editor had exactly ONE dimension of applicability, the rule's `delivery`,
 * which the served catalog answers through `appliesTo`. Two features have no
 * delivery of their own:
 *
 *   - an OCCUPANCY rule is a `device-event` rule carrying `conditions.occupancy`
 *   - a SOUND rule is an `immediate` rule carrying `conditions.audio`
 *
 * and the engine discriminates them by that CONDITION (`rule-engine.ts`: an
 * occupancy edge fires only for a rule declaring `occupancy`, a confirmed audio
 * window only for one declaring `audio`). So an occupancy rule was offered the
 * whole `device-event` surface — sensor kinds, raw event tokens, a detection
 * source — every one of which the engine FAILS CLOSED on an occupancy subject,
 * because the subject carries no `sensorKind`, no `eventType` and always the
 * `pipeline` source.
 *
 * This module adds that dimension: `delivery` × `kind`. Visibility is the
 * COMPOSITION of the two — `appliesTo` still answers the trigger question (it is
 * the server's answer and stays authoritative), and the kind subtracts what the
 * sub-type cannot use. Every subtraction is declared WITH ITS REASON and the
 * reason is shown to the operator rather than kept in a comment.
 *
 * LABELS ARE ENGLISH FALLBACKS, NOT TRANSLATIONS. The stable thing here is the
 * ID (`kind`, section `key`, editor-section `key`); the admin UI renders these
 * strings verbatim, the viewer maps the ids onto its `v2.nc.rules.*` i18n keys
 * and falls back to them.
 *
 * BOTH EDITORS IMPORT THIS FILE. The admin UI kept a pinned local copy while
 * Phase 1 shipped; it was deleted in Phase 3 once the MF question was actually
 * answered rather than assumed. The admin UI is the module-federation HOST
 * (`packages/addon-admin-ui/vite.config.ts`: `federation({ name:
 * 'admin_ui_host', … shared: { '@camstack/types': { …, import: typesEsm } } })`)
 * — it PROVIDES the singleton, bundled from the workspace at build time, and
 * never consumes one from a server closure. The lag is real for addon widget
 * REMOTES, which declare the same package `import: false`
 * (`packages/addon-benchmark/vite.config.ts`) and therefore read whatever the
 * host loaded; nothing in this file is consumed that way. See
 * `docs/design/2026-08-19-viewer-notification-rule-parity.md` §3 and Phase 3.
 *
 * THREE SYSTEM KINDS, AND ONE THAT IS ONLY READ (D637)
 * ────────────────────────────────────────────────────
 * A `system-event` rule used to be ONE kind for every infrastructure event. It
 * is now one kind per family (`device-events`, `system`, `alarm`), DERIVED from
 * the event kinds the rule names (`system-event-families.ts`), exactly as sound
 * and occupancy are derived from their condition. A stored rule whose kinds span
 * families — or name a legacy kind, or none — derives `mixed`: it keeps firing,
 * it is listed and deletable, and it is never edited.
 */
import type { z } from 'zod'
import {
  type NcAudioCondition,
  type NcConditions,
  type NcDelivery,
  type NcOccupancyCondition,
  type NcRuleKindSchema,
} from '../capabilities/notification-rules.cap.js'
import { EVENTFUL_CAP_NAMES } from '../capabilities/sensor-event-kinds.js'
import { NC_AUDIO_DB_OFFERED, NC_AUDIO_DEFAULTS } from './audio-condition.js'
import {
  isSystemEventFamily,
  type NcSystemEventFamily,
  systemEventFamilyOf,
  systemEventKindNamesOf,
} from './system-event-families.js'

// ── The kind ────────────────────────────────────────────────────────

/**
 * The kind of rule an operator is authoring.
 *
 * Coarser than `delivery` in one direction and finer in another, deliberately:
 * `immediate` / `track-end` / `package-event` are ONE kind here (their
 * differences are already the catalog's `appliesTo` job), while `device-event`
 * and `immediate` each split in two on their discriminating condition, and
 * `system-event` splits by the FAMILY of the event kinds it names (D637).
 */
export type NcRuleKind = z.infer<typeof NcRuleKindSchema>

/** Every kind a `system-event` rule can derive — the three families and `mixed`. */
export const NC_SYSTEM_RULE_KINDS = [
  'device-events',
  'system',
  'alarm',
  'mixed',
] as const satisfies readonly NcRuleKind[]

/** Is this a kind a `system-event` rule derives (any family, or `mixed`)? */
export function isSystemRuleKind(kind: NcRuleKind | undefined): boolean {
  return NC_SYSTEM_RULE_KINDS.some((k) => k === kind)
}

/** The family a kind authors, or undefined (a camera kind, or `mixed`). */
export function systemFamilyOfKind(kind: NcRuleKind): NcSystemEventFamily | undefined {
  return isSystemEventFamily(kind) ? kind : undefined
}

export interface NcRuleKindSpec {
  readonly kind: NcRuleKind
  /** What the conditions section is CALLED for this kind (English fallback). */
  readonly label: string
  /**
   * The condition that MAKES a rule this kind. Always visible, and never
   * excluded — burying it would hide the whole feature (which is how an
   * operator with a working audio engine reported there was no way to create an
   * audio rule).
   *
   * NOT UNIQUE PER KIND. A GROUP of kinds may share one discriminator: the three
   * system families and `mixed` all ride `systemEvent` (D637), and which of them
   * a rule is comes from the event kinds, not from the condition's presence. A
   * consumer that maps a discriminator back to ONE kind (a `Map` keyed on it)
   * keeps the last spec and silently misroutes the others — ask
   * {@link kindsForDiscriminator} for the whole group.
   */
  readonly discriminator?: keyof NcConditions
  /**
   * Conditions the catalog offers for this kind's DELIVERY that a rule of this
   * kind cannot use, each with the engine reason — shown to the operator when a
   * save is about to drop one.
   */
  readonly excluded: Readonly<Record<string, string>>
  /**
   * false = readable and deletable, never edited. Only `mixed`: a rule that
   * predates D637 and spans families. It keeps firing; the operator recreates
   * it one rule per family.
   */
  readonly editable: boolean
  /**
   * Can a notification of this kind carry a picture AT ALL?
   *
   * `false` is not a UI preference, it is the delivery path: the attachment
   * ladder resolves media by OWNER, and only a subject that freezes one has any
   * (`triggerCanCarryStill` in the addon's `test-event.ts` is the same list).
   *
   * Only the system-event kinds are left. An infrastructure event is about no
   * camera at all — there is nothing to photograph, so every media control on it
   * is a knob that does nothing. A SOUND rule was here until 2026-08-15 and was right to be:
   * its subject is a sampling window that owns no frame. It now photographs the
   * camera at the match instead (`still-shelf.ts`), which is a picture nothing
   * else could give it.
   */
  readonly carriesMedia: boolean
  /**
   * Does anything about this kind's subject describe a REGION of the frame?
   *
   * `false` removes the two controls that cut one — the zone crop and the image
   * frame — because neither has an input. A sound was not boxed and carries no
   * zone condition to crop to, so `frame: 'cropped'` resolves nothing and
   * `zoneCrop` has no ids to use. Same argument as `excluded`, applied to the
   * media policy instead of the conditions: a knob that decides nothing is
   * worse than a missing one, because the operator sets it and believes they
   * have asked for something.
   */
  readonly carriesSubjectCrop: boolean
  /** One line under the section title — what this kind of rule IS. */
  readonly blurb?: string
  /** One line above the media controls, when the picture needs explaining. */
  readonly mediaBlurb?: string
}

/**
 * Reasons, written once. Each names the SUBJECT FIELD the engine reads and
 * finds absent — that is what makes the exclusion checkable against the engine
 * rather than an opinion about tidiness.
 */
const NO_SENSOR_KIND =
  'An occupancy edge is not a sensor event: it carries no sensor kind, so this condition can never match one.'
const NO_EVENT_TOKEN =
  'An occupancy edge carries no device event-type token — that comes from an event-emitter slice, which a count crossing has none of.'
const NO_SENSOR_EDGE =
  'An occupancy edge is a count crossing, not a sensor reading: it has no raise or clear, so this choice could never narrow it.'
const OCCUPANCY_SOURCE =
  'An occupancy edge is always produced by the pipeline, so any other source can never match and “pipeline” narrows nothing.'
const AUDIO_SOURCE =
  'A confirmed sound window is always stamped as an audio subject, so any other source can never match.'
const SOUND_NOT_A_PICTURE =
  'A sound rule fires on what the camera HEARD. Its subject carries no detection, so this condition can never match one — name the sounds in the Sound condition instead.'
const SOUND_NO_CONFIDENCE =
  'A sound window’s evidence is a percentage of samples, not a detector score, so a confidence threshold can never be satisfied.'
const SOUND_NO_GEOMETRY =
  'A sound has no position in the frame, so a zone or a drawn polygon can never match it.'
const DETECTION_NOT_A_SOUND =
  'A detection rule fires on what the camera SAW. Sounds are a Sound rule of their own — adding one here turned the rule into a sound rule and dropped every detection condition.'

export const NC_RULE_KIND_SPECS: readonly NcRuleKindSpec[] = [
  {
    kind: 'detection',
    label: 'Conditions',
    // `audio` is subtracted (R13, D690). It used to be offered as the way to
    // CONVERT a detection rule into a sound rule, and in practice it was the way
    // a detection rule broke itself: one click and every detection condition was
    // listed as what Save would drop. A sound rule is created from its own
    // section; the kind is chosen, not converted into.
    excluded: { audio: DETECTION_NOT_A_SOUND },
    editable: true,
    carriesMedia: true,
    carriesSubjectCrop: true,
  },
  {
    kind: 'sensor',
    label: 'Conditions',
    /** `occupancy` is still offered here: authoring it converts a sensor rule into an occupancy rule. */
    excluded: {},
    editable: true,
    carriesMedia: true,
    carriesSubjectCrop: true,
    blurb:
      'A doorbell press or a linked sensor changing state. The picture comes from the camera the sensor is attributed to.',
  },
  {
    kind: 'occupancy',
    label: 'Occupancy',
    discriminator: 'occupancy',
    excluded: {
      sensorKinds: NO_SENSOR_KIND,
      eventTypeTokens: NO_EVENT_TOKEN,
      sensorTransition: NO_SENSOR_EDGE,
      source: OCCUPANCY_SOURCE,
    },
    editable: true,
    carriesMedia: true,
    carriesSubjectCrop: true,
    blurb:
      'Fires when the count in a camera frame or a zone crosses your threshold and holds. Pick the camera first — the zone list is that camera’s.',
  },
  {
    kind: 'sound',
    label: 'Sound',
    discriminator: 'audio',
    excluded: {
      classes: SOUND_NOT_A_PICTURE,
      classesExclude: SOUND_NOT_A_PICTURE,
      minConfidence: SOUND_NO_CONFIDENCE,
      zones: SOUND_NO_GEOMETRY,
      zonesExclude: SOUND_NO_GEOMETRY,
      customZones: SOUND_NO_GEOMETRY,
      crossing: SOUND_NO_GEOMETRY,
      labelEquals: SOUND_NOT_A_PICTURE,
      identities: SOUND_NOT_A_PICTURE,
      identitiesExclude: SOUND_NOT_A_PICTURE,
      plates: SOUND_NOT_A_PICTURE,
      source: AUDIO_SOURCE,
    },
    editable: true,
    carriesMedia: true,
    carriesSubjectCrop: false,
    blurb:
      'Fires on a confirmed sampling window of audio, never on a picture. Name the sounds and/or keep a level threshold — with neither it can never match.',
    mediaBlurb:
      'A sound owns no frame, so the picture is a photograph of the camera taken at the moment of the match — the whole scene, never a crop. The GIF and the clip are cut around the same instant, from the camera.',
  },
  {
    kind: 'device-events',
    label: 'Device events',
    discriminator: 'systemEvent',
    excluded: {},
    editable: true,
    carriesMedia: false,
    carriesSubjectCrop: false,
    blurb:
      'A device or its stream going away or coming back, switched off or on, a battery or consumable running low, a camera detecting nothing. There is no frame to attach.',
  },
  {
    kind: 'system',
    label: 'System events',
    discriminator: 'systemEvent',
    excluded: {},
    editable: true,
    carriesMedia: false,
    carriesSubjectCrop: false,
    blurb:
      'The installation itself: a node leaving, an addon crash-looping, an update available or installed, a backup or an export finishing.',
  },
  {
    kind: 'alarm',
    label: 'Alarm',
    discriminator: 'systemEvent',
    excluded: {},
    editable: true,
    carriesMedia: false,
    carriesSubjectCrop: false,
    blurb:
      'The alarm panel: refused, arming, armed, entry delay, triggered, re-armed, sensor bypass, disarmed.',
    mediaBlurb:
      "An alarm set off by a rule arrives with THAT rule's pictures, combined into one notification. This rule adds none of its own.",
  },
  {
    kind: 'mixed',
    label: 'To recreate',
    discriminator: 'systemEvent',
    excluded: {},
    editable: false,
    carriesMedia: false,
    carriesSubjectCrop: false,
    blurb:
      'This rule mixes events from more than one family (device events, system, alarm). It keeps firing as it is, but it can no longer be edited: create one rule per family, then delete this one.',
  },
]

/** The spec for a kind. Total by construction — every member has an entry. */
export function ruleKindSpec(kind: NcRuleKind): NcRuleKindSpec {
  const found = NC_RULE_KIND_SPECS.find((s) => s.kind === kind)
  // `detection` is the fallback for the same reason `ruleMatchesSection` makes
  // it the catch-all: a rule must never end up with no editor.
  return found ?? NC_RULE_KIND_SPECS[0]!
}

/**
 * Every kind a discriminator makes — one kind for `audio` and `occupancy`, the
 * whole system group for `systemEvent`. Empty for a condition that makes no
 * kind. See {@link NcRuleKindSpec.discriminator}.
 */
export function kindsForDiscriminator(discriminator: keyof NcConditions): readonly NcRuleKind[] {
  return NC_RULE_KIND_SPECS.filter((s) => s.discriminator === discriminator).map((s) => s.kind)
}

/** The delivery a system rule rides — named once, compared everywhere. */
export const NC_SYSTEM_DELIVERY = 'system-event'

/**
 * Is this a SYSTEM rule — one about the installation rather than about anything
 * a camera saw? Takes a plain `string` so a rule carrying a delivery this build
 * has never heard of still gets an answer instead of a type error.
 */
export function isSystemDelivery(delivery: string): boolean {
  return delivery === NC_SYSTEM_DELIVERY
}

/**
 * The conditions of a rule, as much of them as classification needs.
 *
 * DELIBERATELY STRUCTURAL, and this is load-bearing. The viewer keeps its OWN
 * Zod mirror of the rule schema on purpose (older/newer hub tolerance —
 * `camstack/src/data/notification-center.ts`), so a parameter typed as THIS
 * package's `NcConditions` would be unusable from the surface this module was
 * hoisted for without a cast, and this repo does not take casts. Two optional
 * `unknown`s is the whole question the classifier asks.
 */
export interface NcRuleConditionsSubject {
  readonly occupancy?: unknown
  readonly audio?: unknown
  /**
   * EVERY OTHER CONDITION, admitted explicitly.
   *
   * Without it the two named keys make this a "weak type", and TypeScript's
   * excess-property check then rejects `{ classes: ['person'] }` written INLINE
   * while accepting the identical value read out of a variable. Both editors
   * write such literals — seeds, specs, the admin's section tests — so the
   * classifier's own shape has to say "the rest of the conditions ride along and
   * I do not read them" rather than let it depend on where the value came from.
   */
  readonly [conditionId: string]: unknown
}

/** Every authored condition, keyed by descriptor id — same reasoning as above. */
export type NcAuthoredConditions = Readonly<Record<string, unknown>>

/** What both the kind and the section ask a rule about. */
export interface NcRuleSectionSubject {
  readonly delivery: string
  readonly conditions: NcRuleConditionsSubject
}

/**
 * Which capability a device must carry to be OFFERED on a rule of this kind's
 * device-scope picker (operator ruling, 2026-10-01). `null` means "no
 * capability filter for this kind" — either every device applies (the system
 * families, each already a separate concern; see
 * `docs/architecture/notifications.md`'s D637 `deviceIds` table) or `mixed`,
 * which authors nothing.
 *
 * DERIVED, never a hand-picked list:
 *  - `sensor` reads `EVENTFUL_CAP_NAMES` — the SAME cap table the engine
 *    itself turns a linked device's bound caps into sensor event kinds with
 *    (`EVENT_KIND_BY_CAP`). A device this picker offers for a sensor rule is
 *    exactly a device the rule's `sensorKinds` condition could ever name.
 *  - `detection` (which a package-event rule is — there is no separate
 *    `package` kind, D637) / `occupancy` read the one pipeline cap a camera
 *    needs to produce the detections / counts / parcels those kinds match on.
 *  - `sound` reads the one cap a device needs to produce the audio metrics a
 *    sound rule's sampling window is built from.
 *  - `device-events` / `system` / `alarm` / `mixed` are `null`: a device
 *    event rule's `deviceIds` legitimately spans every device type (liveness,
 *    battery, consumable, `detection-blind`), a system rule has no device
 *    scope at all (dropped from the editor's tabs), and `alarm`'s `deviceIds`
 *    is a reference to whichever camera's rule set it off — not a scope this
 *    picker authors.
 *
 * Callers resolve the ids via `deviceManager.listDeviceIdsByCaps` (max 16
 * names — `EVENTFUL_CAP_NAMES` is exactly 16) and must treat an unanswered
 * read as "unknown", never as "no devices" (D315): this function only names
 * WHICH caps to ask for, not what to show while the answer is pending.
 */
export function ruleDeviceCompatCapNames(kind: NcRuleKind): readonly string[] | null {
  switch (kind) {
    case 'sensor':
      return EVENTFUL_CAP_NAMES
    case 'detection':
    case 'occupancy':
      return ['detection-pipeline']
    case 'sound':
      return ['audio-metrics']
    case 'device-events':
    case 'system':
    case 'alarm':
    case 'mixed':
      return null
  }
}

/**
 * The capability every CAMERA carries: `camera-streams` is a `defaultActive`
 * wrapper bound to every `Camera`-type device (`camera-streams.cap.ts`).
 * Named once, because a sensor rule's compatible set needs it (below).
 */
export const NC_CAMERA_SCOPE_CAP_NAME = 'camera-streams'

/**
 * Every capability QUERY whose union is the set of devices a rule of this kind
 * may be SCOPED to (`conditions.devices`) — what the save-time guard and the
 * admin's Devices tab ask `deviceManager.listDeviceIdsByCaps`, one call per
 * entry. `null` exactly where {@link ruleDeviceCompatCapNames} is `null`.
 *
 * Several queries rather than one list because `listDeviceIdsByCaps` takes at
 * most 16 names and `EVENTFUL_CAP_NAMES` is already exactly 16.
 *
 * A `sensor` rule's set is the eventful devices PLUS every camera (fix round
 * 1, 2026-10-01): the engine matches a sensor rule scoped to a CAMERA — a
 * per-camera row carries the camera's id, and a linked set matches on
 * `rowCameraIds` (D630 §6) — so a camera-scoped sensor rule is legitimate and
 * a guard that refused it would make every such stored rule un-editable.
 */
export function ruleDeviceCompatCapQueries(
  kind: NcRuleKind,
): readonly (readonly string[])[] | null {
  const primary = ruleDeviceCompatCapNames(kind)
  if (primary === null) return null
  return kind === 'sensor' ? [primary, [NC_CAMERA_SCOPE_CAP_NAME]] : [primary]
}

/**
 * Which kind of rule is this?
 *
 * The CONDITION wins over the delivery wherever the engine says it does, and
 * the order below is the engine's own: `evaluateRule` checks the system branch
 * first, then the occupancy and audio gates. Takes a plain `delivery` string so
 * a trigger this build does not know still classifies (as `detection`, which is
 * the read-only path's own fallback). A system rule classifies by the FAMILY of
 * its event kinds (D637) — see {@link systemRuleKindOf}.
 */
export function ruleKindOf(rule: NcRuleSectionSubject): NcRuleKind {
  if (isSystemDelivery(rule.delivery)) return systemRuleKindOf(rule.conditions.systemEvent)
  if (rule.conditions.occupancy !== undefined && rule.delivery === 'device-event') {
    return 'occupancy'
  }
  if (rule.conditions.audio !== undefined && rule.delivery === 'immediate') return 'sound'
  if (rule.delivery === 'device-event') return 'sensor'
  return 'detection'
}

/**
 * May this rule carry `groupingSec` (D692 §2.2)? Only an `immediate` DETECTION rule: a
 * track-end rule fires at close and already carries the name; a parcel, a sound (its
 * `trackId` is a photograph owner, not a subject), a sensor, an occupancy edge and every
 * system family have no subject to promote and no tile per subject. ONE predicate, read by
 * both editors and the hub's save guard.
 */
export function ruleGroupingApplies(rule: NcRuleSectionSubject): boolean {
  return rule.delivery === 'immediate' && ruleKindOf(rule) === 'detection'
}

/**
 * A system rule's kind: its one family, or `mixed` (D637).
 *
 * Takes the UNTYPED condition for the same reason {@link NcRuleConditionsSubject}
 * is structural. `mixed` covers kinds across families, a legacy or unknown kind,
 * and no kinds at all — it fails toward read-only, never toward editable.
 */
export function systemRuleKindOf(condition: unknown): NcSystemEventFamily | 'mixed' {
  const verdict = systemEventFamilyOf(systemEventKindNamesOf(condition) ?? [])
  return verdict.kind === 'family' ? verdict.family : 'mixed'
}

/**
 * The shape {@link conditionVisibleForKind} reads off a catalog descriptor.
 *
 * `appliesTo` is `readonly string[]`, not `readonly NcDelivery[]`: the catalog
 * arrives at RUNTIME from a server that may be newer than this build, and each
 * editor parses it through its own mirror. Narrowing the parameter to this
 * package's union would reject the viewer's descriptor for a nominal reason
 * while the value is identical.
 */
export interface NcKindVisibilitySubject {
  readonly id: string
  readonly appliesTo: readonly string[]
}

/**
 * Is this condition visible — and authorable — for a rule of this kind?
 *
 * The COMPOSITION, and the only function that decides it: `appliesTo` is the
 * server's answer about the trigger, the kind's `excluded` map is this build's
 * answer about the sub-type, and the discriminator overrides both (a sound rule
 * must be able to edit its sound even though `audio` is excluded for every
 * OTHER kind that rides `immediate`).
 */
export function conditionVisibleForKind(
  descriptor: NcKindVisibilitySubject,
  delivery: string,
  kind: NcRuleKind,
): boolean {
  const spec = ruleKindSpec(kind)
  if (descriptor.id === spec.discriminator) return true
  if (!descriptor.appliesTo.includes(delivery)) return false
  return spec.excluded[descriptor.id] === undefined
}

/** Why a condition is not offered for this kind, or `null` when it IS. */
export function conditionExclusionReason(descriptorId: string, kind: NcRuleKind): string | null {
  const spec = ruleKindSpec(kind)
  if (descriptorId === spec.discriminator) return null
  return spec.excluded[descriptorId] ?? null
}

/**
 * Conditions the rule CARRIES that this kind cannot use — the save will drop
 * them, and the operator is told which and why BEFORE pressing Save.
 *
 * Dropping is the right action and not a compromise: every entry here is a
 * condition the engine fails closed on for this subject, so the rule is
 * currently enabled, in the list, and permanently silent. Keeping it would keep
 * it silent; dropping it is what makes the rule fire again. Saying nothing
 * about the drop would be the third option, and it is the one this repo has
 * paid for before.
 */
export interface NcDroppedCondition {
  readonly conditionId: string
  readonly reason: string
}

export function droppedConditionsForKind(
  conditions: NcAuthoredConditions,
  kind: NcRuleKind,
): readonly NcDroppedCondition[] {
  const spec = ruleKindSpec(kind)
  const out: NcDroppedCondition[] = []
  for (const [conditionId, value] of Object.entries(conditions)) {
    if (value === undefined) continue
    if (Array.isArray(value) && value.length === 0) continue
    const reason = spec.excluded[conditionId]
    if (reason !== undefined) out.push({ conditionId, reason })
  }
  return out
}

// ── The list sections ───────────────────────────────────────────────

/**
 * The sections a rule LIST is split into.
 *
 * Operator request, 2026-08-13: "vorrei che le system rules fossero in una
 * sezione a parte, più facile da utilizzare, affianco alle detection rules" [I would like the system rules to be in a separate section, easier to use, next to the detection rules]. A
 * system rule and a detection rule share a store and nothing else — different
 * triggers, different conditions, no media, a different question ("is my
 * installation healthy?" vs "what did the camera see?").
 *
 * `all` is kept and is the DEFAULT: a section that hides rules is how an
 * operator concludes a rule was deleted. Which sections a given SURFACE offers
 * for authoring is that surface's decision — the viewer omits the system-event
 * sections from its create flow and still renders system rules under `all`.
 *
 * D637 split the one `system` section into the three families, plus `mixed`:
 * the stored system rules that span families. `mixed` is a real, owning section
 * (a rule must be listed somewhere) that nothing can CREATE into.
 */
export type NcRuleSectionKey =
  | 'all'
  | 'detection'
  | 'sensor'
  | 'audio'
  | 'occupancy'
  | 'device-events'
  | 'system'
  | 'alarm'
  | 'mixed'

export interface NcRuleSection {
  readonly key: NcRuleSectionKey
  /** English fallback; the viewer maps `key` onto an i18n key. */
  readonly label: string
  /** Shown under the section strip — what this section is for. */
  readonly blurb: string
  /** The create button's words in this section — it authors a DIFFERENT rule. */
  readonly newRuleLabel: string
  /** What the section says when it holds nothing yet. */
  readonly emptyHint: string
  /** Can a rule be CREATED from this section? false only for `mixed` (D637). */
  readonly creatable: boolean
}

export const NC_RULE_SECTIONS: readonly NcRuleSection[] = [
  {
    key: 'all',
    label: 'All rules',
    blurb:
      'Every notification rule, whatever its trigger. Each rule picks a trigger, matches conditions and fans out to one or more delivery targets.',
    newRuleLabel: 'New rule',
    emptyHint: 'No notification rules yet. Create one to be told what your cameras see.',
    creatable: true,
  },
  {
    key: 'detection',
    label: 'Detections',
    blurb: 'Rules driven by what the cameras SEE — detections, tracks and package events.',
    newRuleLabel: 'New detection rule',
    emptyHint: 'No detection rules yet. Create one to be told what your cameras see.',
    creatable: true,
  },
  {
    key: 'sensor',
    label: 'Sensors',
    blurb:
      'Rules driven by a device or sensor CHANGING STATE — a doorbell press, a linked sensor opening or closing. The picture comes from the camera the sensor is attributed to.',
    newRuleLabel: 'New sensor rule',
    emptyHint:
      'No sensor rules yet. Create one to be told when a doorbell is pressed or a linked sensor changes.',
    creatable: true,
  },
  {
    key: 'audio',
    label: 'Sound',
    blurb:
      'Rules on what the cameras HEAR: a sustained window of sound loud enough, or classified as one of the sounds you name. A sound rule fires only on a confirmed sampling window, never on a picture.',
    newRuleLabel: 'New sound rule',
    emptyHint:
      'No sound rules yet. A new sound rule opens on the sound condition already filled in with a level threshold, so you only have to name the sounds and the targets.',
    creatable: true,
  },
  {
    key: 'occupancy',
    label: 'Occupancy',
    blurb:
      'Rules on how many objects are in a camera frame or a zone, and for how long: "the driveway became occupied", "the garden emptied".',
    newRuleLabel: 'New occupancy rule',
    emptyHint:
      'No occupancy rules yet. A new occupancy rule opens on the occupancy condition; pick the camera first, then the zone and the count.',
    creatable: true,
  },
  {
    key: 'device-events',
    label: 'Device events',
    blurb:
      'Rules about your devices: offline or back, switched off or on, a stream dropping, a battery or consumable running low, a camera detecting nothing.',
    newRuleLabel: 'New device-event rule',
    emptyHint:
      'No device-event rules yet. These tell you when a device drops, a battery runs low or a camera goes blind.',
    creatable: true,
  },
  {
    key: 'system',
    label: 'System events',
    blurb:
      'Rules about the installation: a node leaving the cluster, an addon crash-looping, an update available or installed, a backup or export finishing.',
    newRuleLabel: 'New system rule',
    emptyHint:
      'No system rules yet. These tell you when a node leaves, an update lands or a backup finishes.',
    creatable: true,
  },
  {
    key: 'alarm',
    label: 'Alarm',
    blurb:
      'Rules about the alarm panel: arming, armed, triggered, disarmed, and the refusals in between.',
    newRuleLabel: 'New alarm rule',
    emptyHint: 'No alarm rules yet. These tell you when the alarm arms, goes off or is disarmed.',
    creatable: true,
  },
  {
    key: 'mixed',
    label: 'To recreate',
    blurb:
      'System rules authored before the three families existed. Each mixes families, keeps firing as it is, and can only be read or deleted: recreate it as one rule per family.',
    newRuleLabel: 'New rule',
    emptyHint: 'Nothing to recreate.',
    creatable: false,
  },
]

/** The section for a key, or `undefined` — the lookup behind every label. */
export function ruleSection(key: NcRuleSectionKey): NcRuleSection {
  return NC_RULE_SECTIONS.find((s) => s.key === key) ?? NC_RULE_SECTIONS[0]!
}

/** Narrow a raw section string back to a known key (no cast). */
export function parseRuleSection(value: string): NcRuleSectionKey | undefined {
  return NC_RULE_SECTIONS.find((s) => s.key === value)?.key
}

/** True for a rule whose sound condition makes it a SOUND rule. */
export function isAudioRule(subject: NcRuleSectionSubject): boolean {
  return subject.conditions.audio !== undefined
}

/** True for a rule whose occupancy condition makes it an OCCUPANCY rule. */
export function isOccupancyRule(subject: NcRuleSectionSubject): boolean {
  return subject.conditions.occupancy !== undefined
}

/**
 * Does a rule belong in this section?
 *
 * `all` always matches — a section that hides a rule is how an operator
 * concludes it was deleted. The others PARTITION the list: sound and
 * occupancy are claimed by their condition, a system-event rule by its trigger
 * and then by the family of its event kinds (or `mixed`, D637), `sensor`
 * claims the `device-event` trigger that occupancy did not (operator ruling,
 * 2026-10-01 — a doorbell press used to fall into `detection` for want of its
 * own section, which is the "everything mixed together" the viewer's
 * `ruleKindOf`-based list had already fixed and the admin's section strip had
 * not), and everything left over — including a trigger this build has never
 * heard of — counts as a detection rule so it stays visible somewhere.
 *
 * Keyed on the CONDITION for sound and occupancy, because the trigger alone
 * cannot answer: a sound rule is `immediate` and an occupancy rule is
 * `device-event`, and in each case the condition is the discriminator the
 * engine itself uses. `sensor` IS keyed on the trigger, same as `ruleKindOf`'s
 * `'sensor'` kind — a device-event subject with no occupancy condition is a
 * sensor rule, full stop.
 */
export function ruleMatchesSection(
  subject: NcRuleSectionSubject,
  section: NcRuleSectionKey,
): boolean {
  if (section === 'all') return true
  if (isSystemDelivery(subject.delivery)) return ruleKindOf(subject) === section
  if (section === 'audio') return isAudioRule(subject)
  if (section === 'occupancy') return isOccupancyRule(subject)
  if (section === 'sensor') return subject.delivery === 'device-event' && !isOccupancyRule(subject)
  if (section === 'detection') {
    return !isAudioRule(subject) && !isOccupancyRule(subject) && subject.delivery !== 'device-event'
  }
  return false
}

/** The ONE real section a rule lives in — `all` holds everything and is not it. */
export type NcRuleOwningSectionKey = Exclude<NcRuleSectionKey, 'all'>

/**
 * Which section OWNS this rule — the counter behind a section strip.
 *
 * The same order as {@link ruleMatchesSection} — trigger first, then the
 * discriminating condition — and the section spec asserts the two agree on
 * every subject, so the strip's counts and its contents cannot disagree.
 */
export function ruleSectionOf(subject: NcRuleSectionSubject): NcRuleOwningSectionKey {
  if (isSystemDelivery(subject.delivery)) return systemRuleKindOf(subject.conditions.systemEvent)
  if (isAudioRule(subject)) return 'audio'
  if (isOccupancyRule(subject)) return 'occupancy'
  if (subject.delivery === 'device-event') return 'sensor'
  return 'detection'
}

// ── The seeds a "New rule" opens on ─────────────────────────────────

/**
 * The occupancy schema's own defaults, in one place.
 *
 * Both the WIDGET (what an untouched sub-field shows) and the CREATION PRESET
 * (what "New occupancy rule" seeds) have to author exactly these numbers, and
 * two copies of a default is how a preset starts writing a rule that does not
 * match what the editor then displays. Mirrors `NcOccupancyConditionSchema`'s
 * `.default(...)` clauses, and the spec asserts the mirror.
 */
export const NC_OCCUPANCY_DEFAULTS: NcOccupancyCondition = {
  op: 'became-occupied',
  count: 1,
  sustainSeconds: 15,
}

/**
 * The seeded sound condition.
 *
 * Carries a level floor rather than the bare defaults: with neither a level nor
 * a label the engine returns false for every window (`matchesAudio`), so a
 * preset without one would hand the operator a rule that can never fire. The
 * offered level is the same one the widget writes, so switching to SOUNDS
 * (label mode — the one that fires on the first labelled frame, D157) is one
 * tap on the mode picker.
 *
 * The seed cannot be a label rule instead: a labels-only condition with no
 * labels chosen yet is fail-closed too, and it would hand the operator the same
 * dead rule from the other side.
 */
export const NC_AUDIO_SEED: NcAudioCondition = {
  hitPercent: NC_AUDIO_DEFAULTS.hitPercent,
  samplingSeconds: NC_AUDIO_DEFAULTS.samplingSeconds,
  dbThreshold: NC_AUDIO_DB_OFFERED,
}

/**
 * What a "New rule" started from a section opens on.
 *
 * A trigger alone was enough while every section WAS a trigger. It is not for
 * sound and occupancy: the condition is what makes the rule that kind of rule,
 * so the preset seeds it — otherwise the operator lands on a form identical to
 * a detection rule's and has to know that the feature lives behind an expander
 * on a trigger they must pick first. That is exactly the gap reported on
 * 2026-08-13 ("non vedo un modo per creare le nuove rules audio e occupancy" [I do not see a way to create the new audio and occupancy rules])
 * for two features whose engines had already shipped.
 *
 * A system seed carries its event kinds for the same reason: the kind is derived
 * from them (D637), so an empty seed would open a `mixed` rule. `mixed` itself
 * falls to the default and is never offered — its section is not `creatable`.
 */
export interface NcRuleSeed extends NcRuleSectionSubject {
  readonly delivery: NcDelivery
  /** Pre-authored conditions — the ones that DEFINE the kind, nothing else. */
  readonly conditions: NcConditions
}

export function ruleSeedForSection(section: NcRuleSectionKey): NcRuleSeed {
  switch (section) {
    case 'device-events':
      return {
        delivery: NC_SYSTEM_DELIVERY,
        conditions: { systemEvent: { kinds: ['device-offline', 'device-online'] } },
      }
    case 'system':
      return {
        delivery: NC_SYSTEM_DELIVERY,
        conditions: { systemEvent: { kinds: ['node-offline', 'node-online'] } },
      }
    case 'alarm':
      return {
        delivery: NC_SYSTEM_DELIVERY,
        conditions: { systemEvent: { kinds: ['alarm-triggered'] } },
      }
    case 'audio':
      return { delivery: 'immediate', conditions: { audio: NC_AUDIO_SEED } }
    case 'occupancy':
      return { delivery: 'device-event', conditions: { occupancy: NC_OCCUPANCY_DEFAULTS } }
    case 'sensor':
      return { delivery: 'device-event', conditions: {} }
    default:
      // A new detection rule watches the PIPELINE's detections (R5, D690): the
      // onboard stream is a second, noisier opinion the operator opts into.
      return { delivery: 'immediate', conditions: { source: 'pipeline' } }
  }
}

/** The trigger a "New rule" in this section should open on. */
export function defaultDeliveryForSection(section: NcRuleSectionKey): NcDelivery {
  return ruleSeedForSection(section).delivery
}

// ── The editor's sections ───────────────────────────────────────────

/**
 * The rule editor's sections, in the order an operator meets them.
 *
 * Operator request, 2026-08-04 (admin) and 2026-08-18 (viewer): the editor was
 * ONE scrolling form holding every setting a rule has, so authoring a simple
 * rule meant scrolling past everything a simple rule does not need. Ordered by
 * how often a setting is touched — not by how the schema is shaped.
 *
 * The admin renders them as dialog TABS and the viewer as one scroll of
 * headings (a phone scrolls; dialog tabs are a desktop idiom), and the viewer
 * renders a SUBSET — but the ORDER is shared, because two surfaces that put the
 * same five things in two different orders are two features to learn.
 *
 * The `fields` claim map stays per-surface: each editor's form state is its own
 * type, and each side's spec asserts every field of ITS form is claimed exactly
 * once. What is shared is which sections exist, in what order, and which ones a
 * kind shows at all.
 */
export type NcRuleEditorSectionKey =
  | 'rule'
  | 'devices'
  | 'conditions'
  | 'notification'
  | 'actions'
  | 'advanced'

export const NC_RULE_EDITOR_SECTION_ORDER: readonly NcRuleEditorSectionKey[] = [
  'rule',
  'devices',
  'conditions',
  'notification',
  'actions',
  'advanced',
]

export interface NcRuleEditorSection {
  readonly key: NcRuleEditorSectionKey
  /** English fallback; the viewer maps `key` onto an i18n key. */
  readonly label: string
}

/** The English fallback name of each section, before the kind renames one. */
const EDITOR_SECTION_LABELS: Readonly<Record<NcRuleEditorSectionKey, string>> = {
  rule: 'Rule',
  devices: 'Cameras',
  conditions: 'Conditions',
  notification: 'Notification',
  actions: 'Actions',
  advanced: 'Advanced',
}

/**
 * The sections a rule of THIS kind actually shows.
 *
 * Two rules, both of them about a control that would decide nothing:
 *
 *  - a system-event rule (any family) has no device scope — `conditions.devices` is not
 *    evaluated for it and the input builder refuses to write it — so the
 *    Cameras section is DROPPED rather than shown and ignored;
 *  - a sound or occupancy rule is NAMED on its conditions section. Neither has
 *    a trigger of its own, so that section is the only place either feature
 *    exists, and a heading that never mentions sound is exactly why an operator
 *    with a working audio engine reported there was no way to create an audio
 *    rule.
 *
 * The NOTIFICATION section always survives: priority and the template still
 * matter even for a kind that carries no picture, and dropping the section to
 * hide the media controls would take the template with it. Whether the media
 * half renders is `carriesMedia` / `carriesSubjectCrop`, asked separately.
 */
export function ruleEditorSectionsForKind(kind: NcRuleKind): readonly NcRuleEditorSection[] {
  const spec = ruleKindSpec(kind)
  const sections: NcRuleEditorSection[] = []
  for (const key of NC_RULE_EDITOR_SECTION_ORDER) {
    if (key === 'devices' && isSystemRuleKind(kind)) continue
    sections.push({ key, label: key === 'conditions' ? spec.label : EDITOR_SECTION_LABELS[key] })
  }
  return sections
}
