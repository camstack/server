import { z } from 'zod'
import {
  BaseDevice,
  heatPumpControlCapability,
  heatPumpHourAverages,
  heatPumpStatusCapability,
  type DeviceContext,
  type HeatPumpCounterSample,
  type HeatPumpStatus,
  type InferNativeProvider,
} from '@dominevo/types'
import { homeComFaultReading } from '../homecom-faults.js'
import { homeComConnections } from '../homecom-gateway.js'
import { registerHomeComStateRefresh } from './homecom-state-refresh.js'
import { bridgeSetpointWrite } from '../homecom-bridge-snapshot.js'
import {
  circuitControlTypeWrite,
  circuitIdentitiesFrom,
  circuitOptionWrite,
  circuitRangeWrite,
  dhwChargeDurationWrite,
  dhwLevelTempWrite,
  type HeatPumpChildInfo,
  type HeatPumpCircuitIdentity,
  dhwOptionWrite,
  extraHotWaterWrite,
  heatPumpStatusFrom,
  systemModeWrite,
  type HomeComHeatPumpReading,
} from '../homecom-heat-pump.js'
import type { HomeComBridgeReading, HomeComBridgeWrite } from '../homecom-bridge.js'

export const homeComHeatPumpSchema = z.object({
  nativeId: z.string().min(1),
  brokerId: z.string().min(1),
  system: z.literal('homecom').optional(),
  integrationId: z.string().optional(),
})

const STATUS_CAP = 'heat-pump-status'

/** The children are looked up beside the poll, at most this often. */
const IDENTITY_MIN_INTERVAL_MS = 15_000

/** Counter steps kept per device: enough for the last windows, bounded in memory. */
const COUNTER_SAMPLES_KEPT = 24

/**
 * The samples with `value` appended when it is a new step of the counter (a repeat adds none).
 * The first value seen after a start was not observed to CHANGE, so its poll time says nothing
 * about when the counter stepped: for the counter that anchors a window (`anchors`) it is held
 * back in `first` and never becomes a sample, and the window starts at the first real step.
 */
interface CounterTrack {
  readonly first: number | null
  readonly samples: readonly HeatPumpCounterSample[]
}

const NO_COUNTER: CounterTrack = { first: null, samples: [] }

function withCounterStep(
  track: CounterTrack,
  at: number,
  value: number | null,
  anchors: boolean,
): CounterTrack {
  if (value === null) return track
  if (track.first === null) {
    return anchors ? { first: value, samples: [] } : { first: value, samples: [{ at, value }] }
  }
  const last = track.samples[track.samples.length - 1]?.value ?? track.first
  if (last === value) return track
  return {
    first: track.first,
    samples: [...track.samples, { at, value }].slice(-COUNTER_SAMPLES_KEPT),
  }
}

function sameIdentities(
  a: ReadonlyMap<string, HeatPumpCircuitIdentity>,
  b: ReadonlyMap<string, HeatPumpCircuitIdentity>,
): boolean {
  if (a.size !== b.size) return false
  for (const [id, identity] of a) {
    const other = b.get(id)
    if (other?.deviceId !== identity.deviceId || other.label !== identity.label) return false
  }
  return true
}

const COLD_START: HeatPumpStatus = {
  circuits: [],
  system: { silent: null, away: null, additionalHeater: null, holiday: null },
  power: { thermalW: null, electricalW: null, compressorPct: null },
  temperatures: { supply: null, return: null, outdoor: null },
  energy: { thermalKwh: null, electricalKwh: null },
  waterPressureBar: null,
  starts: null,
  workingTime: null,
  heatDemand: null,
  heatSourceType: null,
  compressorRunning: null,
  hourAverage: null,
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
  /** The registry child of each circuit, looked up beside the poll (never copied values). */
  #identities: ReadonlyMap<string, HeatPumpCircuitIdentity> = new Map()
  #identitiesAt = 0
  #identitiesInFlight = false
  #identitiesFailed = false
  /** The lifetime kWh counters, one sample per new value, from which the hour average comes. */
  #thermal: CounterTrack = NO_COUNTER
  #electrical: CounterTrack = NO_COUNTER

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
    const now = Date.now()
    // The thermal counter only fills the window the electrical one anchors, so its first value
    // (held since the start) is a valid reading; the electrical one needs two observed steps.
    this.#thermal = withCounterStep(this.#thermal, now, reading.thermalKwh, false)
    this.#electrical = withCounterStep(this.#electrical, now, reading.electricalKwh, true)
    this.runtimeState.setCapState(
      STATUS_CAP,
      heatPumpStatusFrom(
        reading,
        now,
        this.#identities,
        heatPumpHourAverages(this.#thermal.samples, this.#electrical.samples),
      ),
    )
    this.publishFaults(reading.faults)
    this.refreshIdentities(reading)
  }

  /**
   * Looks up the children of this device and, when the answer moves a circuit's id or name,
   * publishes the slice again. A failed lookup leaves the ids as they were, said once.
   */
  private refreshIdentities(reading: HomeComHeatPumpReading): void {
    const now = Date.now()
    if (this.#identitiesInFlight || now - this.#identitiesAt < IDENTITY_MIN_INTERVAL_MS) return
    this.#identitiesInFlight = true
    this.#identitiesAt = now
    this.loadChildren()
      .then((children) => {
        this.#identitiesFailed = false
        const next = circuitIdentitiesFrom(children, reading.circuits)
        if (!sameIdentities(this.#identities, next)) {
          this.#identities = next
          this.refreshFromSnapshot()
        }
      })
      .catch((error: unknown) => {
        if (this.#identitiesFailed) return
        this.#identitiesFailed = true
        this.ctx.logger.warn('HomeCom heat pump: the children could not be listed', {
          tags: { deviceId: this.ctx.id },
          meta: { error: error instanceof Error ? error.message : String(error) },
        })
      })
      .finally(() => {
        this.#identitiesInFlight = false
      })
  }

  private async loadChildren(): Promise<readonly HeatPumpChildInfo[]> {
    return this.ctx.api.deviceManager.getChildren.query({ parentDeviceId: this.ctx.id })
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

  private requireBridge(): HomeComBridgeReading {
    const bridge = homeComConnections.getSnapshot(this.#brokerId)?.bridge
    if (bridge === undefined) throw new Error('HomeCom heat pump: no bridge reading yet')
    return bridge
  }

  /** Validate against the reading, send, then re-read so the slice shows what the gateway holds. */
  private apply(build: (reading: HomeComHeatPumpReading) => HomeComBridgeWrite): Promise<void> {
    return this.send(() => build(this.requireReading()))
  }

  /** The same, for a write the climate child shares and builds from the bridge reading. */
  private applyBridge(build: (bridge: HomeComBridgeReading) => HomeComBridgeWrite): Promise<void> {
    return this.send(() => build(this.requireBridge()))
  }

  private async send(buildWrite: () => HomeComBridgeWrite): Promise<void> {
    const write = buildWrite()
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
      setCircuitControlType: ({ circuitId, controlType }) =>
        this.apply((r) => circuitControlTypeWrite(r, circuitId, controlType)),
      setCircuitTargetTemp: ({ circuitId, temp }) =>
        this.applyBridge((b) => bridgeSetpointWrite(b, circuitId, temp)),
      setDhwLevelTemp: ({ circuitId, level, temp }) =>
        this.apply((r) => dhwLevelTempWrite(r, circuitId, level, temp)),
      startExtraHotWater: ({ circuitId }) =>
        this.apply((r) => {
          const write = extraHotWaterWrite(r, circuitId)
          if (r.circuits.some((c) => c.id === circuitId && c.kind === 'dhw' && c.charge === null)) {
            this.ctx.logger.info(
              'HomeCom heat pump: extra hot water sent blind, the gateway charge state was not read',
              { tags: { deviceId: this.ctx.id }, meta: { circuitId } },
            )
          }
          return write
        }),
    }
    this.ctx.registerNativeCap(heatPumpControlCapability, provider)
  }
}
