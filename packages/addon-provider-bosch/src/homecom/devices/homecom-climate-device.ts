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
import type { HomeComBridgeWrite, HomeComBridgeZone } from '../homecom-bridge.js'
import { zoneClimateSlice, zoneModeWrite, zoneTargetWrite } from '../homecom-zone.js'

export const homeComClimateSchema = z.object({
  nativeId: z.string().min(1),
  brokerId: z.string().min(1),
  /** A heating circuit (`hc1`) or, for the zone child, `zoneId`: exactly one of the two. */
  circuitId: z.string().min(1).optional(),
  zoneId: z.string().min(1).optional(),
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
  readonly #circuitId: string | null
  readonly #zoneId: string | null

  constructor(ctx: DeviceContext) {
    const persisted = homeComClimateSchema.parse(ctx.persistedConfig ?? {})
    // D1033 — a HomeCom circuit is a heat-pump circuit; the role fills a row that has none.
    super(ctx, homeComClimateSchema, {
      type: ctx.deviceMeta.type,
      role: DeviceRole.ClimateHeatPumpCircuit,
    })
    this.#brokerId = persisted.brokerId
    if (persisted.circuitId === undefined && persisted.zoneId === undefined) {
      throw new Error('HomeCom climate: a circuitId or a zoneId is required')
    }
    this.#circuitId = persisted.circuitId ?? null
    this.#zoneId = persisted.zoneId ?? null
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

  private zone(): HomeComBridgeZone | null {
    if (this.#zoneId === null) return null
    const bridge = homeComConnections.getSnapshot(this.#brokerId)?.bridge
    return bridge?.zones.find((candidate) => candidate.id === this.#zoneId) ?? null
  }

  private refreshFromSnapshot(): void {
    if (this.#zoneId !== null) {
      const zone = this.zone()
      this.runtimeState.setCapState(
        CLIMATE_CAP,
        zone === null
          ? { ...COLD_START, lastFetchedAt: Date.now() }
          : zoneClimateSlice(zone, Date.now()),
      )
      return
    }
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
    if (!client) throw new Error(`HomeCom client unavailable (${this.#target()})`)
    return client
  }

  #target(): string {
    return this.#zoneId === null ? `circuit=${this.#circuitId}` : `zone=${this.#zoneId}`
  }

  /** The heating circuit this device is; a zone child has none, so a circuit-only call refuses. */
  private requireCircuitId(what: string): string {
    if (this.#circuitId === null) throw new Error(`HomeCom zone: ${what} is not supported`)
    return this.#circuitId
  }

  /** A zone write: checked against the zone the snapshot holds, sent, then re-read. */
  private async writeZone(build: (zone: HomeComBridgeZone) => HomeComBridgeWrite): Promise<void> {
    const zone = this.zone()
    if (zone === null) throw new Error(`HomeCom zone ${this.#zoneId}: no reading from the gateway`)
    const client = this.requireClient()
    await client.writeHeatPump([build(zone)])
    try {
      homeComConnections.updateSnapshot(this.#brokerId, await client.fetchSystem())
    } catch (error) {
      // The write went out: say the refresh failed, never that the write did.
      this.ctx.logger.warn('HomeCom zone: value written, the refresh failed', {
        tags: { deviceId: this.ctx.id },
        meta: { error: error instanceof Error ? error.message : String(error) },
      })
    }
    this.refreshFromSnapshot()
  }

  private registerClimateCap(): void {
    const provider: InferNativeProvider<typeof climateControlCapability> = {
      getStatus: async () => {
        this.refreshFromSnapshot()
        return this.runtimeState.getCapState<ClimateControlStatus>(CLIMATE_CAP) ?? COLD_START
      },
      setMode: async ({ mode }) => {
        if (this.#zoneId !== null) return this.writeZone((zone) => zoneModeWrite(zone, mode))
        const apiMode = hvacModeToHomeCom(mode)
        await this.requireClient().setCircuitMode(this.requireCircuitId('mode'), apiMode)
        this.refreshFromSnapshot()
      },
      setFanMode: async ({ fanMode }) => {
        await this.requireClient().setFanMode(this.requireCircuitId('fan mode'), fanMode)
        this.refreshFromSnapshot()
      },
      // Away is ONE gateway-wide switch (`/system/awayMode/enabled`): every heating circuit
      // of the gateway shows and sets the same preset.
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
        if (this.#zoneId !== null) return this.writeZone((zone) => zoneTargetWrite(zone, target))
        await this.requireClient().setCircuitSetpoint(this.requireCircuitId('target'), target)
        this.refreshFromSnapshot()
      },
      setTargetRange: async () => {
        throw new Error('HomeCom climate: dual setpoint not supported')
      },
      setTargetHumidity: async () => {
        throw new Error('HomeCom climate: humidity not supported')
      },
      setSwingVertical: async ({ on }) => {
        await this.requireClient().setSwingVertical(this.requireCircuitId('swing'), on)
        this.refreshFromSnapshot()
      },
      setSwingHorizontal: async ({ on }) => {
        await this.requireClient().setSwingHorizontal(this.requireCircuitId('swing'), on)
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
