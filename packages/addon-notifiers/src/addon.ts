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
import { randomUUID } from 'node:crypto'
import {
  type AddonInitResult,
  addonRoutesCapability,
  BaseAddon,
  buildAddonRouteProvider,
  buildUserScopedNotificationTargetInstances,
  defineAddonMigrations,
  integrationInstancesCapability,
  legacyTargetsOver,
  notificationOutputCapability,
  publicEndpointReaderFrom,
  secretKeysOf,
  targetRowPortsOver,
} from '@camstack/types'
import type { EmailSmtpClient, SmtpProviderOption } from './adapters/email.js'
import { buildNotifierAdapters } from './adapters/registry.js'
import { iconMediaTypeFor, iconRoutes, iconUrlFor } from './icon-routes.js'
import { ADDON_MIGRATIONS, OLD_TARGETS_KIND, oldTargetKinds } from './migrations/index.js'
import { makeNcTargetHandlers, type NcTargetActions, ncTargetActions } from './nc-target-actions.js'
import {
  createNotificationOutputProvider,
  NOTIFIERS_ADDON_ID,
} from './provider.js'
import { notifierDescriptors, notifiersRecordKinds } from './record-kinds.js'
import { sampleRoutes } from './sample-routes.js'
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
    await records.declare({ ...notifiersRecordKinds, ...oldTargetKinds })
    const descriptors = notifierDescriptors()
    // A target the migration could not move stays in the retired kind, and the store keeps serving it.
    const legacy = legacyTargetsOver(
      records.kind(oldTargetKinds[OLD_TARGETS_KIND]),
      this.ctx.logger,
    )
    const store = TargetStore.of(records, descriptors, { logger: this.ctx.logger, legacy })
    // The old single kind is flattened into the per-kind records BEFORE anything reads a target.
    await this.runMigrations(
      defineAddonMigrations(ADDON_MIGRATIONS, {
        rows: targetRowPortsOver({ legacy, store, logger: this.ctx.logger }),
        secretKeysOf: (kind) => {
          const descriptor = descriptors.find((candidate) => candidate.kind === kind)
          return descriptor === undefined ? [] : secretKeysOf(descriptor)
        },
      }),
    )

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
                ...(input.instanceId !== undefined ? { instanceId: input.instanceId } : {}),
              })
              return { messageId: result.messageId }
            },
            listProviders,
            listRelays: async (addonId) => {
              // A provider that holds no records is not an `integration-instances`
              // provider: it has no relays, which is an answer, not a failure.
              const holders = await api.addons.listCapabilityProviders.query({
                capName: 'integration-instances',
              })
              if (!holders.some((holder) => holder.addonId === addonId)) return []
              const instances = await api.integrationInstances.listInstances.query({ addonId })
              return instances.map((instance) => ({ id: instance.id, name: instance.name }))
            },
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

    // The Notification Center add form is drawn from the kind catalogue: the only `nc.*`
    // action left. A user's own targets travel `integration-instances` (see `instances` below).
    const ncHandlers = makeNcTargetHandlers({ provider })

    this.ctx.logger.info('NotifiersAddon initialized', {
      meta: { adapterCount: adapters.length },
    })

    const instances = buildUserScopedNotificationTargetInstances(records, {
      descriptors,
      kinds: notifiersRecordKinds,
      mintId: () => randomUUID(),
      canProbe: (kind) =>
        adapters.some((adapter) => adapter.descriptor.kind === kind && adapter.probe !== undefined),
      probe: (input) =>
        provider.probeTargetConfig({
          kind: input.kind,
          config: { ...input.config },
          ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
        }),
    })

    return {
      providers: [
        { capability: notificationOutputCapability, provider },
        { capability: integrationInstancesCapability, provider: instances },
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
