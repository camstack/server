/**
 * The ONE place a secondary service on the camera accessory gets its label.
 *
 * A "secondary service" here is a Switch or Lightbulb published alongside the
 * camera on the same accessory — the privacy switch, each accessory child
 * (siren, floodlight), each PTZ action. iOS Home renders these as their own
 * controls, and the operator has seen them as "Interruttore 1", "Interruttore
 * 2" through three separate rounds of fixes.
 *
 * ## Why `Name` alone cannot rename anything
 *
 * Two facts about hap-nodejs 2.1.7, both measured against the installed copy
 * rather than reasoned about:
 *
 *  1. `accessory.addService(Type, displayName, subtype)` ALREADY writes
 *     `displayName` to `Characteristic.Name` (`Service` constructor). So every
 *     round of this bug — including the one that moved the label onto
 *     `ConfiguredName` — shipped with `Name` correctly set. "iOS had no name
 *     to render" was never true.
 *  2. The mDNS configuration number (`c#`) is a sha1 over
 *     `internalHAPRepresentation(false)`, which OMITS characteristic VALUES.
 *     Changing the string in `Name` therefore does not bump `c#`, a paired
 *     controller gets no signal to re-read `/accessories`, and the name it
 *     cached at first enumeration stands forever.
 *
 * `Name` is also declared `pr` only — paired read, no write, no notify. It is
 * the seed a controller seeds its database from once; it is not a channel.
 *
 * ## Why `ConfiguredName`
 *
 * `ConfiguredName` (`000000E3`) is declared `pr | pw | ev` — the only name
 * characteristic a controller may write and may subscribe to. It is what iOS
 * 16+ reads for a service the user can rename, and adding it CHANGES the
 * accessory structure, so `c#` does bump and the controller re-reads.
 *
 * It was removed once because hap-nodejs logged
 *
 * ```
 * Characteristic not in required or optional characteristic section for
 * service Switch. Adding anyway.
 * ```
 *
 * That line is a WARNING, not a rejection: `Service.getCharacteristic` calls
 * `addCharacteristic` unconditionally and only then emits the warning. The
 * characteristic was always present and always published. hap-nodejs'
 * per-service optional lists simply predate `ConfiguredName` being valid on
 * any service.
 *
 * Registering it with {@link Service.addOptionalCharacteristic} first takes
 * the branch above the warning, so the accessory still builds with ZERO
 * characteristic warnings — which is what `service-naming.spec.ts` asserts.
 *
 * ## Scope: EVERY service, including the sensors
 *
 * An earlier round applied this to Switch- and Lightbulb-shaped services only,
 * on the theory that `Service.MotionSensor` and `Service.Battery` are not
 * separately named tiles in iOS Home and that naming them would be a guess.
 *
 * That theory was never measured, and it had a cost: it left services on the
 * accessory whose name a paired controller could never be told about, and it
 * made "did `ConfiguredName` fix the operator's 'Interruttore N'?" unanswerable
 * — a negative result on a partial application proves nothing about the
 * mechanism. Every service this addon publishes now carries both
 * characteristics, on the camera accessory and on the generic one.
 *
 * The reasoning above is mechanism, not measurement: it says why `Name` alone
 * CANNOT work and why `ConfiguredName` is the only characteristic that can. It
 * does not prove iOS renders it on every service shape. That is an observation
 * only a re-paired controller can make — and after a change like this one, the
 * controller must be re-paired, because a cached accessory database is exactly
 * what the whole mechanism is about.
 */
import { Characteristic, type Service } from '@homebridge/hap-nodejs'

/**
 * Publish `name` as both the immutable `Name` and the controller-visible
 * `ConfiguredName` of `service`.
 *
 * `name` must already be HAP-valid — build it with `service-names.ts`, which
 * cannot return a string hap-nodejs' `checkName` would warn about.
 */
export function applyServiceLabel(service: Service, name: string): void {
  service.setCharacteristic(Characteristic.Name, name)

  const alreadyOptional = service.optionalCharacteristics.some(
    (characteristic) => characteristic.UUID === Characteristic.ConfiguredName.UUID,
  )
  if (!alreadyOptional) {
    service.addOptionalCharacteristic(Characteristic.ConfiguredName)
  }

  service.setCharacteristic(Characteristic.ConfiguredName, name)
}
