/**
 * The hub half of an `integration-instances` create and delete for an instance that brings
 * DEVICES (epic #440, step H3). The addon owns the record; the hub owns what hangs off it:
 *
 *  - create: the unique-instance check, the connection test of D1016 (`testInstance`, the only
 *    test), the `integrations` registry row (with the discovery candidate it was set up from,
 *    D984), then the addon's record, and a rollback that leaves nothing behind;
 *  - delete: refuse a fixed builtin and an instance a link still names BEFORE anything is
 *    destroyed, remove the integration's devices through the device manager (its tombstone path,
 *    D865), then the record, the registry row and the `IntegrationDeleted` event.
 *
 * There is ONE create door: the registered `integration-instances` provider
 * ({@link withInstanceLifecycle}), which calls {@link createRegisteredInstance}. A seed (an
 * addon making its own fixed or migrated instance) goes through the same door and is accepted
 * only from the addon it names. Delete has one caller of {@link deleteRegisteredInstance}: the
 * provider's `deleteInstance` (`integrations` has no delete method).
 */
import { IntegrationRegistry } from '@camstack/server/system'
import type {
  IIntegrationInstancesProvider,
  IIntegrationRegistry,
  Integration,
  IntegrationInstance,
  IntegrationRole,
  IntegrationTestConnectionStatus,
  IScopedLogger,
} from '@camstack/types'
import { bareAddonId, EventCategory, errMsg } from '@camstack/types'
import { TRPCError } from '@trpc/server'
import { planDeleteTimeStamps } from '../../boot/integration-id-backfill'
import { bringsDevices, describedRoleOf } from '../../api/core/integration-role'
import type { EventBusService } from '../events/event-bus.service'
import {
  assertInstanceDeletable,
  type InstanceHolder,
  type InstanceLifecycleWrap,
  InstanceLinksIndex,
} from './instance-links.service'

/** The slice of the `device-manager` singleton the delete cascade uses. */
export interface DeviceCascadePort {
  readonly removeByIntegration?: (input: { integrationId: string }) => Promise<{ removed: number }>
  readonly listAll?: (input: Record<string, never>) => Promise<
    readonly {
      id: number
      addonId: string
      parentDeviceId: number | null
      integrationId?: string
    }[]
  >
  readonly setIntegrationId?: (input: { deviceId: number; integrationId: string }) => Promise<void>
}

/** What the lifecycle needs from the hub. Every member is read when used. */
export interface InstanceLifecycleDeps {
  readonly logger: IScopedLogger
  /** The registry; throws when its records are still being wired. */
  readonly integrations: () => IIntegrationRegistry
  readonly deviceManager: () => DeviceCascadePort | null
  readonly eventBus: Pick<EventBusService, 'emit'>
  /** The addon's own `integration-instances` provider, or null. */
  readonly providerFor: (addonId: string) => IIntegrationInstancesProvider | null
  readonly holders: () => readonly InstanceHolder[]
  /** The manifest's explicit `integrationRole`, an addon-wide override. */
  readonly manifestRole: (addonId: string) => IntegrationRole | undefined
}

/** The addon that keeps the MQTT brokers: the instance a `brokerId` names lives there. */
const BROKER_OWNER_ADDON_ID = 'mqtt-broker'

/** What a pre-creation test concluded, and who concluded it. */
export interface ConnectionTestVerdict {
  readonly status: IntegrationTestConnectionStatus
  readonly error?: string
  readonly latencyMs?: number
  readonly detail?: string
  /** Addon id whose declared test answered; null when none did. */
  readonly testedBy: string | null
}

async function findBrokerOwner(
  deps: InstanceLifecycleDeps,
  addonId: string,
  brokerId: string,
): Promise<{ readonly addonId: string; readonly provider: IIntegrationInstancesProvider } | null> {
  for (const candidateId of [BROKER_OWNER_ADDON_ID, addonId]) {
    const candidate = deps.providerFor(candidateId)
    if (candidate === null || candidate.testInstance === undefined) continue
    const rows = await candidate.listInstances()
    if (rows.some((row) => row.id === brokerId))
      return { addonId: candidateId, provider: candidate }
  }
  return null
}

/**
 * Run the pre-creation test for `(addonId, settings)` through `testInstance`, the one test
 * method (D1016). Never throws: a test that blows up is `inconclusive`, which is emphatically
 * NOT `rejected`. An addon that declares no test is a KNOWN `unsupported`, never a silent pass.
 */
export async function testBeforeCreate(
  deps: InstanceLifecycleDeps,
  addonId: string,
  settings: Record<string, unknown>,
  kind: string | undefined,
): Promise<ConnectionTestVerdict> {
  const { logger } = deps
  const instances = deps.providerFor(addonId)
  let declaresTest = false
  if (instances !== null && instances.testInstance !== undefined) {
    try {
      const described = await instances.describe()
      const declaredKind = (described.kinds ?? []).find((k) => k.id === kind)
      declaresTest = declaredKind?.canTest ?? described.canTest
    } catch (err) {
      logger.warn('could not read whether the integration declares a test', {
        tags: { addonId },
        meta: { phase: 'test', error: errMsg(err) },
      })
    }
  }
  if (instances !== null && instances.testInstance !== undefined && declaresTest) {
    try {
      const result = await instances.testInstance({
        id: null,
        values: settings,
        ...(kind !== undefined ? { kind } : {}),
      })
      const status = result.status ?? (result.success ? 'validated' : 'rejected')
      return {
        status,
        testedBy: addonId,
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
      }
    } catch (err) {
      logger.warn('connection test could not run', {
        tags: { addonId },
        meta: { phase: 'test', error: errMsg(err) },
      })
      return {
        status: 'inconclusive',
        error: `Connection test could not run: ${errMsg(err)}`,
        testedBy: addonId,
      }
    }
  }

  // Broker-backed integrations carry their connection identity as a `brokerId`; the broker owns
  // the real semantic check. Reached because the settings NAME a broker, not because nothing
  // else matched.
  const brokerId = settings['brokerId']
  if (typeof brokerId === 'string' && brokerId.length > 0) {
    try {
      const owner = await findBrokerOwner(deps, addonId, brokerId)
      if (owner === null || owner.provider.testInstance === undefined) {
        logger.warn('no instances provider owns the broker a create names', {
          tags: { addonId },
          meta: { phase: 'test', brokerId },
        })
        return {
          status: 'inconclusive',
          error: `No instances provider that owns broker '${brokerId}' is available`,
          testedBy: null,
        }
      }
      const result = await owner.provider.testInstance({ id: brokerId, values: {} })
      const status = result.status ?? (result.success ? 'validated' : 'rejected')
      return {
        status,
        testedBy: owner.addonId,
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
      }
    } catch (err) {
      logger.warn('broker connection test could not run', {
        tags: { addonId },
        meta: { phase: 'test', brokerId, error: errMsg(err) },
      })
      return {
        status: 'inconclusive',
        error: `Broker test could not run: ${errMsg(err)}`,
        testedBy: addonId,
      }
    }
  }

  return {
    status: 'unsupported',
    error:
      `Integration '${addonId}' declares no connection test, ` +
      `so these settings cannot be validated before it is created.`,
    testedBy: null,
  }
}

/** What a create is asked to make. */
export interface RegisteredCreateInput {
  readonly addonId: string
  readonly name: string
  readonly info?: Record<string, unknown>
  /** The discovery candidate the form was seeded from (D984). */
  readonly originStableId?: string | undefined
  /** The instance kind, for a provider with several. */
  readonly kind?: string | undefined
  readonly settings?: Record<string, unknown> | undefined
}

/**
 * Create the registry row and the addon's record behind it, gated by the connection test.
 * `instances` is the addon's provider (the RAW one: this is what the wrapper itself calls), or
 * null for an addon with no record, which keeps only the row.
 */
export async function createRegisteredInstance(
  deps: InstanceLifecycleDeps,
  instances: IIntegrationInstancesProvider | null,
  input: RegisteredCreateInput,
): Promise<Integration> {
  const { logger } = deps
  const reg = deps.integrations()
  const { settings } = input

  if (instances !== null) {
    const described = await instances.describe()
    if (described.instanceMode === 'single') {
      const existing = (await reg.listIntegrations()).filter((i) => i.addonId === input.addonId)
      if (existing.length > 0) {
        logger.warn('rejected duplicate unique', {
          tags: { addonId: input.addonId, integrationId: existing[0]?.id },
          meta: { phase: 'create' },
        })
        throw new TRPCError({
          code: 'CONFLICT',
          message: `Addon "${input.addonId}" is unique-instance and already has an integration (${existing[0]?.id})`,
        })
      }
    }
  }

  // The gate. `rejected` is the one status that blocks: the remote was asked and said no.
  // `unsupported` or `inconclusive` observed NOTHING about the credentials, so they pass, and
  // they SAY SO in the log: silence would read as "validated".
  const verdict = await testBeforeCreate(deps, input.addonId, settings ?? {}, input.kind)
  if (verdict.status === 'rejected') {
    logger.warn('rejected — connection test refused the settings', {
      tags: { addonId: input.addonId },
      meta: { phase: 'create', status: verdict.status, testedBy: verdict.testedBy },
    })
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: verdict.error ?? `Connection test failed for '${input.addonId}'`,
    })
  }
  if (verdict.status === 'validated') {
    logger.info('connection test validated — proceeding', {
      tags: { addonId: input.addonId },
      meta: { phase: 'create', latencyMs: verdict.latencyMs },
    })
  } else {
    logger.warn('creating without validation — the settings were not validated', {
      tags: { addonId: input.addonId },
      meta: { phase: 'create', status: verdict.status, reason: verdict.error },
    })
  }

  const integration = await reg.createIntegration({
    addonId: input.addonId,
    name: input.name,
    ...(input.info !== undefined ? { info: input.info } : {}),
    ...(input.originStableId !== undefined ? { originStableId: input.originStableId } : {}),
  })
  if (instances === null) {
    if (settings !== undefined && Object.keys(settings).length > 0) {
      logger.warn('settings dropped — the addon has no instance record to store them', {
        tags: { integrationId: integration.id, addonId: integration.addonId },
        meta: { phase: 'create', keys: Object.keys(settings) },
      })
    }
    logger.info('persisted', {
      tags: { integrationId: integration.id, addonId: integration.addonId },
      meta: { phase: 'create' },
    })
    return integration
  }

  // The connection is a typed record keyed by the registry id. A refusal removes the row: a
  // registry entry with no record is an orphan, and a record with no entry is one too.
  try {
    await instances.createInstance({
      id: integration.id,
      name: integration.name,
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
    })
    if (settings !== undefined && Object.keys(settings).length > 0) {
      await instances.updateInstance({ id: integration.id, values: settings })
    }
  } catch (err) {
    await instances.deleteInstance({ id: integration.id }).catch((cleanupErr: unknown) => {
      logger.warn('instance record refused: its partial record could not be removed', {
        tags: { integrationId: integration.id, addonId: integration.addonId },
        meta: { phase: 'create-rollback', error: errMsg(cleanupErr) },
      })
    })
    try {
      await reg.deleteIntegration(integration.id)
    } catch (rollbackErr) {
      // The rollback failing must not hide WHY the create was refused.
      logger.warn('instance record refused — registry row could not be removed', {
        tags: { integrationId: integration.id, addonId: integration.addonId },
        meta: { phase: 'create-rollback', error: errMsg(rollbackErr) },
      })
    }
    logger.warn('instance record refused — registry row removed', {
      tags: { integrationId: integration.id, addonId: integration.addonId },
      meta: { phase: 'create', error: errMsg(err) },
    })
    throw err
  }
  logger.info('persisted as an instance record (no restart)', {
    tags: { integrationId: integration.id, addonId: integration.addonId },
    meta: { phase: 'create' },
  })
  return integration
}

/**
 * Delete the integration `integration`: the devices it owns, its record, its registry row, and
 * announce it. A fixed builtin and an instance a link still names are refused BEFORE the first
 * mutation: the device cascade is best-effort and cannot be undone.
 */
export async function deleteRegisteredInstance(
  deps: InstanceLifecycleDeps,
  instances: IIntegrationInstancesProvider | null,
  integration: Integration,
): Promise<void> {
  const { logger } = deps
  const reg = deps.integrations()
  const id = integration.id

  if (IntegrationRegistry.isFixed(integration)) {
    throw new Error(
      `integration "${id}" is fixed — it belongs to the addon that declared it and cannot be deleted`,
    )
  }
  if (instances !== null)
    await assertInstanceDeletable(instances, new InstanceLinksIndex(deps.holders), id)

  logger.info('removing', {
    tags: { integrationId: id, addonId: integration.addonId },
    meta: { phase: 'delete', name: integration.name },
  })

  // Cascade-delete every live device whose integrationId matches. Best-effort: a device-removal
  // hiccup must not abort the integration delete; log and continue so the record and the event
  // always fire.
  const dm = deps.deviceManager()

  // Claim legacy un-tagged devices BEFORE the cascade. Devices created before stamping carry no
  // integrationId, so `removeByIntegration` would leave them orphaned once the integration is
  // gone. While the row still exists, stamp the unambiguous ones.
  if (dm?.listAll && dm?.setIntegrationId) {
    try {
      const [integrations, devices] = await Promise.all([reg.listIntegrations(), dm.listAll({})])
      const stamps = planDeleteTimeStamps(
        id,
        integrations.map((i) => ({ id: i.id, addonId: i.addonId })),
        devices.map((d) => ({
          id: d.id,
          addonId: d.addonId,
          parentDeviceId: d.parentDeviceId,
          ...(d.integrationId !== undefined ? { integrationId: d.integrationId } : {}),
        })),
      )
      for (const stamp of stamps) {
        await dm.setIntegrationId({ deviceId: stamp.deviceId, integrationId: stamp.integrationId })
      }
      if (stamps.length > 0) {
        logger.info('claimed legacy un-tagged devices for cascade', {
          tags: { integrationId: id, addonId: integration.addonId },
          meta: { phase: 'delete', claimed: stamps.length },
        })
      }
    } catch (err) {
      logger.warn('legacy device claim failed (best-effort — continuing)', {
        tags: { integrationId: id },
        meta: { phase: 'delete', error: errMsg(err) },
      })
    }
  }

  if (dm?.removeByIntegration) {
    try {
      const result = await dm.removeByIntegration({ integrationId: id })
      logger.info('cascade-removed devices', {
        tags: { integrationId: id },
        meta: { phase: 'delete', removed: result.removed },
      })
    } catch (err) {
      logger.warn('device cascade-remove failed (best-effort — continuing)', {
        tags: { integrationId: id },
        meta: { phase: 'delete', error: errMsg(err) },
      })
    }
  } else {
    logger.warn('device-manager not available — skipping cascade device removal', {
      tags: { integrationId: id },
      meta: { phase: 'delete' },
    })
  }

  // The record and its keychain refs go first; a refusal stops here, with the registry row still
  // naming what was not removed.
  await instances?.deleteInstance({ id })
  await reg.deleteIntegration(id)

  deps.eventBus.emit({
    id: `integration-deleted-${Date.now()}`,
    timestamp: new Date(),
    source: { type: 'integration', id },
    category: EventCategory.IntegrationDeleted,
    data: { integrationId: id, addonId: integration.addonId },
  })
  logger.info('completed (no restart)', {
    tags: { integrationId: id },
    meta: { phase: 'delete' },
  })
}

/**
 * Whether instances of `kind` of `provider` bring devices (a kind without a role takes the provider's;
 * no `kind` means the default kind, then the addon-wide rule).
 */
async function bringsDevicesOf(
  deps: InstanceLifecycleDeps,
  addonId: string,
  provider: IIntegrationInstancesProvider,
  kind: string | undefined,
): Promise<boolean> {
  const declared = deps.manifestRole(addonId)
  if (declared !== undefined) return bringsDevices(declared)
  const described = await provider.describe()
  // A call without `kind` is the provider's default kind (`described.kind`) when that names a declared kind.
  const wanted = kind ?? described.kind
  const own = (described.kinds ?? []).find((k) => k.id === wanted)
  if (own !== undefined) return bringsDevices(own.role ?? described.role)
  return bringsDevices(describedRoleOf(described) ?? described.role)
}

/** A builtin the hub itself declared (`DeclaredDevices` marks it `fixed`); its switch is the registry flag. */
export function isFixedBuiltin(integration: Integration): boolean {
  return integration.info['fixed'] === true
}

/** Who the transport stamped as the caller of an `integration-instances` call; null when nobody. */
function callerAddonIdOf(input: object): string | null {
  const stamp: unknown = Reflect.get(input, 'callerAddonId')
  return typeof stamp === 'string' && stamp.length > 0 ? stamp : null
}

/** The wrapped providers and the raw ones they stand for. */
const RAW_PROVIDERS = new WeakMap<IIntegrationInstancesProvider, IIntegrationInstancesProvider>()

/** The provider a lifecycle wrapper stands for; a provider that is not wrapped is returned as it is. */
export function rawInstancesProvider(
  provider: IIntegrationInstancesProvider,
): IIntegrationInstancesProvider {
  return RAW_PROVIDERS.get(provider) ?? provider
}

/**
 * The switch of a FIXED builtin: the registry flag, the one store, written here and nowhere else.
 * It needs no addon provider, so a builtin whose addon is down or failed can still be turned back
 * on: `integrations.update({ enabled })` (the hub's own cap, no provider in the path) reaches it
 * directly, and `setInstanceEnabled` reaches it when the provider is up. The enabled / disabled
 * event follows a real change only.
 */
export async function setFixedBuiltinEnabled(
  deps: Pick<InstanceLifecycleDeps, 'integrations' | 'eventBus' | 'logger'>,
  integration: Integration,
  enabled: boolean,
): Promise<void> {
  await deps.integrations().updateIntegration(integration.id, { enabled })
  await emitSwitchEvent(deps, integration, enabled)
}

/** `integration.enabled` / `integration.disabled`, only when the switch actually moved. */
async function emitSwitchEvent(
  deps: Pick<InstanceLifecycleDeps, 'eventBus' | 'logger'>,
  integration: Integration,
  enabled: boolean,
): Promise<void> {
  if (integration.enabled === enabled) return
  deps.logger.info('enabled state changed', {
    tags: { integrationId: integration.id, addonId: integration.addonId },
    meta: { phase: 'set-enabled', enabled },
  })
  deps.eventBus.emit({
    id: `integration-enabled-${integration.id}-${Date.now()}`,
    timestamp: new Date(),
    source: { type: 'integration', id: integration.id },
    category: enabled ? EventCategory.IntegrationEnabled : EventCategory.IntegrationDisabled,
    data: { integrationId: integration.id, addonId: integration.addonId },
  })
}

/**
 * `provider` with a `createInstance` / `deleteInstance` that carry the hub half for an instance
 * that brings devices. An instance of a kind that does not (a notifier, a broker account, a
 * destination) is the addon's record alone and goes straight through, as does a call naming a
 * registry row that already exists (the legacy `integrationInstances.createInstance` made the row first).
 */
export function withInstanceLifecycle(
  addonId: string,
  provider: IIntegrationInstancesProvider,
  deps: InstanceLifecycleDeps,
): IIntegrationInstancesProvider {
  const bare = bareAddonId(addonId)
  const createInstance: IIntegrationInstancesProvider['createInstance'] = async (input) => {
    if (input.seed !== undefined) {
      // The seed variant states an integration the addon OWNS. The transport stamps who called
      // (an HTTP session's claim is stripped), so an operator, or another addon, never gets here.
      const stamp = callerAddonIdOf(input)
      if (stamp === null || bareAddonId(stamp) !== bare) {
        deps.logger.warn('refused: a seed is accepted only from the addon it seeds', {
          tags: { addonId: bare },
          meta: { phase: 'create', stampedBy: stamp },
        })
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: `Only "${bare}" may seed its own integration`,
        })
      }
      const created = await createRegisteredInstance(deps, provider, {
        addonId: bare,
        name: input.name,
        info: input.seed.info,
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.originStableId !== undefined ? { originStableId: input.originStableId } : {}),
        ...(input.values !== undefined ? { settings: input.values } : {}),
      })
      return { id: created.id }
    }
    if (!(await bringsDevicesOf(deps, bare, provider, input.kind))) {
      return provider.createInstance(input)
    }
    const reg = deps.integrations()
    if (input.id !== undefined) {
      const existing = await reg.getIntegration(input.id)
      if (existing !== null && existing.addonId === bare) return provider.createInstance(input)
      deps.logger.warn('rejected: a devices instance takes the id the hub mints', {
        tags: { addonId: bare },
        meta: { phase: 'create', id: input.id },
      })
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Instances of "${bare}" bring devices and take the id the hub mints; "${input.id}" names no integration`,
      })
    }
    const created = await createRegisteredInstance(deps, provider, {
      addonId: bare,
      name: input.name,
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.originStableId !== undefined ? { originStableId: input.originStableId } : {}),
      ...(input.values !== undefined ? { settings: input.values } : {}),
    })
    return { id: created.id }
  }
  const deleteInstance: IIntegrationInstancesProvider['deleteInstance'] = async (input) => {
    const integration = await deps.integrations().getIntegration(input.id)
    if (integration === null || integration.addonId !== bare) return provider.deleteInstance(input)
    await deleteRegisteredInstance(deps, provider, integration)
    return { ok: true as const }
  }
  // A FIXED builtin keeps a name-only record with no flag, which a body reads as "on": its switch
  // is the registry flag, the one store, so the listing reads it and the switch writes it.
  const fixedRow = async (id: string): Promise<Integration | null> => {
    const row = await deps.integrations().getIntegration(id)
    return row !== null && row.addonId === bare && isFixedBuiltin(row) ? row : null
  }
  const withRegistryFlag = async (instance: IntegrationInstance): Promise<IntegrationInstance> => {
    const row = await fixedRow(instance.id)
    return row === null ? instance : { ...instance, enabled: row.enabled }
  }
  const listInstances: IIntegrationInstancesProvider['listInstances'] = async () =>
    Promise.all((await provider.listInstances()).map(withRegistryFlag))
  const getInstance: IIntegrationInstancesProvider['getInstance'] = async (input) => {
    const instance = await provider.getInstance(input)
    return instance === null ? null : withRegistryFlag(instance)
  }
  const setInstanceEnabled: IIntegrationInstancesProvider['setInstanceEnabled'] = async (input) => {
    const fixed = await fixedRow(input.id)
    if (fixed !== null) {
      await setFixedBuiltinEnabled(deps, fixed, input.enabled)
      return { ok: true as const }
    }
    // The switch of an instance lives in its record body: the baseline is what the body said
    // BEFORE the write, never the registry flag (this path does not write it).
    const row = await deps.integrations().getIntegration(input.id)
    const previous =
      row !== null && row.addonId === bare ? await provider.getInstance({ id: input.id }) : null
    const result = await provider.setInstanceEnabled(input)
    if (row !== null && previous !== null) {
      await emitSwitchEvent(deps, { ...row, enabled: previous.enabled !== false }, input.enabled)
    }
    return result
  }
  const wrapped: IIntegrationInstancesProvider = new Proxy(provider, {
    get(target, prop) {
      if (prop === 'createInstance') return createInstance
      if (prop === 'deleteInstance') return deleteInstance
      if (prop === 'listInstances') return listInstances
      if (prop === 'getInstance') return getInstance
      if (prop === 'setInstanceEnabled') return setInstanceEnabled
      const value: unknown = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  RAW_PROVIDERS.set(wrapped, provider)
  return wrapped
}

/**
 * A {@link InstanceLifecycleWrap} that is looked up when a create or delete ARRIVES, not when the
 * provider is registered. A forked holder can register before the hub half exists (the broker
 * is up before `AddonRegistryService` has initialised); capturing the wrap then would leave that
 * holder without the registry row, the test gate and the device cascade for good. Until the
 * wrap exists a create or delete is refused, and says so.
 */
export function deferInstanceLifecycle(
  resolve: () => InstanceLifecycleWrap | null,
  logger: IScopedLogger,
): InstanceLifecycleWrap {
  return (addonId, provider) => {
    const bare = bareAddonId(addonId)
    const wrapNow = (phase: 'create' | 'delete'): IIntegrationInstancesProvider => {
      const wrap = resolve()
      if (wrap !== null) return wrap(addonId, provider)
      logger.warn('refused: the hub half of integration-instances is not ready yet', {
        tags: { addonId: bare },
        meta: { phase },
      })
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `The hub is still starting; "${bare}" cannot ${phase} an instance yet`,
      })
    }
    const createInstance: IIntegrationInstancesProvider['createInstance'] = async (input) =>
      wrapNow('create').createInstance(input)
    const deleteInstance: IIntegrationInstancesProvider['deleteInstance'] = async (input) =>
      wrapNow('delete').deleteInstance(input)
    // Reads and the switch never refuse: before the hub half exists the holder's own answer stands.
    const readNow = (): IIntegrationInstancesProvider => resolve()?.(addonId, provider) ?? provider
    const listInstances: IIntegrationInstancesProvider['listInstances'] = async () =>
      readNow().listInstances()
    const getInstance: IIntegrationInstancesProvider['getInstance'] = async (input) =>
      readNow().getInstance(input)
    const setInstanceEnabled: IIntegrationInstancesProvider['setInstanceEnabled'] = async (input) =>
      readNow().setInstanceEnabled(input)
    const deferred: IIntegrationInstancesProvider = new Proxy(provider, {
      get(target, prop) {
        if (prop === 'createInstance') return createInstance
        if (prop === 'deleteInstance') return deleteInstance
        if (prop === 'listInstances') return listInstances
        if (prop === 'getInstance') return getInstance
        if (prop === 'setInstanceEnabled') return setInstanceEnabled
        const value: unknown = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    RAW_PROVIDERS.set(deferred, rawInstancesProvider(provider))
    return deferred
  }
}
