import { z } from 'zod'
import {
  registerPowerSwitch,
  BaseDevice,
  climateControlCapability,
  type ClimateControlStatus,
  type DeviceContext,
  DeviceRole,
  type HvacMode,
  type InferNativeProvider,
} from '@camstack/types'
import { homeComConnections } from '../homecom-gateway.js'
import { registerHomeComStateRefresh } from './homecom-state-refresh.js'
import { climateSliceFromCircuit } from '../homecom-domain-mapping.js'
import { awayPresetWrite, climatePresetsFrom } from '../homecom-heat-pump.js'

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
  private stopStateRefresh: (() => void) | null = null
  readonly #circuitId: string

  constructor(ctx: DeviceContext) {
    const persisted = homeComClimateSchema.parse(ctx.persistedConfig ?? {})
    // D1033 — a HomeCom circuit is a heat-pump circuit; the role fills a row that has none.
    super(ctx, homeComClimateSchema, {
      type: ctx.deviceMeta.type,
      role: DeviceRole.ClimateHeatPumpCircuit,
    })
    this.#brokerId = persisted.brokerId
    this.#circuitId = persisted.circuitId
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
    this.registerClimateCap()
    this.runtimeState.setCapState(CLIMATE_CAP, COLD_START)
    this.refreshFromSnapshot()
  }

  override async removeDevice(): Promise<void> {
    this.stopStateRefresh?.()
    this.stopStateRefresh = null
    await super.removeDevice()
  }

  private refreshFromSnapshot(): void {
    const snapshot = homeComConnections.getSnapshot(this.#brokerId)
    const circuit = snapshot?.circuits.find((c) => c.id === this.#circuitId)
    if (!circuit) {
      this.runtimeState.setCapState(CLIMATE_CAP, { ...COLD_START, lastFetchedAt: Date.now() })
      return
    }
    const presets = climatePresetsFrom(snapshot?.bridge?.system.away ?? null)
    this.runtimeState.setCapState(CLIMATE_CAP, {
      ...climateSliceFromCircuit(circuit, Date.now()),
      preset: presets.preset,
      availablePresets: [...presets.availablePresets],
    })
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
      setPreset: async ({ preset }) => {
        const away = homeComConnections.getSnapshot(this.#brokerId)?.bridge?.system.away ?? null
        const client = this.requireClient()
        await client.writeHeatPump([awayPresetWrite(away, preset)])
        this.ctx.logger.info('HomeCom climate: preset written', {
          tags: { deviceId: this.ctx.id },
          meta: { preset },
        })
        try {
          homeComConnections.updateSnapshot(this.#brokerId, await client.fetchSystem())
        } catch (error) {
          // The write went out: say the refresh failed, never that the write did.
          this.ctx.logger.warn('HomeCom climate: preset written, the refresh failed', {
            tags: { deviceId: this.ctx.id },
            meta: { error: error instanceof Error ? error.message : String(error) },
          })
        }
        this.refreshFromSnapshot()
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
    registerPowerSwitch(this, climateControlCapability, provider)
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
