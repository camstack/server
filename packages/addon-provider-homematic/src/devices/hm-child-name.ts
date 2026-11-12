/**
 * Display name of one actuator child.
 *
 * A single actuator keeps the container's name (the caller passes it). A
 * multi-actuator child uses the CCU channel name when the facade has one,
 * otherwise `"<container> ch<index>"`. Never the channel address.
 */
export function multiActuatorChildName(input: {
  readonly containerName: string
  readonly channelName: string | null
  readonly channelIndex: string | null
}): string {
  if (input.channelName !== null) return input.channelName
  const index = input.channelIndex ?? '?'
  return `${input.containerName} ch${index}`
}

/** The name this addon used to give a multi-actuator child: container + raw address. */
export function legacyActuatorName(containerName: string, channelAddress: string): string {
  return `${containerName} ${channelAddress}`
}

export type ActuatorNameWrite =
  | { readonly kind: 'keep' }
  | { readonly kind: 'rename'; readonly name: string; readonly stampUserNamed: boolean }

/**
 * Whether an already-adopted actuator may take the new auto name.
 *
 * An operator rename (`userNamed`, or a legacy row whose name is not one of
 * the auto forms) is left alone. A name that is still the generated address
 * form, the `ch<index>` form, or the stable-id placeholder is replaced.
 * `stampUserNamed` is true only when the row is already flagged user-named:
 * the device-manager refuses a system rename of those rows, and accessory
 * registration stamps the flag on every non-placeholder name.
 */
export function actuatorNameWrite(input: {
  readonly currentName: string
  readonly userNamed: boolean | undefined
  readonly desiredName: string
  readonly legacyAutoName: string
  readonly fallbackAutoName: string
  readonly stableId: string
}): ActuatorNameWrite {
  if (input.currentName === input.desiredName) return { kind: 'keep' }
  const auto =
    input.currentName === input.legacyAutoName ||
    input.currentName === input.fallbackAutoName ||
    input.currentName === input.stableId
  if (!auto && (input.userNamed === true || input.userNamed === undefined)) return { kind: 'keep' }
  return {
    kind: 'rename',
    name: input.desiredName,
    stampUserNamed: input.userNamed === true,
  }
}
