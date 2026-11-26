import { z } from 'zod'
import {
  BaseDevice,
  heatPumpControlCapability,
  heatPumpStatusCapability,
  type DeviceContext,
  type HeatPumpStatus,
  type InferNativeProvider,
} from '@camstack/types'
import { homeComFaultReading } from '../homecom-faults.js'
import { homeComConnections } from '../homecom-gateway.js'
import { registerHomeComStateRefresh } from './homecom-state-refresh.js'
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
import type { HomeComBridgeWrite } from '../homecom-bridge.js'

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
  private stopStateRefresh: (() => void) | null = null
  /** True while the gateway has no heat-pump reading, so the log marks the transitions only. */
  #noReading = false

  constructor(ctx: DeviceContext) {
    const persisted = homeComHeatPumpSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, homeComHeatPumpSchema, { type: ctx.deviceMeta.type })
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
    this.registerErrorCap()
    this.registerStatusCap()
    this.registerControlCap()
    this.runtimeState.setCapState(STATUS_CAP, COLD_START)
    this.refreshFromSnapshot()
  }

  override async removeDevice(): Promise<void> {
    this.stopStateRefresh?.()
    this.stopStateRefresh = null
    await super.removeDevice()
  }

  private reading(): HomeComHeatPumpReading | null {
    return homeComConnections.getSnapshot(this.#brokerId)?.heatPump ?? null
  }

  private refreshFromSnapshot(): void {
    const reading = this.reading()
    if (reading === null) {
      if (!this.#noReading) {
        this.#noReading = true
        this.ctx.logger.warn('HomeCom heat pump: the gateway returned no heat-pump reading', {
          tags: { deviceId: this.ctx.id },
        })
      }
      this.runtimeState.setCapState(STATUS_CAP, {
        ...COLD_START,
        lastFetchedAt: Date.now(),
      })
      this.publishFaults(null)
      return
    }
    if (this.#noReading) {
      this.#noReading = false
      this.ctx.logger.info(
        'HomeCom heat pump: the gateway answers with a heat-pump reading again',
        {
          tags: { deviceId: this.ctx.id },
        },
      )
    }
    this.runtimeState.setCapState(STATUS_CAP, heatPumpStatusFrom(reading, Date.now()))
    this.publishFaults(reading.faults)
  }

  /** A refused or failed notifications read is unknown, never "no fault" (D393). */
  private publishFaults(faults: HomeComHeatPumpReading['faults']): void {
    this.publishError(homeComFaultReading(faults, Date.now())).catch((error: unknown) => {
      this.ctx.logger.warn('HomeCom heat pump: the fault could not be published', {
        tags: { deviceId: this.ctx.id },
        meta: { error: error instanceof Error ? error.message : String(error) },
      })
    })
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
  private async apply(
    build: (reading: HomeComHeatPumpReading) => HomeComBridgeWrite,
  ): Promise<void> {
    const write = build(this.requireReading())
    const client = this.requireClient()
    await client.writeHeatPump([write])
    this.ctx.logger.info('HomeCom heat pump: value written', {
      tags: { deviceId: this.ctx.id },
      meta: { op: write.op },
    })
    try {
      const snapshot = await client.fetchSystem()
      homeComConnections.updateSnapshot(this.#brokerId, snapshot)
    } catch (error) {
      // The write went out: say the refresh failed, never that the write did.
      this.ctx.logger.warn('HomeCom heat pump: value written, the refresh failed', {
        tags: { deviceId: this.ctx.id },
        meta: {
          op: write.op,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      return
    }
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
