import { z } from 'zod'
import {
  BaseDevice,
  climateControlCapability,
  type ClimateControlStatus,
  type DeviceContext,
  type HvacMode,
  type InferNativeProvider,
} from '@camstack/types'
import { homeComConnections } from '../homecom-gateway.js'
import { climateSliceFromCircuit } from '../homecom-domain-mapping.js'

export const homeComClimateSchema = z.object({
  nativeId: z.string().min(1),
  brokerId: z.string().min(1),
  circuitId: z.string().min(1),
  system: z.literal('homecom').optional(),
  integrationId: z.string().optional(),
})

const CLIMATE_CAP = 'climate-control'

const COLD_START: ClimateControlStatus = {
  mode: 'off',
  availableModes: [],
  fanMode: '',
  availableFanModes: [],
  preset: '',
  availablePresets: [],
  target: null,
  targetHigh: null,
  targetLow: null,
  targetHumidity: null,
  currentTemp: null,
  currentHumidity: null,
  swingVertical: null,
  swingHorizontal: null,
  lastFetchedAt: 0,
}

export class HomeComClimateDevice extends BaseDevice<typeof homeComClimateSchema> {
  readonly features: readonly never[] = []

  readonly #brokerId: string
  readonly #circuitId: string

  constructor(ctx: DeviceContext) {
    const persisted = homeComClimateSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, homeComClimateSchema, { type: ctx.deviceMeta.type })
    this.#brokerId = persisted.brokerId
    this.#circuitId = persisted.circuitId
    this.online = true
    void this.updateSourceInfo({ id: persisted.nativeId, system: 'homecom' })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.registerClimateCap()
    this.runtimeState.setCapState(CLIMATE_CAP, COLD_START)
    this.refreshFromSnapshot()
  }

  private refreshFromSnapshot(): void {
    const snapshot = homeComConnections.getSnapshot(this.#brokerId)
    const circuit = snapshot?.circuits.find((c) => c.id === this.#circuitId)
    if (!circuit) {
      this.runtimeState.setCapState(CLIMATE_CAP, { ...COLD_START, lastFetchedAt: Date.now() })
      return
    }
    this.runtimeState.setCapState(CLIMATE_CAP, climateSliceFromCircuit(circuit, Date.now()))
  }

  private requireClient() {
    const client = homeComConnections.getClient(this.#brokerId)
    if (!client) throw new Error(`HomeCom client unavailable (circuit=${this.#circuitId})`)
    return client
  }

  private registerClimateCap(): void {
    const provider: InferNativeProvider<typeof climateControlCapability> = {
      getStatus: async () => {
        this.refreshFromSnapshot()
        return this.runtimeState.getCapState<ClimateControlStatus>(CLIMATE_CAP) ?? COLD_START
      },
      setMode: async ({ mode }) => {
        const apiMode = hvacModeToHomeCom(mode)
        await this.requireClient().setCircuitMode(this.#circuitId, apiMode)
        this.refreshFromSnapshot()
      },
      setFanMode: async ({ fanMode }) => {
        await this.requireClient().setFanMode(this.#circuitId, fanMode)
        this.refreshFromSnapshot()
      },
      setPreset: async () => {
        throw new Error('HomeCom climate: presets not supported')
      },
      setTarget: async ({ target }) => {
        await this.requireClient().setCircuitSetpoint(this.#circuitId, target)
        this.refreshFromSnapshot()
      },
      setTargetRange: async () => {
        throw new Error('HomeCom climate: dual setpoint not supported')
      },
      setTargetHumidity: async () => {
        throw new Error('HomeCom climate: humidity not supported')
      },
      setSwingVertical: async ({ on }) => {
        await this.requireClient().setSwingVertical(this.#circuitId, on)
        this.refreshFromSnapshot()
      },
      setSwingHorizontal: async ({ on }) => {
        await this.requireClient().setSwingHorizontal(this.#circuitId, on)
        this.refreshFromSnapshot()
      },
    }
    this.ctx.registerNativeCap(climateControlCapability, provider)
  }
}

function hvacModeToHomeCom(mode: HvacMode): string {
  switch (mode) {
    case 'heat':
      return 'Heat'
    case 'cool':
      return 'Cool'
    case 'auto':
      return 'Auto'
    default:
      return 'Off'
  }
}
