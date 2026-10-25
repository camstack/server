/**
 * Names for the HomeKit services that sit alongside the camera on one
 * accessory — the privacy switch, each accessory child (siren, floodlight),
 * each PTZ action.
 *
 * Kept PURE (no hap-nodejs, no SDK) so the convention is unit-testable and so
 * every builder answers to ONE opinion about what a service is called.
 *
 * ## The camera's name is NOT part of these labels
 *
 * Every one of these services is published ON the camera's accessory. iOS
 * renders them in that accessory's context, so repeating the camera name
 * inside the label produced "Camera front door Privacy" inside a tile
 * already titled "Camera front door". Labels are therefore qualified only
 * as far as they must be UNIQUE WITHIN ONE ACCESSORY — never across the
 * bridge, which is a scope the controller already disambiguates.
 *
 * Nothing here touches the accessory's own name. That comes from the device
 * and is set in `camera-accessory.ts` (`new Accessory(displayName, …)` and
 * `AccessoryInformation.Name`), which does not call into this module at all.
 *
 * ## The characteristic these names are written to
 *
 * Both `Name` and `ConfiguredName`, via `service-label.ts` — which is also
 * where the reasoning lives. This module only decides what the string SAYS.
 *
 * ## The shape of the string
 *
 * hap-nodejs additionally validates every `Name` against Apple's naming rules
 * (`util/checkName.ts`) and warns when it fails: the value must start and end
 * with a letter or number and may only carry letters, numbers, spaces,
 * apostrophes and a small punctuation set in between. That is a SECOND warning
 * family, and a previous round hit it — `${camera} — ${action}` embeds an
 * em-dash (U+2014), which is outside the set, so iOS discarded the name and
 * rendered "Interruttore N". {@link hapServiceName} is the only constructor
 * here, and it cannot return a string that fails {@link isHapServiceName}.
 */

/**
 * Apple's own ceiling for a HomeKit name. hap-nodejs does not enforce it, and
 * a controller silently truncating is indistinguishable from a naming bug, so
 * the truncation happens here where it can be reasoned about.
 */
export const HAP_NAME_MAX_LENGTH = 64

/**
 * hap-nodejs' `checkName` regex, verbatim.
 *
 * Duplicated rather than imported because it is `@private Private API` in that
 * package and not exported. Duplicating a private regex is a liability, so the
 * guard against drift is behavioural, not textual: `service-naming.spec.ts`
 * builds real services and asserts hap-nodejs emits ZERO characteristic
 * warnings — if this expression ever diverges from theirs, that test fails.
 */
const HAP_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\p{Zs}’'&!._:;()/,-]*[\p{L}\p{N}]$/u

/** Characters HAP tolerates INSIDE a name. Anything else becomes a space. */
const HAP_NAME_INNER = /[^\p{L}\p{N}\p{Zs}’'&!._:;()/,-]/gu

/** Would hap-nodejs accept this as a `Name` characteristic value? */
export function isHapServiceName(value: string): boolean {
  return HAP_NAME_PATTERN.test(value)
}

/**
 * Build one HAP-valid service name from device-derived parts.
 *
 * Empty and absent parts are dropped rather than joined, so a missing role
 * never produces a double space. `fallback` is used ONLY when nothing
 * device-derived survives sanitisation — it is the last resort, not the
 * default, because a name that says nothing about the device is the defect
 * this module exists to end.
 */
export function hapServiceName(
  parts: readonly (string | null | undefined)[],
  fallback: string,
): string {
  const joined = parts
    .map((part) => (typeof part === 'string' ? part : ''))
    .map((part) => part.replace(HAP_NAME_INNER, ' '))
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()

  const trimmed = trimToHapName(joined)
  if (trimmed !== null) return trimmed
  return trimToHapName(fallback.replace(HAP_NAME_INNER, ' ').replace(/\s+/gu, ' ').trim()) ?? ''
}

/**
 * The privacy-mask switch.
 *
 * Just "Privacy". The camera name is NOT prefixed: this service lives inside
 * the camera's own accessory, iOS already renders it under the camera, and a
 * round that prefixed it gave the operator "Camera front door Privacy"
 * sitting inside a tile titled "Camera front door".
 *
 * The prefix was added for a real reason — two cameras publishing a switch
 * called "Privacy" — but that was a symptom of the label being the ONLY thing
 * shown, which stopped being true once `ConfiguredName` made the service
 * render in its accessory's context. Uniqueness is required WITHIN one
 * accessory, not across the bridge, and one camera has one privacy switch.
 */
export function privacyServiceName(): string {
  return hapServiceName([PRIVACY_SUFFIX], PRIVACY_SUFFIX)
}

/**
 * Deliberately not localised, and deliberately not a translation table.
 *
 * The device half of the name is the operator's own text and arrives in the
 * operator's language. This half names a camstack capability (`privacy-mask`)
 * and there is no locale in an addon's context to resolve it against; the word
 * is also identical in the operator's language. A translation layer for one
 * word would be the kind of leftover that reads as verification.
 */
const PRIVACY_SUFFIX = 'Privacy'

/** The subset of an accessory child this module needs to name it. */
export interface ChildDeviceNaming {
  readonly name: string
  readonly role?: string | null
}

/**
 * An accessory child (siren, floodlight, spotlight) rendered as a service on
 * the parent camera.
 *
 * The child's OWN stored name wins. It is the string the operator typed, in
 * the operator's language, and an early rule threw it away: `role` was
 * consulted first and title-cased, so every siren on the fleet published as
 * the English word "Siren" no matter what the operator had called it.
 *
 * Providers name children both ways — "Sirena" and "Camera kitchen
 * Sirena". The parent half is now REMOVED rather than added, because the
 * service is published inside the parent camera's own accessory and iOS
 * already shows it there. The result must be one form, not two.
 */
export function childServiceName(parentName: string, child: ChildDeviceNaming): string {
  const own = withoutParent(child.name.trim(), parentName)
  if (own.length > 0) return hapServiceName([own], own)

  const role = typeof child.role === 'string' ? titleCase(child.role) : ''
  return hapServiceName([role], CHILD_FALLBACK)
}

/**
 * Last resort for a child that carries neither a name nor a role. Better than
 * the parent's name, which would publish a service indistinguishable from the
 * accessory holding it — the exact defect this module keeps being asked to fix.
 *
 * English, like the role slugs it stands in for ("Floodlight", "Siren"): the
 * only strings this module invents are English, and inventing one Italian word
 * would be a localisation layer that localises nothing.
 */
const CHILD_FALLBACK = 'Accessory'

/**
 * A PTZ action switch: the bare action, "Preset front door" / "Pan Left" /
 * "Autotrack".
 *
 * The labels themselves stay in `ptz-labels.ts` — they name a HomeKit control,
 * not a device. This function exists only to put the operator-typed half of a
 * preset name through the same sanitisation everything else gets; it no longer
 * qualifies the label with the camera, because all eight PTZ services live on
 * that camera's accessory and are unique among themselves.
 */
export function ptzServiceName(actionLabel: string): string {
  return hapServiceName([actionLabel], actionLabel)
}

/**
 * Drop `parentName` from the front of `name`.
 *
 * A PREFIX only. "Camera kitchen Sirena" → "Sirena"; "Sirena" is already
 * bare and untouched. A parent name appearing anywhere else in the child's
 * name is left alone — cutting from the middle of a string the operator typed
 * would mangle it, and this function must never make a label WORSE.
 *
 * Returns `name` unchanged when stripping would leave nothing: a child the
 * operator called exactly what the camera is called still needs a label.
 */
function withoutParent(name: string, parentName: string): string {
  const needle = parentName.trim()
  if (needle.length === 0) return name
  if (!name.toLowerCase().startsWith(needle.toLowerCase())) return name

  const rest = name.slice(needle.length).trim()
  return rest.length > 0 ? rest : name
}

/**
 * Truncate to the HAP ceiling and shave any leading/trailing character the
 * pattern forbids. Returns `null` when nothing usable is left — the caller
 * decides what to do with that, because "fall back" and "drop the part" are
 * different answers.
 */
function trimToHapName(value: string): string | null {
  let out = value.length > HAP_NAME_MAX_LENGTH ? value.slice(0, HAP_NAME_MAX_LENGTH) : value
  while (out.length > 0 && !isAlphanumeric(out[out.length - 1])) out = out.slice(0, -1)
  while (out.length > 0 && !isAlphanumeric(out[0])) out = out.slice(1)
  return isHapServiceName(out) ? out : null
}

function isAlphanumeric(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch)
}

function titleCase(raw: string): string {
  return raw
    .split(/[-_\s]+/u)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
