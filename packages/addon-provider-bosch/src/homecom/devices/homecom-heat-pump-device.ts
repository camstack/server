import { z } from 'zod'
import {
  BaseDevice,
  heatPumpControlCapability,
  heatPumpStatusCapability,
  type DeviceContext,
  type HeatPumpStatus,
  type InferNativeProvider,
} from '@camstack/types'
import { homeComConnections } from '../homecom-gateway.js'
import {
  circuitOptionWrite,
  circuitRangeWrite,
  dhwChargeDurationWrite,
  dhwOptionWrite,
  extraHotWaterWrite,
  heatPumpStatusFrom,
  systemModeWrite,
  type HomeComHeatPumpReading,
} from '../homecom-heat-pump.js'
import type { PointtWrite } from '../homecom-pointt.js'

export const homeComHeatPumpSchema = z.object({
  nativeId: z.string().min(1),
  brokerId: z.string().min(1),
  system: z.literal('homecom').optional(),
  integrationId: z.string().optional(),
})

const STATUS_CAP = 'heat-pump-status'

const COLD_START: HeatPumpStatus = {
  circuits: [],
  system: { silent: null, away: null, additionalHeater: null, holiday: null },
  power: { thermalW: null, electricalW: null, compressorPct: null },
  temperatures: { supply: null, return: null, outdoor: null },
  energy: { thermalKwh: null, electricalKwh: null },
  waterPressureBar: null,
  starts: null,
  lastFetchedAt: 0,
}

/**
 * A heat pump on a hydronic HomeCom gateway (D1026). The slice and every limit
 * come from the gateway reading the integration poll already holds; a write is
 * checked against those limits first and the reading is refreshed after it.
 */
export class HomeComHeatPumpDevice extends BaseDevice<typeof homeComHeatPumpSchema> {
  readonly features: readonly never[] = []

  readonly #brokerId: string

  constructor(ctx: DeviceContext) {
    const persisted = homeComHeatPumpSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, homeComHeatPumpSchema, { type: ctx.deviceMeta.type })
    this.#brokerId = persisted.brokerId
    this.online = true
    void this.updateSourceInfo({ id: persisted.nativeId, system: 'homecom' })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.registerStatusCap()
    this.registerControlCap()
    this.runtimeState.setCapState(STATUS_CAP, COLD_START)
    this.refreshFromSnapshot()
  }

  private reading(): HomeComHeatPumpReading | null {
    return homeComConnections.getSnapshot(this.#brokerId)?.heatPump ?? null
  }

  private refreshFromSnapshot(): void {
    const reading = this.reading()
    if (reading === null) {
      this.ctx.logger.warn('HomeCom heat pump: the gateway returned no heat-pump reading', {
        tags: { deviceId: this.ctx.id },
      })
      this.runtimeState.setCapState(STATUS_CAP, { ...COLD_START, lastFetchedAt: Date.now() })
      return
    }
    this.runtimeState.setCapState(STATUS_CAP, heatPumpStatusFrom(reading, Date.now()))
  }

  private requireClient() {
    const client = homeComConnections.getClient(this.#brokerId)
    if (!client) throw new Error('HomeCom client unavailable (heat pump)')
    return client
  }

  private requireReading(): HomeComHeatPumpReading {
    const reading = this.reading()
    if (reading === null) throw new Error('HomeCom heat pump: no reading from the gateway yet')
    return reading
  }

  /** Validate against the reading, send, then re-read so the slice shows what the gateway holds. */
  private async apply(build: (reading: HomeComHeatPumpReading) => PointtWrite): Promise<void> {
    const write = build(this.requireReading())
    const client = this.requireClient()
    await client.writeHeatPump([write])
    this.ctx.logger.info('HomeCom heat pump: value written', {
      tags: { deviceId: this.ctx.id },
      meta: { path: write.path },
    })
    const snapshot = await client.fetchSystem()
    homeComConnections.updateSnapshot(this.#brokerId, snapshot)
    this.refreshFromSnapshot()
  }

  private registerStatusCap(): void {
    const provider: InferNativeProvider<typeof heatPumpStatusCapability> = {
      getStatus: async () => {
        this.refreshFromSnapshot()
        return this.runtimeState.getCapState<HeatPumpStatus>(STATUS_CAP) ?? COLD_START
      },
    }
    this.ctx.registerNativeCap(heatPumpStatusCapability, provider)
  }

  private registerControlCap(): void {
    const provider: InferNativeProvider<typeof heatPumpControlCapability> = {
      setSilentMode: ({ mode }) => this.apply((r) => systemModeWrite(r, 'silent', mode)),
      setAwayMode: ({ mode }) => this.apply((r) => systemModeWrite(r, 'away', mode)),
      setAdditionalHeaterMode: ({ mode }) =>
        this.apply((r) => systemModeWrite(r, 'additionalHeater', mode)),
      setHolidayMode: ({ mode }) => this.apply((r) => systemModeWrite(r, 'holiday', mode)),
      setCircuitOperationMode: ({ circuitId, mode }) =>
        this.apply((r) => circuitOptionWrite(r, circuitId, 'operationMode', mode)),
      setCircuitHeatCoolMode: ({ circuitId, mode }) =>
        this.apply((r) => circuitOptionWrite(r, circuitId, 'heatCoolMode', mode)),
      setCircuitSummerWinter: ({ circuitId, mode }) =>
        this.apply((r) => circuitOptionWrite(r, circuitId, 'summerWinter', mode)),
      setCircuitComfortSetpoint: ({ circuitId, temp }) =>
        this.apply((r) => circuitRangeWrite(r, circuitId, 'comfort', temp)),
      setCircuitEcoSetpoint: ({ circuitId, temp }) =>
        this.apply((r) => circuitRangeWrite(r, circuitId, 'eco', temp)),
      setCircuitMaxFlowTemp: ({ circuitId, temp }) =>
        this.apply((r) => circuitRangeWrite(r, circuitId, 'maxFlow', temp)),
      setDhwOperationMode: ({ circuitId, mode }) =>
        this.apply((r) => dhwOptionWrite(r, circuitId, 'operationMode', mode)),
      setDhwTemperatureLevel: ({ circuitId, level }) =>
        this.apply((r) => dhwOptionWrite(r, circuitId, 'level', level)),
      setDhwChargeDuration: ({ circuitId, minutes }) =>
        this.apply((r) => dhwChargeDurationWrite(r, circuitId, minutes)),
      startExtraHotWater: ({ circuitId }) => this.apply((r) => extraHotWaterWrite(r, circuitId)),
    }
    this.ctx.registerNativeCap(heatPumpControlCapability, provider)
  }
}
