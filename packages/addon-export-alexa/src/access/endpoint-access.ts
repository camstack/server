/**
 * Endpoint-level enforcement of the S1 gate (D767): which endpoints a
 * principal may be SHOWN (discovery, AddOrUpdateReport), and whether a
 * directive may run against one.
 *
 * Both answer the same three questions in the same order, because a forged
 * endpoint id is the cheapest attack on this surface — before S1 a linked user
 * could address `<exposed>__<any id>` and actuate a device that was never
 * exposed at all:
 *
 *   1. is the endpoint published under a device the operator EXPOSED?
 *   2. for an accessory endpoint, is the addressed device really a CHILD of it?
 *   3. does the linking user's live grant cover that device at the access asked?
 */
import type { MethodAccess } from '@camstack/types'
import type { AlexaEndpoint } from '../endpoints/types.js'
import { parseCameraEndpointId } from '../handlers/endpoint-id.js'
import {
  type AccessVerdict,
  type AlexaAccessGate,
  type AlexaPrincipal,
  endpointAccessTarget,
} from './access-gate.js'

export interface EndpointAccessDeps {
  readonly gate: AlexaAccessGate
  /** Whether the operator exposed this top-level device to Alexa. */
  readonly isExposed: (deviceId: number) => boolean
}

/** Why an endpoint was refused — carried to the log and to the Alexa error. */
export type EndpointRefusal =
  | { readonly kind: 'invalid-endpoint' }
  | { readonly kind: 'not-exposed'; readonly deviceId: number }
  | { readonly kind: 'not-a-child'; readonly deviceId: number; readonly parentDeviceId: number }
  | { readonly kind: 'not-granted'; readonly deviceId: number; readonly access: MethodAccess }
  | { readonly kind: 'device-unknown'; readonly deviceId: number }

export type EndpointAuthorization =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly refusal: EndpointRefusal }

/**
 * May `principal` reach `endpointId` at `access`? `access` defaults to the
 * endpoint's own discovery access (`view` for a camera, `create` for an
 * actuator-only endpoint).
 */
export async function authorizeEndpoint(
  endpointId: string,
  principal: AlexaPrincipal,
  deps: EndpointAccessDeps,
  access?: MethodAccess,
): Promise<EndpointAuthorization> {
  const target = endpointAccessTarget(parseCameraEndpointId(endpointId))
  if (target === null) return { allowed: false, refusal: { kind: 'invalid-endpoint' } }
  if (!deps.isExposed(target.exposedDeviceId)) {
    return { allowed: false, refusal: { kind: 'not-exposed', deviceId: target.exposedDeviceId } }
  }
  if (target.requiresParent !== null) {
    const parent = await deps.gate.parentOf(target.deviceId)
    if (parent === undefined) {
      return { allowed: false, refusal: { kind: 'device-unknown', deviceId: target.deviceId } }
    }
    if (parent !== target.requiresParent) {
      return {
        allowed: false,
        refusal: {
          kind: 'not-a-child',
          deviceId: target.deviceId,
          parentDeviceId: target.requiresParent,
        },
      }
    }
  }
  const needed = access ?? target.ownAccess
  const verdict: AccessVerdict = await deps.gate.allows(principal, target.deviceId, needed)
  if (verdict === 'allowed') return { allowed: true }
  if (verdict === 'unknown') {
    return { allowed: false, refusal: { kind: 'device-unknown', deviceId: target.deviceId } }
  }
  return {
    allowed: false,
    refusal: { kind: 'not-granted', deviceId: target.deviceId, access: needed },
  }
}

export interface FilteredEndpoints {
  readonly kept: readonly AlexaEndpoint[]
  readonly refused: ReadonlyArray<{
    readonly endpointId: string
    readonly refusal: EndpointRefusal
  }>
}

/**
 * Interfaces on a VIEWABLE endpoint that only actuate. A user who may see a
 * camera but not control it is shown the camera without them, so the Alexa app
 * never offers a PTZ dropdown whose every use would be refused.
 */
const CONTROL_ONLY_INTERFACES: ReadonlySet<string> = new Set([
  'Alexa.ModeController',
  'Alexa.ToggleController',
])

/** Strip what a view-only principal may not drive. Two-way audio is driving
 *  the camera's speaker, so it goes too. Returns a NEW endpoint. */
export function viewOnlyShape(endpoint: AlexaEndpoint): AlexaEndpoint {
  return {
    ...endpoint,
    capabilities: endpoint.capabilities
      .filter((c) => !CONTROL_ONLY_INTERFACES.has(c.interface))
      .map((c) =>
        c.interface === 'Alexa.RTCSessionController'
          ? { ...c, configuration: { ...c.configuration, isFullDuplexAudioSupported: false } }
          : c,
      ),
  }
}

/** Keep the endpoints `principal` may be shown, shaped to what it may drive.
 *  Order is preserved. */
export async function filterEndpointsForPrincipal(
  endpoints: readonly AlexaEndpoint[],
  principal: AlexaPrincipal,
  deps: EndpointAccessDeps,
): Promise<FilteredEndpoints> {
  const kept: AlexaEndpoint[] = []
  const refused: Array<{ endpointId: string; refusal: EndpointRefusal }> = []
  for (const endpoint of endpoints) {
    const verdict = await authorizeEndpoint(endpoint.endpointId, principal, deps)
    if (!verdict.allowed) {
      refused.push({ endpointId: endpoint.endpointId, refusal: verdict.refusal })
      continue
    }
    const target = endpointAccessTarget(parseCameraEndpointId(endpoint.endpointId))
    if (principal.kind === 'scoped' && target !== null && target.ownAccess === 'view') {
      const control = await deps.gate.allows(principal, target.deviceId, 'create')
      kept.push(control === 'allowed' ? endpoint : viewOnlyShape(endpoint))
      continue
    }
    kept.push(endpoint)
  }
  return { kept, refused }
}

/** The Alexa error type a refusal maps to. A device the user may not see does
 *  not exist for that user; one it may see but not control is a permission
 *  failure; a device the registry cannot read right now is unreachable. */
export function alexaErrorTypeFor(refusal: EndpointRefusal): string {
  switch (refusal.kind) {
    case 'device-unknown':
      return 'ENDPOINT_UNREACHABLE'
    case 'not-granted':
      // `INVALID_DIRECTIVE`, not a credential error: the link is valid, the
      // user simply may not drive this device. A credential error would make
      // the Alexa app prompt a re-link that could never help.
      return refusal.access === 'view' ? 'NO_SUCH_ENDPOINT' : 'INVALID_DIRECTIVE'
    case 'invalid-endpoint':
    case 'not-exposed':
    case 'not-a-child':
      return 'NO_SUCH_ENDPOINT'
  }
}

export function describeRefusal(refusal: EndpointRefusal): string {
  switch (refusal.kind) {
    case 'invalid-endpoint':
      return 'the endpoint id is not one this skill publishes'
    case 'not-exposed':
      return `device ${refusal.deviceId} is not exposed to Alexa`
    case 'not-a-child':
      return `device ${refusal.deviceId} is not an accessory of ${refusal.parentDeviceId}`
    case 'not-granted':
      return `the linked hub user has no ${refusal.access} grant on device ${refusal.deviceId}`
    case 'device-unknown':
      return `device ${refusal.deviceId} could not be resolved in the registry`
  }
}
