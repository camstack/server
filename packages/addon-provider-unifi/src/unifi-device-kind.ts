import { DeviceType, type DeviceRole } from '@camstack/types'

/**
 * What a UniFi infra device IS, read from its model and the Integration API's `features` list.
 * A console (UDM, UCG, UXG, Cloud Key, …) reports switching and an access point too, so the
 * model decides it first.
 */
export type UnifiInfraKind = 'console' | 'switch' | 'access-point' | 'other'

/** Every candidate the integration proposes: the controller itself, an infra kind, a client. */
export type UnifiCandidateKind = 'controller' | UnifiInfraKind | 'client'

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

/** Classify one infra device. Pure. */
export function classifyUnifiInfra(input: UnifiInfraClassifyInput): UnifiInfraKind {
  if (CONSOLE_MODEL.test(input.model)) return 'console'
  if (input.features.includes('accessPoint')) return 'access-point'
  if (input.features.includes('switching')) return 'switch'
  if (SWITCH_MODEL.test(input.model)) return 'switch'
  if (ACCESS_POINT_MODEL.test(input.model)) return 'access-point'
  return 'other'
}

/**
 * The target of every device the Integration API reports cpu / memory / uptime / firmware and a
 * restart for (console, switch, access point). planning#585 adds `DeviceType.Workload` and
 * `DeviceRole.Host`; until then these keep today's Container. THE line that flips:
 *   `{ type: DeviceType.Workload, role: DeviceRole.Host }`
 */
export const UNIFI_HOST_TARGET: UnifiDeviceTarget = { type: DeviceType.Container, role: null }

const CONTROLLER_TARGET: UnifiDeviceTarget = { type: DeviceType.Gateway, role: null }
const OTHER_TARGET: UnifiDeviceTarget = { type: DeviceType.Container, role: null }
const CLIENT_TARGET: UnifiDeviceTarget = { type: DeviceType.Presence, role: null }

/** The ONE type/role table: discovery proposes and adoption creates with what this returns. */
export function unifiDeviceTarget(kind: UnifiCandidateKind): UnifiDeviceTarget {
  switch (kind) {
    case 'controller':
      return CONTROLLER_TARGET
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
