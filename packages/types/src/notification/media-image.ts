/**
 * media-image — the ONE media choice of a notification rule (D897).
 *
 * A rule used to state its picture as three fields — `attach` (which stored
 * kind to look for), `frame` (cropped / full / boxed) and `zoneCrop` — and the
 * ladders those fed picked a STORED kind, so one rule shipped a subject crop on
 * one event and a boxed scene on the next depending on what had landed. The
 * picture is now rendered at send time from a clean frame, and the rule says
 * only what it wants to SEE: `image` (`scene-boxes` | `crop` | `clean` |
 * `none`) plus `showTriggerZone` and `showSubjectPath` (D903).
 *
 * This module is the only reader of the legacy triple. The rule store applies
 * {@link normalizeNcMediaPolicy} on load (a READ projection, like the retired
 * delivery fields of D692) and on every write, so a stored rule converges on
 * `image` the first time it is saved, and an editor that still sends the
 * triple (the viewer, until it follows) is folded on the way in.
 */
import type {
  NcConditions,
  NcMediaImage,
  NcMediaPolicy,
} from '../capabilities/notification-rules.cap.js'
import {
  type NcRuleKind,
  type NcRuleSectionSubject,
  ruleKindOf,
  ruleKindSpec,
} from './rule-kinds.js'

/** Every mode, in the order an editor offers them. */
export const NC_MEDIA_IMAGE_MODES: readonly NcMediaImage[] = [
  'scene-boxes',
  'crop',
  'clean',
  'none',
]

/**
 * The modes a rule of this kind can honour. A kind that carries no media gets
 * none (its row ships text, or — an alarm — its SOURCE rule's picture); a kind
 * whose subject has no region of the frame (a sound) is never offered `crop`.
 */
export function imageModesForKind(kind: NcRuleKind): readonly NcMediaImage[] {
  const spec = ruleKindSpec(kind)
  if (!spec.carriesMedia) return []
  return spec.carriesSubjectCrop
    ? NC_MEDIA_IMAGE_MODES
    : NC_MEDIA_IMAGE_MODES.filter((mode) => mode !== 'crop')
}

/**
 * The zone ids that FIRE a rule: its `zones` condition, or an occupancy rule's
 * own scoped zone. Empty when the trigger is not a zone — and then
 * `showTriggerZone` has nothing to draw and is refused on save.
 */
export function ruleTriggerZoneIds(conditions: NcConditions): readonly string[] {
  if (conditions.zones !== undefined) return conditions.zones.ids
  const zoneId = conditions.occupancy?.zoneId
  return zoneId !== undefined ? [zoneId] : []
}

/**
 * What the legacy triple MEANT, as a mode. `zoneCrop` forced the clean
 * keyFrame ladder and dropped `frame`, so it is `clean` whatever else was set;
 * `frame` decided over `attach` when present; `keyFrame` was the clean scene;
 * every other still (`best`, `best-matching`, the default) was the subject.
 */
export function legacyImageMode(media: NcMediaPolicy): NcMediaImage {
  if (media.attach === 'none') return 'none'
  if (media.zoneCrop === true) return 'clean'
  if (media.frame === 'full') return 'clean'
  if (media.frame === 'boxed') return 'scene-boxes'
  if (media.frame === 'cropped') return 'crop'
  if (media.attach === 'keyFrame') return 'clean'
  return 'crop'
}

/** A mode the kind cannot honour, mapped to the nearest one it can. */
function clampToKind(mode: NcMediaImage, kind: NcRuleKind): NcMediaImage {
  const offered = imageModesForKind(kind)
  if (offered.length === 0 || offered.includes(mode)) return mode
  return mode === 'crop' ? 'clean' : mode
}

/**
 * The mode a rule's picture is rendered in. `image` when stored; else what the
 * legacy triple meant — and, for a SENSOR rule written before D897, `clean`
 * whatever it stored (even `attach: 'none'`), because its stored triple was
 * ignored and one plain snapshot always shipped (operator ruling, 2026-10-01):
 * the migration keeps what the rule actually DID. Clamped to what the kind can
 * honour.
 */
export function resolveNcMediaImage(media: NcMediaPolicy, kind: NcRuleKind): NcMediaImage {
  if (media.image !== undefined) return clampToKind(media.image, kind)
  if (kind === 'sensor') return 'clean'
  return clampToKind(legacyImageMode(media), kind)
}

/** The rule fields the normalisation reads. */
export interface NcMediaRuleSubject extends NcRuleSectionSubject {
  readonly conditions: NcConditions
}

/**
 * The stored shape of a media policy: `image` set, the legacy triple gone.
 * `showSubjectPath` survives on a kind with a tracked subject and a picture.
 * `showTriggerZone` survives only where it can be drawn — a zone trigger and a
 * mode other than `crop`/`none`; a legacy `zoneCrop` on a zone rule becomes it.
 * Every other field (gif, clip, rolls, speed, profile, linked cameras) is
 * carried through untouched. Pure; never throws.
 */
export function normalizeNcMediaPolicy(
  media: NcMediaPolicy,
  rule: NcMediaRuleSubject,
): NcMediaPolicy {
  const kind = ruleKindOf(rule)
  const image = resolveNcMediaImage(media, kind)
  const {
    attach: _attach,
    frame: _frame,
    zoneCrop,
    showTriggerZone,
    showSubjectPath,
    image: _image,
    ...rest
  } = media
  const wantsZone = showTriggerZone === true || (media.image === undefined && zoneCrop === true)
  const drawable =
    wantsZone &&
    image !== 'crop' &&
    image !== 'none' &&
    ruleTriggerZoneIds(rule.conditions).length > 0
  const pathDrawable = showSubjectPath === true && image !== 'none' && subjectHasPath(kind)
  return {
    ...rest,
    image,
    ...(drawable ? { showTriggerZone: true } : {}),
    ...(pathDrawable ? { showSubjectPath: true } : {}),
  }
}

/**
 * True when a rule of this kind has a TRACKED subject whose path can be drawn
 * (`showSubjectPath`): the kinds whose subject owns a region of the frame. A
 * sound owns none, and a kind that carries no media has no picture.
 */
export function subjectHasPath(kind: NcRuleKind): boolean {
  const spec = ruleKindSpec(kind)
  return spec.carriesMedia && spec.carriesSubjectCrop
}

/**
 * Why a media policy cannot be SAVED on this rule, or null. Server-side and
 * editor alike: `showTriggerZone` on a rule whose trigger is not a zone, and a
 * mode the rule's kind cannot honour.
 */
export function ncMediaPolicyError(media: NcMediaPolicy, rule: NcMediaRuleSubject): string | null {
  const kind = ruleKindOf(rule)
  if (media.image !== undefined) {
    const offered = imageModesForKind(kind)
    if (offered.length > 0 && !offered.includes(media.image)) {
      return `media.image '${media.image}' is not available for a ${kind} rule (offered: ${offered.join(', ')})`
    }
  }
  if (media.showTriggerZone === true && ruleTriggerZoneIds(rule.conditions).length === 0) {
    return 'media.showTriggerZone needs a rule triggered by a zone (a zones condition or an occupancy zone)'
  }
  if (media.showSubjectPath === true && !subjectHasPath(kind)) {
    return `media.showSubjectPath needs a rule whose subject is a tracked object (not a ${kind} rule)`
  }
  return null
}
