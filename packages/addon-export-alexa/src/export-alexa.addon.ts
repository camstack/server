/**
 * Alexa Smart Home Skill export addon — hub-side.
 *
 * Architecture:
 *   Alexa Cloud --> user-owned AWS Lambda --> HTTPS --> this addon
 *                                                       (hub Fastify)
 *
 * One addon serves several skills (planning#422). Each skill is an integration instance (a
 * `skills` record) with its own account links, exposure and hidden state, run by one
 * {@link SkillRuntime}. This file is the shell they share: the instances provider, the
 * `device-export` provider, the routes, the OAuth client, the snapshot store and the access gate.
 * The first skill, `export-alexa`, keeps the URLs and the legacy ledger keys it had before.
 *
 * Capabilities registered:
 *   - `device-export` (collection)      — operator picks which devices to
 *     surface to each skill. The exposed list drives its Discovery response.
 *   - `addon-routes` (collection)       — mounts the directive endpoints
 *     under the hub's `/addon/export-alexa/*` catch-all.
 *   - `oauth-integration` (collection)  — declares this addon as a
 *     linkable OAuth client of the hub's core `/oauth2/*` server.
 *   - `integration-instances`           — the skills themselves.
 *
 * Persistence:
 *   The skill, its account links, what it exposes and its hidden state are records
 *   (`skills`, `skill-links`, `skill-exports`, `skill-state`), one row per instance id. What is
 *   left on `this.config` is shared by every skill (the snapshot signing key) or retired.
 */
import { randomUUID } from 'node:crypto'
import {
  type AddonInitResult,
  addonRoutesCapability,
  BaseAddon,
  buildAddonRouteProvider,
  type ConfigSectionWithValues,
  type ConfigUISchema,
  type ConfigUISchemaWithValues,
  DeviceType,
  defineAddonMigrations,
  deviceExportCapability,
  deviceExportStatusInstanceOf,
  ExportInstanceUnknownError,
  type IAddonRouteProvider,
  type IDeviceExportProvider,
  integrationInstancesCapability,
  isSecretMarker,
  type IOauthIntegrationProvider,
  oauthIntegrationCapability,
  type RecordKindHandle,
  RecordIntegrationInstances,
  RevConflictError,
  isInstanceEnabled,
} from '@camstack/types'

import { createHubAccessGate } from './access/hub-access-source.js'
import type { AlexaAccessGate } from './access/access-gate.js'
import { type AlexaSettings, DEFAULT_CONFIG } from './alexa-settings.js'
import { type ExportAlexaActions, exportAlexaActions } from './custom-actions.js'
import { releaseAlexaEgress } from './egress/alexa-rtc-egress.js'
import {
  EGRESS_REAP_INTERVAL_MS,
  logReaped,
  reapDeadEgressHandles,
} from './egress/egress-handle-reaper.js'
import { forgetEgressHandle, heldEgressHandles } from './handlers/rtc-session.js'
import { buildRoutes } from './http-server.js'
import { generateIngressToken } from './ingress-token.js'
import { pickSkill } from './instance-routing.js'
import { ADDON_MIGRATIONS, type AlexaCataloguePorts } from './migrations/index.js'
import { buildAlexaOauthIntegration } from './oauth-integration.js'
import { createPublicEndpointReader, type PublicEndpointReader } from './public-endpoint.js'
import { buildAlexaInstanceSections } from './settings-schema.js'
import {
  ALEXA_INSTANCE_ID,
  ALEXA_SKILL_DEFAULT_BODY,
  type AlexaSkillBody,
  alexaSkillExportsKind,
  alexaSkillLinksKind,
  alexaSkillsKind,
  alexaSkillStateKind,
} from './skill-records.js'
import {
  type LegacyLedgerPort,
  SkillRuntime,
  type SkillRuntimeHost,
  type UnlinkAlexaResult,
} from './skill-runtime.js'
import { deleteSkillRows } from './skill-cleanup.js'
import { SnapshotStore } from './snapshots/snapshot-store.js'
import { z } from 'zod'

export type { AlexaRegion, AlexaSettings, SkillMode } from './alexa-settings.js'
export { effectiveAlexaSettings } from './alexa-settings.js'
export type { UnlinkAlexaResult }

/** UI filter for the Export picker. `alarm-panel` publishes an
 *  `Alexa.SecurityPanelController` endpoint (`endpoints/builder.ts`). */
const SUPPORTED_KINDS: readonly string[] = [
  'camera',
  'doorbell',
  DeviceType.AlarmPanel,
  // R5 (D775): non-camera devices with an Alexa interface — see
  // `endpoints/generic-device.ts` for which caps map and which do not.
  DeviceType.Light,
  DeviceType.Switch,
  DeviceType.Siren,
  DeviceType.Sensor,
  DeviceType.Lock,
  DeviceType.Presence,
  DeviceType.Thermostat,
  // D874: an air conditioner (Gree) is a `climate` device, not a thermostat.
  DeviceType.Climate,
  // D869: blinds, shutters, awnings, curtains (a garage door or gate is selectable
  // but withheld until the confirmation-gated phase).
  DeviceType.Cover,
  DeviceType.Generic,
]

const VerifiedTokenSchema = z.object({ userId: z.string() }).nullable()

/** Whether a stored token entry still carries a keychain marker instead of a resolved credential. */
function hasUnresolvedCredential(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false
  return (
    ('accessToken' in entry && isSecretMarker(entry.accessToken)) ||
    ('refreshToken' in entry && isSecretMarker(entry.refreshToken)) ||
    ('brokerCredential' in entry && isSecretMarker(entry.brokerCredential))
  )
}

const EXPORT_ALEXA_ADDON_ID = 'export-alexa'

export class ExportAlexaAddon extends BaseAddon<AlexaSettings> {
  /** Hidden state that is a credential — kept in the keychain, never the blob (D787). */
  protected override readonly secretStatePaths = [
    // Declared only so the migration resolves a legacy marker; the live token is the `skill-state` record's.
    'ingressToken',
    'snapshotSigningKey',
    'tokens[userId].accessToken',
    'tokens[userId].refreshToken',
    'tokens[userId].brokerCredential',
  ]

  private readonly snapshotStore = new SnapshotStore(() => this.config.snapshotSigningKey)
  private readonly publicEndpoint: PublicEndpointReader = createPublicEndpointReader(() =>
    this.ctx.api.localNetwork.getAddresses.query(),
  )
  private accessGateRef: AlexaAccessGate | null = null
  private instances: RecordIntegrationInstances<AlexaSkillBody> | null = null
  /** The running skills, by instance id (disabled ones are absent). */
  private readonly runtimes = new Map<string, SkillRuntime>()
  private handles: SkillRuntimeHost['handles'] | null = null

  constructor() {
    super({ ...DEFAULT_CONFIG })
  }

  private requireInstances(): RecordIntegrationInstances<AlexaSkillBody> {
    if (this.instances === null) throw new Error('export-alexa: instances are not initialised')
    return this.instances
  }

  private requireHandles(): SkillRuntimeHost['handles'] {
    if (this.handles === null) throw new Error('export-alexa: records are not declared yet')
    return this.handles
  }

  private requireGate(): AlexaAccessGate {
    if (this.accessGateRef === null) throw new Error('export-alexa: access gate not initialized')
    return this.accessGateRef
  }

  /** The runtime of a skill, or a typed refusal naming it: a device-export call never guesses one. */
  private runtimeOf(instanceId: string | undefined): SkillRuntime {
    const id = instanceId ?? ALEXA_INSTANCE_ID
    const runtime = this.runtimes.get(id)
    if (runtime === undefined) throw new ExportInstanceUnknownError(EXPORT_ALEXA_ADDON_ID, id)
    return runtime
  }

  /** The first skill first, then the rest in id order: the section that draws the shared fields. */
  private orderedRuntimes(): readonly SkillRuntime[] {
    return [...this.runtimes.values()].sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
      return a.instanceId.localeCompare(b.instanceId)
    })
  }

  private host(): SkillRuntimeHost {
    return {
      ctx: this.ctx,
      publicEndpoint: this.publicEndpoint,
      snapshotStore: this.snapshotStore,
      accessGate: this.requireGate(),
      settings: () => this.config,
      handles: this.requireHandles(),
      legacyLedger: (instanceId): LegacyLedgerPort | null =>
        instanceId === ALEXA_INSTANCE_ID
          ? {
              read: () => ({
                linkedAccounts: this.config.linkedAccounts,
                tokens: this.config.tokens,
              }),
              write: async (patch) => {
                await this.updateGlobalSettings({
                  ...(patch.linkedAccounts === undefined
                    ? {}
                    : { linkedAccounts: patch.linkedAccounts }),
                  ...(patch.tokens === undefined ? {} : { tokens: patch.tokens }),
                })
              },
            }
          : null,
      linkedUserIdsElsewhere: async (instanceId) => {
        const users = new Set<string>()
        for (const [id, runtime] of this.runtimes) {
          if (id === instanceId) continue
          for (const account of runtime.ledgers().linkedAccounts) users.add(account.userId)
        }
        // A skill that is switched off still has links: its Lambda comes back with the same users.
        const rows = await this.requireHandles().links.query({ limit: 1000 })
        for (const row of rows.records) {
          if (row.id === instanceId) continue
          for (const account of row.data.linkedAccounts) users.add(account.userId)
        }
        return users
      },
    }
  }

  protected async onInitialize(): Promise<AddonInitResult<ExportAlexaActions>> {
    // The retired `publicHubUrl` setting is deleted through the migration engine.
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('export-alexa needs ctx.records — check execution.placement (hub-only)')
    }
    await records.declare({
      skills: alexaSkillsKind,
      'skill-links': alexaSkillLinksKind,
      'skill-exports': alexaSkillExportsKind,
      'skill-state': alexaSkillStateKind,
    })
    this.handles = {
      skills: records.kind(alexaSkillsKind),
      links: records.kind(alexaSkillLinksKind),
      exports: records.kind(alexaSkillExportsKind),
      state: records.kind(alexaSkillStateKind),
    }
    this.instances = new RecordIntegrationInstances(records, alexaSkillsKind, {
      description: {
        role: 'services',
        instanceMode: 'multiple',
        kind: 'skills',
        canTest: false,
      },
      formSchema: (id) => this.skillForm(id),
      // A new skill has its own Lambda: it enforces its ingress token from the start (public mode too).
      initialBody: (name): AlexaSkillBody => ({
        ...ALEXA_SKILL_DEFAULT_BODY,
        enforceIngressToken: true,
        name,
      }),
      mintId: () => `alexa-skill-${randomUUID().slice(0, 8)}`,
      health: (body, id) => {
        if (!isInstanceEnabled(body)) return { status: { state: 'off', label: 'Off' } }
        const runtime = this.runtimes.get(id)
        if (runtime === undefined) return { status: { state: 'unknown' } }
        const linked = runtime.ledgers().linkedAccounts.length
        return linked > 0
          ? { status: { state: 'ok', label: `${linked} linked account(s)` } }
          : { status: { state: 'unknown', label: 'Not linked yet' } }
      },
      configured: () => true,
      onChanged: (id, change) => this.onInstanceChanged(id, change),
    })
    await this.runMigrations(defineAddonMigrations(ADDON_MIGRATIONS, this.migrationPorts()))

    // The snapshot URL signing key (R2). Generated once, hidden, rotated by
    // nothing: a minted URL lives ten minutes. Shared by every skill.
    if (!this.config.snapshotSigningKey) {
      await this.updateGlobalSettings({
        snapshotSigningKey: generateIngressToken(),
      })
    }

    // D753: the hub never holds the skill's LWA client secret. A custom-skill
    // hub configured before D753 may still have one stored — remove it.
    if (this.config.lwaClientSecret) {
      await this.clearSecrets(['lwaClientSecret'])
      this.ctx.logger.warn(
        'export-alexa: removed a stored LWA client secret — the hub no longer uses one; your skill Lambda holds it (D753)',
      )
    }

    this.accessGateRef = createHubAccessGate(this.ctx)

    // A failed read of a skill's exposure record stops its start (and the boot): serving an
    // empty membership would delete every device from Alexa on the next reconcile.
    for (const row of await this.requireInstances().listResolved()) {
      if (!row.enabled) continue
      await this.startRuntime(row.id)
    }

    const ownInstance = (instanceId: string | undefined): SkillRuntime => this.runtimeOf(instanceId)
    const deviceExportProvider: IDeviceExportProvider = {
      getStatus: async (input) => {
        const runtime = ownInstance(deviceExportStatusInstanceOf(input))
        return {
          linkState: runtime.ledgers().linkedAccounts.length > 0 ? 'linked' : 'unlinked',
          exposedDeviceCount: runtime.exposedDevices.length,
          setup: await runtime.buildSetupBlock(),
        }
      },
      listInstances: async () => {
        const rows = await this.requireInstances().listResolved()
        return rows.map((row) => ({
          instanceId: row.id,
          name: row.body.name,
          enabled: row.enabled,
          kind: 'alexa-skill',
        }))
      },
      listSupportedDeviceKinds: async ({ instanceId }) => {
        ownInstance(instanceId)
        return [...SUPPORTED_KINDS]
      },
      listExposedDevices: async ({ instanceId }) =>
        ownInstance(instanceId).exposedDevices.map((e) => ({
          deviceId: String(e.deviceId),
        })),
      exposeDevice: async ({ instanceId, deviceId }) =>
        ownInstance(instanceId).exposeDevice(deviceId),
      unexposeDevice: async ({ instanceId, deviceId }) =>
        ownInstance(instanceId).unexposeDevice(deviceId),
      listSupportedEntityKinds: async () => ['device', 'action'],
      listExposedEntities: async ({ instanceId }) => {
        const runtime = ownInstance(instanceId)
        await runtime.scenes.reconcile()
        return [
          ...runtime.exposedDevices.map((e) => ({
            entity: { kind: 'device' as const, deviceId: String(e.deviceId) },
          })),
          ...runtime.scenes.list(),
        ]
      },
      exposeEntity: async ({ instanceId, entity }) => {
        const runtime = ownInstance(instanceId)
        if (entity.kind === 'device') return runtime.exposeDevice(entity.deviceId)
        if (entity.kind === 'action') return runtime.scenes.expose(entity.actionId)
        throw new Error('export-alexa: a notification target cannot be exported to Alexa')
      },
      unexposeEntity: async ({ instanceId, entity }) => {
        const runtime = ownInstance(instanceId)
        if (entity.kind === 'device') return runtime.unexposeDevice(entity.deviceId)
        if (entity.kind === 'action') return runtime.scenes.unexpose(entity.actionId)
        throw new Error('export-alexa: a notification target cannot be exported to Alexa')
      },
      getDeviceSettingsContribution: (input) =>
        // `device-export` types deviceId as a string; our exposed entries key
        // on numbers — coerce so `findEntry`'s strict === matches (otherwise an
        // exposed camera renders as "off" in device-details).
        this.buildDeviceSettingsContribution(Number(input.deviceId)),
      getDeviceLiveContribution: async () => null,
      applyDeviceSettingsPatch: (input) =>
        this.applyDeviceSettingsPatch(Number(input.deviceId), input.patch),
    }

    const routes = buildRoutes({
      ctx: this.ctx,
      logger: this.ctx.logger,
      resolveSkill: (lookup) => {
        const skill = pickSkill(
          [...this.runtimes.values()].map((r) => ({
            id: r.instanceId,
            enabled: true,
            ingressToken: r.ingressToken,
            runtime: r,
          })),
          lookup,
        )
        return skill === null ? null : skill.runtime.routed()
      },
      publicEndpoint: this.publicEndpoint,
      snapshotRoute: {
        store: this.snapshotStore,
        // Snapshots are served while ANY skill has them on; the signed URL is the same for all.
        enabled: () => [...this.runtimes.values()].some((r) => r.effectiveSettings().snapshots),
        verifyToken: (token) => this.verifyAccountLinkToken(token),
        mayView: async (userId, deviceId) => {
          const gate = this.requireGate()
          const lookup = await gate.principal(userId)
          if (lookup.kind !== 'found') return false
          return (await gate.allows(lookup.principal, deviceId, 'view')) === 'allowed'
        },
        logger: this.ctx.logger,
      },
    })
    const routeProvider: IAddonRouteProvider = buildAddonRouteProvider('export-alexa', routes)

    // The `export-alexa` OAuth client. Static apart from the operator's chosen
    // public origin — see oauth-integration.ts. Read on the authorize path, so
    // it must never sit behind an await, and this addon must not register it
    // behind one either: a provider goes live only when `onInitialize` returns.
    const oauthIntegrationProvider: IOauthIntegrationProvider = {
      getDescriptor: async () => {
        const endpoint = await this.publicEndpoint()
        if (!endpoint.ok) {
          // No origin to bake: the link would carry the hub-global fallback, and the
          // directive route then refuses it by name. Say so at the moment it is issued.
          this.ctx.logger.warn(
            `export-alexa: linking without a routing claim — ${endpoint.reason.code}: ${endpoint.reason.message}`,
          )
        }
        return buildAlexaOauthIntegration(endpoint.ok ? endpoint.origin : undefined)
      },
    }

    // Reclaim an egress whose session died without a `SessionDisconnected`.
    // See `egress-handle-reaper.ts` for the twenty minutes of transcoding that
    // absence cost on 2026-09-13. One sweep for the whole addon: handles are not per skill.
    const reaper = setInterval(() => {
      void this.reapDeadEgressHandles()
    }, EGRESS_REAP_INTERVAL_MS)
    reaper.unref?.()
    this.ctx.addDisposer(async () => clearInterval(reaper))

    this.ctx.logger.info('export-alexa: initialized', {
      meta: {
        skills: this.runtimes.size,
        exposedCount: [...this.runtimes.values()].reduce((n, r) => n + r.exposedDevices.length, 0),
      },
    })

    return {
      providers: [
        { capability: deviceExportCapability, provider: deviceExportProvider },
        {
          capability: integrationInstancesCapability,
          provider: this.requireInstances().toProvider(),
        },
        { capability: addonRoutesCapability, provider: routeProvider },
        {
          capability: oauthIntegrationCapability,
          provider: oauthIntegrationProvider,
        },
      ],
      customActions: exportAlexaActions,
      actionHandlers: {
        regenerateIngressToken: async (input) =>
          this.runtimeOf(input?.instanceId).regenerateIngressToken(),
        revealIngressToken: async (input) => this.runtimeOf(input?.instanceId).revealIngressToken(),
        resyncDiscovery: async (input) => this.runtimeOf(input?.instanceId).resyncDiscovery(),
        removeAlexaEndpoints: async ({ endpointIds, instanceId }) =>
          this.runtimeOf(instanceId).removeAlexaEndpoints(endpointIds),
        unlinkAlexaAccounts: async (input) =>
          this.runtimeOf(input?.instanceId).unlinkAlexaAccounts(),
        rotateBrokerCredential: async (input) =>
          this.runtimeOf(input?.instanceId).rotateBrokerCredentials(),
      },
    }
  }

  protected override async onShutdown(): Promise<void> {
    for (const runtime of this.runtimes.values()) await runtime.stop()
    this.runtimes.clear()
  }

  protected override async onConfigChanged(): Promise<void> {
    for (const runtime of this.runtimes.values()) await runtime.applyShapeSwitches()
  }

  // ── Skills ──────────────────────────────────────────────────────

  /** Build and start the runtime of one skill. */
  private async startRuntime(instanceId: string): Promise<void> {
    const runtime = new SkillRuntime(instanceId, this.host())
    await runtime.start()
    this.runtimes.set(instanceId, runtime)
  }

  private async stopRuntime(instanceId: string): Promise<void> {
    const runtime = this.runtimes.get(instanceId)
    if (runtime === undefined) return
    this.runtimes.delete(instanceId)
    await runtime.stop()
  }

  /** A skill was created, edited, switched or deleted: bring its runtime in line with the record. */
  private async onInstanceChanged(
    id: string,
    change: 'created' | 'updated' | 'enabled' | 'deleted',
  ): Promise<void> {
    if (change === 'deleted') {
      await this.stopRuntime(id)
      await this.deleteSkillRows(id)
      return
    }
    const row = await this.requireInstances().readResolved(id)
    if (row === null || !row.enabled) {
      await this.stopRuntime(id)
      return
    }
    const running = this.runtimes.get(id)
    if (running === undefined) {
      await this.startRuntime(id)
      return
    }
    await running.refreshRecords()
    await running.applyShapeSwitches()
  }

  /** What a deleted skill leaves behind: its links, its exposure and its hidden state. */
  private async deleteSkillRows(id: string): Promise<void> {
    await deleteSkillRows(this.requireHandles(), id)
    this.ctx.logger.info('export-alexa: skill deleted; its links, exposure and state are gone', {
      meta: { instanceId: id },
    })
  }

  /** The instance form: how the skill reaches this hub and what each camera carries. */
  private skillForm(id: string | null): ConfigUISchema {
    return {
      sections: buildAlexaInstanceSections({
        defaults: ALEXA_SKILL_DEFAULT_BODY,
        instanceId: id,
        legacy: id === null || id === ALEXA_INSTANCE_ID,
        now: Date.now(),
        ...this.formState(id),
      }),
    }
  }

  /** What the form shows about a running skill (nothing for the create form). */
  private formState(id: string | null): {
    readonly linkedAccounts: AlexaSettings['linkedAccounts']
    readonly tokens: AlexaSettings['tokens']
  } {
    const runtime = id === null ? undefined : this.runtimes.get(id)
    if (runtime === undefined) return { linkedAccounts: [], tokens: [] }
    const { linkedAccounts, tokens } = runtime.ledgers()
    return { linkedAccounts, tokens }
  }

  /** The ports of the settings migrations: the old settings in, the records out. */
  private migrationPorts(): AlexaCataloguePorts {
    const { skills, links, exports: exportsHandle, state: stateHandle } = this.requireHandles()
    const putOnce = async <T extends { readonly name: string }>(
      handle: RecordKindHandle<T>,
      body: T,
    ): Promise<'created' | 'exists'> => {
      if ((await handle.get(ALEXA_INSTANCE_ID)) !== null) return 'exists'
      try {
        await handle.put({ id: ALEXA_INSTANCE_ID, data: body }, { ifRev: 0 })
      } catch (err: unknown) {
        if (err instanceof RevConflictError) return 'exists'
        throw err
      }
      return 'created'
    }
    return {
      readStored: async (): Promise<Readonly<Record<string, unknown>>> => {
        const stored = await this.resolveGlobalStore()
        // A credential that is still a marker was not resolved: abort before anything is written.
        const tokens = stored['tokens']
        if (Array.isArray(tokens) && tokens.some(hasUnresolvedCredential)) {
          throw new Error('the old Amazon push grants could not be resolved')
        }
        return stored
      },
      readRawStored: async (): Promise<Readonly<Record<string, unknown>>> =>
        (await this.ctx.settings?.readAddonStore()) ?? {},
      warn: (message: string) => {
        this.ctx.logger.warn(message, {
          tags: { topic: 'export-alexa', phase: 'migration' },
        })
      },
      putSkill: (body) => putOnce(skills, body),
      putLinks: (body) => putOnce(links, body),
      putExports: (body) => putOnce(exportsHandle, body),
      readExports: async () => (await exportsHandle.get(ALEXA_INSTANCE_ID))?.data ?? null,
      replaceLinks: async (body) => {
        await links.put({ id: ALEXA_INSTANCE_ID, data: body })
      },
      readLinks: async () => (await links.getResolved(ALEXA_INSTANCE_ID))?.data ?? null,
      hasSkill: async () => (await skills.get(ALEXA_INSTANCE_ID)) !== null,
      clearOldTokenSecrets: async () => {
        await this.clearSecrets(['tokens'])
      },
      hasInstanceRecords: async () =>
        (await links.get(ALEXA_INSTANCE_ID)) !== null ||
        (await exportsHandle.get(ALEXA_INSTANCE_ID)) !== null,
      putState: (body) => putOnce(stateHandle, body),
      readState: async () => (await stateHandle.getResolved(ALEXA_INSTANCE_ID))?.data ?? null,
      clearIngressTokenSecret: async () => {
        await this.clearSecrets(['ingressToken'])
      },
    }
  }

  // ── Alexa account-link tokens ───────────────────────────────────

  /**
   * Whether `token` is a live account-link token, and for whom: the same credential check
   * `/directive` runs. An unknown or expired token answers null (the snapshot route refuses).
   */
  private async verifyAccountLinkToken(token: string): Promise<{ userId: string } | null> {
    const raw: unknown = await this.ctx.api.userManagement.oauthVerifyAccessToken.query({ token })
    const parsed = VerifiedTokenSchema.safeParse(raw)
    return parsed.success && parsed.data !== null ? { userId: parsed.data.userId } : null
  }

  // ── Egress reaper ───────────────────────────────────────────────

  /**
   * One sweep: ask the broker which held sessions are still alive, and release
   * the transcodes the dead ones are still holding.
   */
  private async reapDeadEgressHandles(): Promise<void> {
    const held = heldEgressHandles()
    if (held.length === 0) return
    const dead = await reapDeadEgressHandles({
      held,
      isAlive: async (handle) => {
        try {
          const state = await this.ctx.api.webrtcSession.getSessionState.query({
            deviceId: handle.deviceId,
            sessionId: handle.sessionId,
          })
          return state.alive
        } catch {
          // A read that failed is NOT a death. Keeping a live session's
          // transcode costs a process; releasing it blacks out a working Echo.
          return null
        }
      },
    })
    for (const handle of dead) {
      logReaped(this.ctx.logger, handle)
      forgetEgressHandle(handle)
      await releaseAlexaEgress({
        api: this.ctx.api,
        deviceId: handle.deviceId,
        pipelineKey: handle.pipelineKey,
        logger: this.ctx.logger,
      }).catch(() => {
        // `releaseAlexaEgress` never throws by contract; the catch is here so a
        // future change to it cannot take the sweep down with it.
      })
    }
  }

  // ── Device-details contribution ─────────────────────────────────
  //
  // The per-device "Alexa Export" panel: one section per running skill, so a device can be
  // exposed to each skill separately. The device's own preferences (Alexa name, detection
  // classes) are drawn once, by the first skill.

  private async buildDeviceSettingsContribution(
    deviceId: number,
  ): Promise<ConfigUISchemaWithValues | null> {
    const runtimes = this.orderedRuntimes()
    const first = runtimes[0]
    if (first === undefined) return null
    const kind = await first.exportKindOf(deviceId)
    if (kind === null) return null
    const sections: ConfigSectionWithValues[] = []
    for (const [index, runtime] of runtimes.entries()) {
      sections.push(
        await runtime.buildDeviceSection(deviceId, kind, {
          title: runtimes.length === 1 ? 'Alexa Export' : `Alexa Export — ${runtime.skillName}`,
          order: 100 + index,
          shared: index === 0,
        }),
      )
    }
    return { sections }
  }

  private async applyDeviceSettingsPatch(
    deviceId: number,
    patch: Record<string, unknown>,
  ): Promise<{ success: true }> {
    const runtimes = this.orderedRuntimes()
    const first = runtimes[0]
    if (first === undefined) return { success: true }
    // The device's own preferences are saved once, before any skill applies its part: an
    // expose in the same patch then builds with them.
    const shared = await first.applySharedPrefs(deviceId, patch)
    for (const runtime of runtimes) await runtime.applyEntryPatch(deviceId, patch, shared)
    return { success: true }
  }
}

export default ExportAlexaAddon
