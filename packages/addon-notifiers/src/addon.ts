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
  instanceSourceOverApi,
  instancesOfCap,
  integrationInstancesCapability,
  retiredTargetsOver,
  notificationOutputCapability,
  publicEndpointReaderFrom,
  secretKeysOf,
  targetRowPortsOver,
} from '@camstack/types'
import { EMAIL_KIND, EMAIL_SENDER_CAP, type EmailSmtpClient } from './adapters/email.js'
import { buildNotifierAdapters } from './adapters/registry.js'
import { iconMediaTypeFor, iconRoutes, iconUrlFor } from './icon-routes.js'
import { ADDON_MIGRATIONS, OLD_TARGETS_KIND, oldTargetKinds } from './migrations/index.js'
import { makeNcTargetHandlers, type NcTargetActions, ncTargetActions } from './nc-target-actions.js'
import { createNotificationOutputRuntime, NOTIFIERS_ADDON_ID } from './provider.js'
import { notifierInstancesSpec } from './notifier-instances.js'
import { notifierDescriptors, notifiersRecordKinds } from './record-kinds.js'
import { sampleRoutes } from './sample-routes.js'
import { TargetStore } from './target-store.js'

/** The notifiers addon has no global settings today — targets are managed via cap CRUD. */
type NotifiersConfig = Record<string, never>

/** The most email targets the `email-send-with` step reads (a settings list, not a table). */
const EMAIL_ROWS_MAX = 1000

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
    const descriptors = notifierDescriptors()
    // The retired single kind is declared on the store's first list, on every boot (not only while
    // the migration runs), so a stuck row stays visible through `legacy`; never declared here.
    const legacy = retiredTargetsOver(records, oldTargetKinds[OLD_TARGETS_KIND], this.ctx.logger)
    const store = TargetStore.of(records, descriptors, {
      logger: this.ctx.logger,
      legacy,
    })
    const emailRows = store.handlesByKind().get(EMAIL_KIND)
    if (emailRows === undefined) throw new Error('notifiers: the email record kind is not declared')
    // The first instance of `addonId` serving `smtp-provider`; a provider that cannot be read rejects.
    const firstSenderOf = async (addonId: string): Promise<string | null> => {
      if (api === undefined) throw new Error('notifiers: no api to read the mail senders')
      const listed = await instancesOfCap(instanceSourceOverApi(api), EMAIL_SENDER_CAP)
      const failed = listed.unreadable.find((entry) => entry.addonId === addonId)
      if (failed !== undefined)
        throw new Error(`notifiers: ${addonId} could not be read: ${failed.error}`)
      return listed.instances.find((entry) => entry.addonId === addonId)?.instance.id ?? null
    }
    // The old single kind is flattened into the per-kind records BEFORE anything reads a target.
    await this.runMigrations(
      defineAddonMigrations(ADDON_MIGRATIONS, {
        rows: targetRowPortsOver({ legacy, store, logger: this.ctx.logger }),
        secretKeysOf: (kind) => {
          const descriptor = descriptors.find((candidate) => candidate.kind === kind)
          return descriptor === undefined ? [] : secretKeysOf(descriptor)
        },
        emailSenders: {
          list: async () => (await emailRows.query({ limit: EMAIL_ROWS_MAX })).records,
          replace: async (row) => {
            await emailRows.put({ id: row.id, data: { ...row.data } }, { ifRev: row.rev })
          },
          firstSenderOf,
        },
      }),
    )

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
            // The linked sender is found among the instances that serve `smtp-provider` — a relay,
            // or a Google account through its kind's `alsoServes`. A holder that could not answer
            // is a failure, never "gone" (D49).
            resolveSender: async (instanceId) => {
              const listed = await instancesOfCap(instanceSourceOverApi(api), EMAIL_SENDER_CAP)
              const found = listed.instances.find((entry) => entry.instance.id === instanceId)
              if (found !== undefined) return { addonId: found.addonId, instanceId }
              if (listed.unreadable.length > 0) {
                const holders = listed.unreadable.map((entry) => entry.addonId).join(', ')
                throw new Error(`email: the mail senders of ${holders} could not be read`)
              }
              return null
            },
          }
        : undefined

    const adapters = buildNotifierAdapters(smtpClient)
    const runtime = createNotificationOutputRuntime({
      store,
      adapters,
      logger: this.ctx.logger.child('notification-output'),
      ...(api !== undefined
        ? { readPublicEndpoint: publicEndpointReaderFrom(api.localNetwork) }
        : {}),
      iconUrlFor,
      iconMediaTypeFor,
    })
    const provider = runtime.provider

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

    this.ctx.logger.info('NotifiersAddon initialized', {
      meta: { adapterCount: adapters.length },
    })

    const instances = buildUserScopedNotificationTargetInstances(
      records,
      notifierInstancesSpec({
        adapters,
        descriptors,
        kinds: notifiersRecordKinds,
        mintId: () => randomUUID(),
        probeCredentials: (input) =>
          provider.probeTargetConfig({
            kind: input.kind,
            config: { ...input.config },
            ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
          }),
        testDraft: (input) => runtime.testDraft(input),
        iconUrlFor,
        iconMediaTypeFor,
      }),
      this.ctx.logger,
    )

    // The viewer's add form reads the kind catalogue through `nc.listTargetKinds`.
    const ncHandlers = makeNcTargetHandlers({ provider })

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
