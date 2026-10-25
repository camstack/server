import { z } from 'zod'
import {
  BaseDevice,
  type ConsumableItem,
  consumablesCapability,
  type InferRuntimeState,
  DeviceType,
  dishwasherCapability,
  errMsg,
  type DeviceContext,
  type DishwasherStatus,
  type InferNativeProvider,
  RUNNING_STATE_COLD,
  type RunningStateStatus,
  runningFromDishwasherOperation,
  runningStateCapability,
} from '@camstack/types'
import { homeConnectConnections, type HomeConnectWatchEvent } from '../home-connect-gateway.js'
import {
  COLD_DISHWASHER_STATUS,
  dishwasherConsumablesFromFeatures,
  dishwasherOptionsFromDescription,
  dishwasherStatusFromFeatures,
  findEntity,
  HC_COMMAND_PAUSE,
  HC_COMMAND_RESUME,
  HC_COMMAND_STOP,
  type HomeConnectView,
} from '../home-connect-domain-mapping.js'
import {
  assertProgramAvailable,
  assertProgramOptions,
  assertWritable,
  type WritableValue,
} from '../home-connect-option-validation.js'
import {
  HOME_CONNECT_INFO_PREFIX,
  HOME_CONNECT_NETWORK_PREFIX,
  type HomeConnectWsClient,
} from '../home-connect-ws-client.js'

export const homeConnectDishwasherSchema = z.object({
  haId: z.string().min(1),
  brokerId: z.string().min(1),
  applianceType: z.string().optional(),
  system: z.literal('home-connect').optional(),
  integrationId: z.string().optional(),
})

export type HomeConnectDishwasherConfig = z.infer<typeof homeConnectDishwasherSchema>

const DISH_CAP = 'dishwasher'
const CONSUMABLES_CAP = 'consumables'
const RUNNING_CAP = 'running-state'

type ConsumablesSlice = InferRuntimeState<typeof consumablesCapability>

const CONSUMABLES_EMPTY: ConsumablesSlice = { items: [], lastChangedAt: 0, lastFetchedAt: 0 }

function sameItems(a: readonly ConsumableItem[], b: readonly ConsumableItem[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The option short names of the boolean setters, in the spellings an appliance uses. */
const OPTION_NAMES = {
  halfLoad: ['HalfLoad'],
  hygienePlus: ['HygienePlus'],
  extraDry: ['ExtraDry'],
  intensiveZone: ['IntensivZone', 'IntensiveZone'],
  varioSpeedPlus: ['VarioSpeedPlus', 'VarioSpeed'],
} as const

export class HomeConnectDishwasherDevice extends BaseDevice<typeof homeConnectDishwasherSchema> {
  readonly features: readonly never[] = []

  readonly #haId: string
  readonly #brokerId: string
  #unwatch: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const persisted = homeConnectDishwasherSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, homeConnectDishwasherSchema, { type: DeviceType.Dishwasher })
    this.#haId = persisted.haId
    this.#brokerId = persisted.brokerId
    void this.updateSourceInfo({ id: this.#haId, system: 'home-connect' })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.registerDishwasherCap()
    this.registerConsumablesCap()
    this.registerRunningCap()
    // Nothing is known yet: publish that, not a status that looks like one.
    this.runtimeState.setCapState(DISH_CAP, COLD_DISHWASHER_STATUS)
    this.runtimeState.setCapState(RUNNING_CAP, RUNNING_STATE_COLD)
    this.markOnline(false)
    this.#unwatch = homeConnectConnections.watch(this.#brokerId, this.#haId, (event) =>
      this.recomputeSlice(event),
    )
    this.recomputeSlice({ kind: 'client' })
  }

  override async removeDevice(): Promise<void> {
    this.#unwatch?.()
    this.#unwatch = null
    await super.removeDevice()
  }

  private client(): HomeConnectWsClient | null {
    return homeConnectConnections.getClient(this.#brokerId)
  }

  private view(): HomeConnectView {
    const client = this.client()
    return {
      features: client?.getFeatures(this.#haId) ?? new Map(),
      description: client?.getDescription(this.#haId) ?? null,
      link: client?.getLinkState(this.#haId) ?? 'disconnected',
    }
  }

  private recomputeSlice(event: HomeConnectWatchEvent): void {
    const previous = this.runtimeState.getCapState<DishwasherStatus>(DISH_CAP)
    // Only a value the slice carries moves its clock: Info.* / Network.* fields do not.
    const carriesValue =
      event.kind === 'feature' &&
      !event.key.startsWith(HOME_CONNECT_INFO_PREFIX) &&
      !event.key.startsWith(HOME_CONNECT_NETWORK_PREFIX)
    const lastValueAt = carriesValue ? Date.now() : (previous?.lastFetchedAt ?? 0)
    const view = this.view()
    const slice = dishwasherStatusFromFeatures({ ...view, lastValueAt })
    this.runtimeState.setCapState(DISH_CAP, slice)
    this.publishRunningSlice(slice)
    this.writeConsumables(dishwasherConsumablesFromFeatures(view))
    this.markOnline(slice.availability !== 'offline')
  }

  /**
   * Salt and rinse aid, as `consumables` items (D915). Written only when they
   * changed; `null` (offline / undescribed) and an empty list write nothing —
   * the slice is restored, and "nothing known now" must not erase the last
   * observation.
   */
  private writeConsumables(items: ConsumableItem[] | null): void {
    if (items === null || items.length === 0) return
    const previous = this.runtimeState.getCapState<ConsumablesSlice>(CONSUMABLES_CAP)
    if (previous !== undefined && sameItems(previous.items, items)) return
    const now = Date.now()
    const next: ConsumablesSlice = { items, lastChangedAt: now, lastFetchedAt: now }
    this.runtimeState.setCapState(CONSUMABLES_CAP, next)
  }

  private registerConsumablesCap(): void {
    const provider: InferNativeProvider<typeof consumablesCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<ConsumablesSlice>(CONSUMABLES_CAP) ?? CONSUMABLES_EMPTY,
      reset: async ({ key }) => {
        throw new Error(`"${key}" has no reset on a dishwasher — refilling it is the reset`)
      },
    }
    this.ctx.registerNativeCap(consumablesCapability, provider)
  }

  private requireClient(): HomeConnectWsClient {
    const client = this.client()
    if (!client)
      throw new Error('Home Connect client unavailable — the integration is not connected')
    if (client.getLinkState(this.#haId) !== 'connected') {
      throw new Error('The appliance is not connected right now')
    }
    return client
  }

  /** Write a command entity of the description (`PauseProgram`, …); refuses one it does not offer. */
  private async command(shortName: string): Promise<void> {
    const client = this.requireClient()
    const entity = findEntity(client.getDescription(this.#haId), ['command'], [shortName])
    if (entity === undefined || entity.available !== true) {
      throw new Error(`This appliance does not offer ${shortName} right now`)
    }
    await this.logged(`command ${shortName}`, client.setFeature(this.#haId, entity.name, true))
  }

  private async setOptionByShortName(
    shortNames: readonly string[],
    value: WritableValue,
  ): Promise<void> {
    const client = this.requireClient()
    const description = client.getDescription(this.#haId)
    const entity = findEntity(description, ['option', 'setting'], shortNames)
    if (entity === undefined) {
      throw new Error(`This appliance has no ${shortNames.join(' / ')} option`)
    }
    await this.writeKey(client, entity.name, value)
  }

  private async writeKey(
    client: HomeConnectWsClient,
    key: string,
    value: WritableValue,
  ): Promise<void> {
    const checked = assertWritable(client.getDescription(this.#haId), key, value)
    await this.logged(`set ${checked}`, client.setFeature(this.#haId, checked, value))
  }

  /** A write that fails says so on the device's own log line, then fails to the caller. */
  private async logged(what: string, pending: Promise<void>): Promise<void> {
    try {
      await pending
    } catch (err: unknown) {
      this.ctx.logger.warn(`Home Connect ${what} failed`, {
        tags: { deviceId: this.id },
        meta: { error: errMsg(err) },
      })
      throw err
    }
  }

  private registerDishwasherCap(): void {
    const provider: InferNativeProvider<typeof dishwasherCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<DishwasherStatus>(DISH_CAP) ?? COLD_DISHWASHER_STATUS,
      getOptions: async () => dishwasherOptionsFromDescription(this.view()),
      start: async ({ program, options }) => {
        const client = this.requireClient()
        const description = client.getDescription(this.#haId)
        const target =
          program ??
          this.runtimeState.getCapState<DishwasherStatus>(DISH_CAP)?.selectedProgram ??
          null
        if (target === null) throw new Error('No program is selected — pick one to start')
        assertProgramAvailable(description, target)
        assertProgramOptions(description, target, options ?? {})
        await this.logged(`start ${target}`, client.startProgram(this.#haId, target, options))
      },
      pause: async () => this.command(HC_COMMAND_PAUSE),
      resume: async () => this.command(HC_COMMAND_RESUME),
      stop: async () => this.command(HC_COMMAND_STOP),
      setProgram: async ({ program }) => {
        const client = this.requireClient()
        assertProgramAvailable(client.getDescription(this.#haId), program)
        await this.logged(`select ${program}`, client.selectProgram(this.#haId, program))
      },
      setPower: async ({ on }) => {
        const client = this.requireClient()
        const entity = findEntity(client.getDescription(this.#haId), ['setting'], ['PowerState'])
        if (entity === undefined) throw new Error('This appliance has no power state setting')
        const members = Object.values(entity.enumeration ?? {})
        const target = on ? 'On' : members.includes('Off') ? 'Off' : 'Standby'
        await this.writeKey(client, entity.name, target)
      },
      setHalfLoad: async ({ on }) => this.setOptionByShortName(OPTION_NAMES.halfLoad, on),
      setHygienePlus: async ({ on }) => this.setOptionByShortName(OPTION_NAMES.hygienePlus, on),
      setExtraDry: async ({ on }) => this.setOptionByShortName(OPTION_NAMES.extraDry, on),
      setIntensiveZone: async ({ on }) => this.setOptionByShortName(OPTION_NAMES.intensiveZone, on),
      setVarioSpeedPlus: async ({ on }) =>
        this.setOptionByShortName(OPTION_NAMES.varioSpeedPlus, on),
      setChildLock: async ({ on }) => this.setOptionByShortName(['ChildLock'], on),
      setOption: async ({ key, value }) => this.writeKey(this.requireClient(), key, value),
    }
    this.ctx.registerNativeCap(dishwasherCapability, provider)
  }

  private registerRunningCap(): void {
    const provider: InferNativeProvider<typeof runningStateCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<RunningStateStatus>(RUNNING_CAP) ?? RUNNING_STATE_COLD,
    }
    this.ctx.registerNativeCap(runningStateCapability, provider)
  }

  private publishRunningSlice(slice: DishwasherStatus): void {
    const fetchedAt = Date.now()
    const previous = this.runtimeState.getCapState<RunningStateStatus>(RUNNING_CAP)
    const next = runningFromDishwasherOperation(
      slice.operationState,
      slice.program,
      previous,
      fetchedAt,
      slice.remainingSeconds,
    )
    this.runtimeState.setCapState(RUNNING_CAP, next)
  }
}
