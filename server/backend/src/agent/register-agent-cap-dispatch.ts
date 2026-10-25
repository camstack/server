/**
 * Extracted, testable helper for registering the agent-side cap-dispatch
 * service with a Moleculer broker.
 *
 * The helper is separated from `agent-bootstrap.ts` so the wiring decision
 * (undefined → no-op; defined → create service) can be exercised in a unit
 * test independently of the full bootstrap lifecycle.
 */

import type { ServiceSchema, Service } from 'moleculer'
import type {
  HubLocalChildDispatcher,
  InProcessProviderLookup,
  LocalChildRegistryLogger,
} from '@camstack/system'
import { createAgentCapDispatchService } from './agent-cap-dispatch-service.js'

// ---------------------------------------------------------------------------
// AgentServiceRegistrar — narrow interface satisfied by real ServiceBroker
// ---------------------------------------------------------------------------

/**
 * Minimal surface of `ServiceBroker` required to register the cap-dispatch
 * service. Keeping a narrow interface here avoids coupling the helper to the
 * full broker type (which chains through eventemitter2 without exported types)
 * and prevents `as unknown as ServiceBroker` casts at every call-site.
 *
 * The real `ServiceBroker` structurally satisfies this interface:
 *   `ServiceBroker.nodeID: string` ✓
 *   `ServiceBroker.createService(schema: ServiceSchema, ...): Service` ✓
 */
export interface AgentServiceRegistrar {
  readonly nodeID: string
  createService(schema: ServiceSchema, schemaMods?: Partial<ServiceSchema>): Service
}

// ---------------------------------------------------------------------------
// Exported helper
// ---------------------------------------------------------------------------

/**
 * Registers the `$agent-cap-fwd` Moleculer service with `registrar` when
 * `agentUdsRegistry` is defined; otherwise this is a no-op.
 *
 * Called from `agent-bootstrap.ts` after the UDS child registry starts
 * successfully so the hub can route `agent-child-forward` cap calls to this
 * agent's forked children.
 *
 * @param registrar          Moleculer broker (or compatible double in tests).
 * @param agentUdsRegistry   The agent's `LocalChildRegistry`; pass `undefined`
 *                           to skip registration (UDS failed to start).
 * @param inProcessLookup    Optional resolver for caps hosted in the agent's own
 *                           main process (core addons); forwarded to the service
 *                           so hub-dispatched calls to those caps resolve instead
 *                           of failing with "no provider".
 * @param logger             Optional scoped logger forwarded to the service.
 */
export function registerAgentCapDispatch(
  registrar: AgentServiceRegistrar,
  agentUdsRegistry: HubLocalChildDispatcher | undefined,
  inProcessLookup?: InProcessProviderLookup,
  logger?: LocalChildRegistryLogger,
): void {
  if (agentUdsRegistry === undefined) return
  registrar.createService(
    createAgentCapDispatchService(registrar.nodeID, agentUdsRegistry, inProcessLookup, logger),
  )
}
