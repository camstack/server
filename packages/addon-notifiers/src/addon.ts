/**
 * Notifiers addon — a system `notification-output` collection provider.
 *
 * It hosts per-kind `NotifierAdapter`s (ntfy, pushover, gotify, telegram,
 * discord, webhook, zentik, whatsapp, email) behind one uniform cap surface.
 * Targets persist via the `settings-store` cap; the canonical notification is
 * degraded per each target's declared capabilities by the pure
 * `prepareNotification` engine in `@camstack/types`. The catalog is
 * `buildNotifierAdapters` (`adapters/registry.ts`); email uses `sendDirect` →
 * `smtp-provider`.
 */
import {
  addonRoutesCapability,
  buildAddonRouteProvider,
  type AddonInitResult,
  BaseAddon,
  notificationOutputCapability,
  publicEndpointReaderFrom,
} from '@camstack/types'
import type { EmailSmtpClient, SmtpProviderOption } from './adapters/email.js'
import { buildNotifierAdapters } from './adapters/registry.js'
import { iconMediaTypeFor, iconRoutes, iconUrlFor } from './icon-routes.js'
import { sampleRoutes } from './sample-routes.js'
import { makeNcTargetHandlers, ncTargetActions, type NcTargetActions } from './nc-target-actions.js'
import { createNotificationOutputProvider, NOTIFIERS_ADDON_ID } from './provider.js'
import { notifiersRecordKinds } from './record-kinds.js'
import { TargetStore } from './target-store.js'

/** The notifiers addon has no global settings today — targets are managed via cap CRUD. */
type NotifiersConfig = Record<string, never>

export class NotifiersAddon extends BaseAddon<NotifiersConfig> {
  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<AddonInitResult<NcTargetActions>> {
    const api = this.ctx.api
    // `execution.placement: hub-only` guarantees ctx.records is present.
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('notifiers (hub) needs ctx.records — check execution.placement')
    }
    // Declare notification-targets BEFORE first store access.
    await records.declare(notifiersRecordKinds)
    const store = TargetStore.of(records)

    const listProviders = async (): Promise<readonly SmtpProviderOption[]> => {
      if (api === undefined) return []
      const [providers, addons] = await Promise.all([
        api.addons.listCapabilityProviders.query({ capName: 'smtp-provider' }),
        api.addons.list.query(),
      ])
      const names = new Map<string, string>()
      for (const row of addons) {
        const id = row.manifest.id
        names.set(id, row.manifest.name ?? row.manifest.packageDisplayName ?? id)
      }
      const out: SmtpProviderOption[] = []
      for (const p of providers) {
        if (!p.isActive) continue
        const name = names.get(p.addonId) ?? p.addonId
        try {
          const status = await api.smtpProvider.getStatus.query({ addonId: p.addonId })
          const hostBit = status.host !== '' ? status.host : p.addonId
          const label = status.ready
            ? `${name} — ${hostBit}`
            : `${name} — ${hostBit} (not verified)`
          out.push({
            value: p.addonId,
            label,
            description: p.addonId,
            ready: status.ready,
          })
        } catch {
          out.push({
            value: p.addonId,
            label: `${name} (status unavailable)`,
            description: p.addonId,
            ready: false,
          })
        }
      }
      return out
    }

    const smtpClient: EmailSmtpClient | undefined =
      api !== undefined
        ? {
            sendEmail: async (input) => {
              const result = await api.smtpProvider.sendEmail.mutate({
                to: typeof input.to === 'string' ? input.to : [...input.to],
                subject: input.subject,
                text: input.text,
                ...(input.html !== undefined ? { html: input.html } : {}),
                ...(input.from !== undefined ? { from: input.from } : {}),
                ...(input.addonId !== undefined ? { addonId: input.addonId } : {}),
              })
              return { messageId: result.messageId }
            },
            listProviders,
            resolveDefaultAddonId: async () => {
              const providers = await listProviders()
              return providers.find((p) => p.ready === true)?.value ?? providers[0]?.value
            },
          }
        : undefined

    const adapters = buildNotifierAdapters(smtpClient)
    const provider = createNotificationOutputProvider({
      store,
      adapters,
      logger: this.ctx.logger.child('notification-output'),
      ...(api !== undefined
        ? { readPublicEndpoint: publicEndpointReaderFrom(api.localNetwork) }
        : {}),
      iconUrlFor,
      iconMediaTypeFor,
    })

    // ONE `addon-routes` provider owns the `notifiers` route id, so the brand
    // icons and the test-notification samples travel in a single route set —
    // two providers sharing the id would collide on path matching.
    //
    //   GET /addon/notifiers/icons/<kind>    brand icon (`iconUrlFor` stamps it
    //                                        onto each kind descriptor above)
    //   GET /addon/notifiers/samples/<name>  test media the operator can attach
    //                                        without an internet connection
    const routeProvider = buildAddonRouteProvider(NOTIFIERS_ADDON_ID, [
      ...iconRoutes(),
      ...sampleRoutes(),
    ])

    // Notification Center target-bridge actions (nc.*). The viewer reaches
    // these over `addons.custom` (addonId `notifiers`); per-action auth +
    // ownership is enforced inside the handlers (`nc-target-actions.ts`), which
    // wrap the very provider built above (redaction + secret merge stay there).
    // The addon is `hub-only`, so the bridge is unconditionally hub-resident.
    const ncHandlers = makeNcTargetHandlers({
      provider,
      logger: this.ctx.logger.child('nc-target-actions'),
    })

    this.ctx.logger.info('NotifiersAddon initialized', {
      meta: { adapterCount: adapters.length },
    })

    return {
      providers: [
        { capability: notificationOutputCapability, provider },
        { capability: addonRoutesCapability, provider: routeProvider },
      ],
      customActions: ncTargetActions,
      actionHandlers: ncHandlers,
    }
  }

  protected async onShutdown(): Promise<void> {
    this.ctx.logger.info('NotifiersAddon shut down')
  }
}

export default NotifiersAddon
