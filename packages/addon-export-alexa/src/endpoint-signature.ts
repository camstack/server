/**
 * Endpoint signature — the pure discriminator behind the Alexa discovery
 * reconcile.
 *
 * Alexa keeps its OWN copy of every endpoint's capability list, and that copy
 * is only ever refreshed by an `AddOrUpdateReport` we push. Nothing about a
 * camstack-side change reaches Amazon on its own. So an interface the camera
 * gained AFTER it was exposed — a `doorbell` cap bound later being the case
 * that cost a real press — is simply absent from Alexa's copy: the Event Gateway
 * still answers 2xx for a `DoorbellPress` against an endpoint that never
 * declared `Alexa.DoorbellEventSource`, and the cloud drops it. A 2xx is
 * therefore NOT proof of delivery; the endpoint's advertised shape is.
 *
 * The signature captures exactly what Alexa's copy has to match — endpoint
 * ids, display categories and the declared interface set (with the instance
 * name for instanced controllers, which are distinct interfaces to Alexa) —
 * and nothing that changes for cosmetic reasons alone. It is deliberately NOT
 * a hash of the whole payload: a friendly-name edit or a re-ordered
 * `cameraStreamConfigurations` array must not trigger a cloud round-trip, and
 * a lost interface must always trigger one.
 */
import type { AlexaCapability, AlexaEndpoint } from './endpoints/types.js'

/**
 * One capability's identity as Alexa distinguishes it. A capability whose
 * properties are proactively reported carries a `!p` mark: Alexa's copy must
 * know the hub reports them, or the ChangeReports are worth nothing (R3) —
 * so flipping the flag is a shape change the reconcile re-pushes.
 */
function capabilityKey(capability: AlexaCapability): string {
  const instance = typeof capability.instance === 'string' ? capability.instance : ''
  const base = instance.length > 0 ? `${capability.interface}#${instance}` : capability.interface
  return capability.properties?.proactivelyReported === true ? `${base}!p` : base
}

/** One endpoint as a signature records it. */
export interface SignatureEntry {
  readonly endpointId: string
  /** Interface names, without instance or flags. */
  readonly interfaces: readonly string[]
}

/** Read back the endpoints (and their interfaces) a signature records — what
 *  Alexa was last told about a device. */
export function signatureEntries(signature: string): readonly SignatureEntry[] {
  if (signature.length === 0) return []
  return signature.split(';').map((entry) => {
    const [endpointId = '', , interfaces = ''] = entry.split('|')
    return {
      endpointId,
      interfaces: interfaces
        .split(',')
        .filter((i) => i.length > 0)
        .map((i) => i.replace(/!p$/, '').replace(/#.*$/, '')),
    }
  })
}

/** Stable, order-independent signature of ONE endpoint's advertised shape. */
function endpointKey(endpoint: AlexaEndpoint): string {
  const interfaces = endpoint.capabilities.map(capabilityKey).sort().join(',')
  const categories = [...endpoint.displayCategories].sort().join(',')
  return `${endpoint.endpointId}|${categories}|${interfaces}`
}

/**
 * Stable signature of the endpoint set built for ONE device. Two builds that
 * would land identically in Alexa's registry produce the same string; any
 * added, removed or renamed interface — or a changed display category —
 * produces a different one.
 */
export function endpointsSignature(endpoints: readonly AlexaEndpoint[]): string {
  return endpoints.map(endpointKey).sort().join(';')
}
