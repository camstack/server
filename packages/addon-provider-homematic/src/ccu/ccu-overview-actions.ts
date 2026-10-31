import type { CcuActionDeps } from './ccu-facade.js'
import { errorText, requireConfirmed, requireFacade } from './ccu-facade.js'
import type { CcuListItem, CcuOverview, ServiceMessagesResult } from './ccu-schemas.js'

interface IntegrationInput {
  readonly integrationId: string
}
interface AcknowledgeInput extends IntegrationInput {
  readonly id: string
  readonly confirmed: boolean
}

/** The CCU overview tab: which CCUs exist, what each says about itself, and its service messages. */
export function buildCcuOverviewHandlers(deps: CcuActionDeps) {
  return {
    listCcus: async (_input: Record<string, never>): Promise<CcuListItem[]> => [
      ...deps.integrations(),
    ],

    ccuOverview: async (input: IntegrationInput): Promise<CcuOverview> => {
      const facade = requireFacade(deps, input.integrationId)
      const [info, interfaces] = await Promise.allSettled([
        facade.ccuInfo(),
        facade.listInterfaces(),
      ])
      if (info.status === 'rejected') {
        deps.logger.warn('Homematic: CCU info unavailable', {
          meta: { integrationId: input.integrationId, error: errorText(info.reason) },
        })
      }
      if (interfaces.status === 'rejected') {
        deps.logger.warn('Homematic: interface list unavailable', {
          meta: { integrationId: input.integrationId, error: errorText(interfaces.reason) },
        })
      }
      return {
        info: info.status === 'fulfilled' ? info.value : null,
        infoError: info.status === 'rejected' ? errorText(info.reason) : null,
        interfaces:
          interfaces.status === 'fulfilled'
            ? interfaces.value.map((iface) => ({ ...iface, gateways: [...iface.gateways] }))
            : [],
        interfacesError: interfaces.status === 'rejected' ? errorText(interfaces.reason) : null,
      }
    },

    listServiceMessages: async (input: IntegrationInput): Promise<ServiceMessagesResult> => {
      const facade = requireFacade(deps, input.integrationId)
      try {
        return { messages: [...(await facade.serviceMessages())], error: null }
      } catch (err) {
        deps.logger.warn('Homematic: service messages unavailable', {
          meta: { integrationId: input.integrationId, error: errorText(err) },
        })
        return { messages: [], error: errorText(err) }
      }
    },

    acknowledgeServiceMessage: async (input: AcknowledgeInput): Promise<{ ok: true }> => {
      requireConfirmed(input.confirmed)
      const facade = requireFacade(deps, input.integrationId)
      await facade.acknowledgeServiceMessage(input.id)
      deps.logger.info('Homematic: service message acknowledged', {
        meta: { integrationId: input.integrationId, messageId: input.id },
      })
      return { ok: true }
    },
  }
}
