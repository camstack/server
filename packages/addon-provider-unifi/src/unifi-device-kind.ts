import { DeviceRole, DeviceType } from '@dominevo/types'

/**
 * What a UniFi infra device IS, read from its model and the Integration API's `features` list.
 * A console (UDM, UCG, UXG, Cloud Key, …) reports switching and an access point too, so the
 * model decides it first.
 */
export type UnifiInfraKind = 'console' | 'switch' | 'access-point' | 'other'

/**
 * Every candidate the integration proposes: an infra kind or a client. The controller has no
 * device of its own: a console is a workload Host, and there is no Gateway (D1064).
 */
export type UnifiCandidateKind = UnifiInfraKind | 'client'

/** The device type and role a candidate is proposed and adopted with. */
export interface UnifiDeviceTarget {
  readonly type: DeviceType
  readonly role: DeviceRole | null
}

/** The fields {@link classifyUnifiInfra} reads. */
export interface UnifiInfraClassifyInput {
  readonly model: string
  readonly features: readonly string[]
}

const CONSOLE_MODEL = /^(UDM|UXG|UCG|UCK|USG|UDR|UDW)/
const SWITCH_MODEL = /^(USW|USL|USP|USF)/
const ACCESS_POINT_MODEL = /^(UAP|UAL|U6|U7|UWB|E7)/

/** Is this model a UniFi OS console (UDM, UCG, UXG, Cloud Key, …)? Pure. */
export function isUnifiConsoleModel(model: string): boolean {
  return CONSOLE_MODEL.test(model)
}

/** Classify one infra device. Pure. */
export function classifyUnifiInfra(input: UnifiInfraClassifyInput): UnifiInfraKind {
  if (isUnifiConsoleModel(input.model)) return 'console'
  if (input.features.includes('accessPoint')) return 'access-point'
  if (input.features.includes('switching')) return 'switch'
  if (SWITCH_MODEL.test(input.model)) return 'switch'
  if (ACCESS_POINT_MODEL.test(input.model)) return 'access-point'
  return 'other'
}

/**
 * The target of every device the Integration API reports cpu / memory / uptime / firmware for
 * (console, switch, access point): a `workload` host (D1056). Its PoE ports and features stay
 * its accessory children.
 */
export const UNIFI_HOST_TARGET: UnifiDeviceTarget = {
  type: DeviceType.Workload,
  role: DeviceRole.Host,
}

const OTHER_TARGET: UnifiDeviceTarget = {
  type: DeviceType.Container,
  role: null,
}
const CLIENT_TARGET: UnifiDeviceTarget = {
  type: DeviceType.Presence,
  role: null,
}

/** The ONE type/role table: discovery proposes and adoption creates with what this returns. */
export function unifiDeviceTarget(kind: UnifiCandidateKind): UnifiDeviceTarget {
  switch (kind) {
    case 'console':
    case 'switch':
    case 'access-point':
      return UNIFI_HOST_TARGET
    case 'other':
      return OTHER_TARGET
    case 'client':
      return CLIENT_TARGET
  }
}
