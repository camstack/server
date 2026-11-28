import { z } from 'zod'
import {
  registerPowerSwitch,
  BaseDevice,
  waterHeaterCapability,
  type DeviceContext,
  type InferNativeProvider,
  type WaterHeaterStatus,
} from '@dominevo/types'
import { homeComConnections } from '../homecom-gateway.js'
import { registerHomeComStateRefresh } from './homecom-state-refresh.js'
import { waterHeaterSliceFromDhw } from '../homecom-domain-mapping.js'

export const homeComWaterHeaterSchema = z.object({
  nativeId: z.string().min(1),
  brokerId: z.string().min(1),
  system: z.literal('homecom').optional(),
  integrationId: z.string().optional(),
})

const WH_CAP = 'water-heater'

const COLD_START: WaterHeaterStatus = {
  currentTemp: null,
  targetTemp: null,
  operationMode: null,
  availableModes: [],
  away: null,
  minTemp: null,
  maxTemp: null,
  lastChangedAt: 0,
}

export class HomeComWaterHeaterDevice extends BaseDevice<typeof homeComWaterHeaterSchema> {
  readonly features: readonly never[] = []

  readonly #brokerId: string
  private stopStateRefresh: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const persisted = homeComWaterHeaterSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, homeComWaterHeaterSchema, { type: ctx.deviceMeta.type })
    this.#brokerId = persisted.brokerId
    this.online = true
    void this.updateSourceInfo({ id: persisted.nativeId, system: 'homecom' })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    // The core decides when the gateway is re-read (D1062); this device follows the snapshot.
    this.stopStateRefresh ??= registerHomeComStateRefresh({
      ctx: this.ctx,
      integrationId: this.#brokerId,
      onSnapshot: () => this.refreshFromSnapshot(),
    })
    this.registerWaterHeaterCap()
    this.runtimeState.setCapState(WH_CAP, COLD_START)
    this.refreshFromSnapshot()
  }

  override async removeDevice(): Promise<void> {
    this.stopStateRefresh?.()
    this.stopStateRefresh = null
    await super.removeDevice()
  }

  private refreshFromSnapshot(): void {
    const dhw = homeComConnections.getSnapshot(this.#brokerId)?.dhw
    if (!dhw) {
      this.runtimeState.setCapState(WH_CAP, { ...COLD_START, lastChangedAt: Date.now() })
      return
    }
    this.runtimeState.setCapState(WH_CAP, waterHeaterSliceFromDhw(dhw, Date.now()))
  }

  private requireClient() {
    const client = homeComConnections.getClient(this.#brokerId)
    if (!client) throw new Error('HomeCom client unavailable (DHW)')
    return client
  }

  private registerWaterHeaterCap(): void {
    const provider: InferNativeProvider<typeof waterHeaterCapability> = {
      getStatus: async () => {
        this.refreshFromSnapshot()
        return this.runtimeState.getCapState<WaterHeaterStatus>(WH_CAP) ?? COLD_START
      },
      setTargetTemp: async ({ temp }) => {
        await this.requireClient().setDhwTarget(temp)
        this.refreshFromSnapshot()
      },
      setOperationMode: async ({ mode }) => {
        await this.requireClient().setDhwMode(mode)
        this.refreshFromSnapshot()
      },
      setAway: async () => {
        throw new Error('HomeCom DHW: away mode not supported')
      },
    }
    this.ctx.registerNativeCap(waterHeaterCapability, provider)
    registerPowerSwitch(this, waterHeaterCapability, provider)
  }
}
