/**
 * The egress sharing key, hashed. Node-only (`node:crypto` through
 * `canonicalHash`), so it lives off the root entry; the plan it hashes
 * (`canonicalEgressPlan`) stays pure in `sharing-key.ts`.
 */
import type { EgressTranscodeRequest } from '../capabilities/stream-broker.cap.js'
import { canonicalHash } from '../utils/canonical-hash.js'
import {
  canonicalEgressPlan,
  egressTransportFromRequest,
  type EgressTransportPlan,
} from './sharing-key.js'

/**
 * The refcount / dedup key. `canonicalHash` sorts object keys at every depth,
 * so a request built with a different field order produces the same digest.
 *
 * The handle this keys is IMMUTABLE: there is no `reconfigure`. A consumer
 * whose requirements change RELEASES and re-acquires; the refcount does the
 * rest. That is what stops co-tenants disturbing each other — the co-tenant
 * hazard that made Alexa's shared `derived:alexa-<id>` stream a hazard was
 * exactly a mutable shared object, where one consumer's downgrade dragged
 * every other consumer to 360p.
 */
export function egressTranscodeSharingKey(
  request: EgressTranscodeRequest,
  delivery: EgressTransportPlan = egressTransportFromRequest(request),
): string {
  return `egress:${canonicalHash(canonicalEgressPlan(request, delivery))}`
}
