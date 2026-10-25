/**
 * Slice-5, Task 6 — agent-side Moleculer service for forwarding hub-dispatched
 * cap calls to the agent's forked UDS children.
 *
 * The hub's `CapRouteResolver` dispatches an `agent-child-forward` route by
 * calling `callWithServiceDiscovery(broker, AGENT_CAP_FWD_SERVICE,
 * AGENT_CAP_FWD_ACTION, params, { nodeID: agentNodeId })`. This service
 * receives those calls, resolves the child locally via the agent's
 * `LocalChildRegistry`, and forwards the call over UDS.
 */

import type { ServiceSchema, Context } from 'moleculer'
import type {
  HubLocalChildDispatcher,
  AgentCapForwardParams,
  CapCallInput,
  InProcessProviderLookup,
  LocalChildRegistryLogger,
} from '@camstack/system'
import { AGENT_CAP_FWD_SERVICE } from '@camstack/system'

// ---------------------------------------------------------------------------
// ctx.params narrowing helpers
// ---------------------------------------------------------------------------

/**
 * Moleculer types `ctx.params` loosely; narrow it to `AgentCapForwardParams`
 * by checking the required string fields without unsafe casts.
 */
function narrowParams(raw: unknown): AgentCapForwardParams {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(
      '$agent-cap-fwd.forward: invalid params — capName and method are required strings',
    )
  }
  const capName: unknown = Reflect.get(raw, 'capName')
  const method: unknown = Reflect.get(raw, 'method')
  if (typeof capName !== 'string' || typeof method !== 'string') {
    throw new Error(
      '$agent-cap-fwd.forward: invalid params — capName and method are required strings',
    )
  }
  const childId: unknown = Reflect.get(raw, 'childId')
  const deviceId: unknown = Reflect.get(raw, 'deviceId')
  const addonId: unknown = Reflect.get(raw, 'addonId')
  return {
    capName,
    method,
    args: Reflect.get(raw, 'args'),
    childId: typeof childId === 'string' ? childId : undefined,
    deviceId: typeof deviceId === 'number' ? deviceId : undefined,
    addonId: typeof addonId === 'string' ? addonId : undefined,
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the Moleculer `ServiceSchema` for the agent-side cap-dispatch service.
 *
 * @param agentNodeId        The Moleculer nodeId of this agent (used in error messages).
 * @param agentUdsRegistry   The agent's `LocalChildRegistry` (or a compatible spy in tests).
 *                           `LocalChildRegistry` structurally satisfies `HubLocalChildDispatcher`.
 * @param inProcessLookup    Optional resolver for caps hosted in the agent's OWN main process
 *                           (core addons such as `platform-probe`, `metrics-provider` register
 *                           their singleton providers in the agent's `CapabilityRegistry`, NOT
 *                           as forked UDS children). Consulted ONLY when no UDS child provides
 *                           the cap. Without it, agent in-process core caps are unroutable from
 *                           the hub.
 * @param logger             Optional scoped logger; logs the no-provider path at INFO level.
 */
function createAgentCapDispatchService(
  agentNodeId: string,
  agentUdsRegistry: HubLocalChildDispatcher,
  inProcessLookup?: InProcessProviderLookup,
  logger?: LocalChildRegistryLogger,
): ServiceSchema {
  return {
    name: AGENT_CAP_FWD_SERVICE,
    actions: {
      forward: {
        handler: async (ctx: Context): Promise<unknown> => {
          const params = narrowParams(ctx.params)
          const { capName, method, args, deviceId, addonId } = params

          // Resolve the child: prefer the explicitly-provided childId (hub may
          // know it from its HubNodeRegistry), otherwise resolve locally.
          const childId: string | null | undefined =
            params.childId !== undefined
              ? params.childId
              : agentUdsRegistry.resolveChildId(capName, deviceId)

          if (childId == null) {
            // No forked UDS child owns this cap. It may instead be hosted by a
            // core addon running in the agent's OWN main process (platform-probe,
            // metrics-provider, …) — resolve it against the in-process registry.
            const ref = inProcessLookup?.(capName) ?? null
            if (ref !== null) {
              return ref.invoke(method, args)
            }
            logger?.info(
              `agent ${agentNodeId}: no provider for cap "${capName}"${deviceId !== undefined ? ` (deviceId ${deviceId})` : ''}`,
            )
            throw new Error(
              `agent ${agentNodeId} has no provider for cap "${capName}"${deviceId !== undefined ? ` (deviceId ${deviceId})` : ''}`,
            )
          }

          const input: CapCallInput = {
            capName,
            method,
            args,
            ...(deviceId !== undefined ? { deviceId } : {}),
            // Task 7.5a: forward the provider-selection hint the hub already
            // resolved (`AgentCapForwardParams.addonId`) onto the local UDS
            // envelope so a grouped runner on THIS agent can disambiguate two
            // co-located addons registering the same collection cap — exactly
            // what `child-cap-dispatch.ts`'s `call.addonId` already expects.
            ...(addonId !== undefined ? { addonId } : {}),
          }

          return agentUdsRegistry.callCapOnChild(childId, input)
        },
      },
    },
  }
}

export { createAgentCapDispatchService }
