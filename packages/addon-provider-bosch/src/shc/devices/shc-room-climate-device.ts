import {
  climateControlCapability,
  type ClimateControlStatus,
  type DeviceContext,
  type InferNativeProvider,
} from '@camstack/types'
import { climatePresetSelection, heatingProfilesFromSchedule } from '../shc-climate-schedules.js'
import {
  buildRoomClimateModeBodies,
  buildRoomClimatePutBody,
  mapRoomClimateStateToSlice,
} from '../shc-domain-mapping.js'
import type { ShcRoomClimateState } from '../shc-types.js'
import { applyPersistedClimateTempStep } from '../shc-climate-temp-step.js'
import { ShcBaseDevice, shcDeviceSchema } from './shc-device-base.js'

const CLIMATE_CAP = 'climate-control'
const SERVICE = 'RoomClimateControl'

const COLD_START: ClimateControlStatus = {
  mode: 'off',
  availableModes: ['off', 'heat', 'auto'],
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

export class ShcRoomClimateDevice extends ShcBaseDevice {
  constructor(ctx: DeviceContext) {
    super(ctx)
  }

  protected override registerCaps(): void {
    const provider: InferNativeProvider<typeof climateControlCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<ClimateControlStatus>(CLIMATE_CAP) ?? COLD_START,
      setMode: async ({ mode }) => {
        const client = this.requireClient()
        for (const body of buildRoomClimateModeBodies(mode)) {
          await client.putServiceState(this.shcDeviceId, SERVICE, body)
        }
        this.deviceLog('info', 'SHC climate mode set', { mode })
        const prev = this.runtimeState.getCapState<ClimateControlStatus>(CLIMATE_CAP) ?? COLD_START
        this.runtimeState.setCapState(CLIMATE_CAP, { ...prev, mode, lastFetchedAt: Date.now() })
      },
      setTarget: async ({ target }) => {
        await this.requireClient().putServiceState(
          this.shcDeviceId,
          SERVICE,
          buildRoomClimatePutBody({ target }),
        )
        this.deviceLog('info', 'SHC climate target set', { target })
        const prev = this.runtimeState.getCapState<ClimateControlStatus>(CLIMATE_CAP) ?? COLD_START
        this.runtimeState.setCapState(CLIMATE_CAP, { ...prev, target, lastFetchedAt: Date.now() })
      },
      setPreset: async ({ preset }) => {
        const client = this.requireClient()
        const view = heatingProfilesFromSchedule(await client.getHeatingSchedules(this.shcDeviceId))
        const match = view.profiles.find((profile) => profile.preset === preset)
        if (match === undefined) {
          throw new Error(`SHC heating profile not found: ${preset}`)
        }
        await client.activateHeatingSchedule(this.shcDeviceId, match.id)
        this.deviceLog('info', 'SHC climate profile activated', {
          preset,
          scheduleId: match.id,
        })
        await this.refreshFromController()
      },
      setFanMode: async () => this.unsupported('climate fan mode'),
      setTargetRange: async () => this.unsupported('climate dual setpoint'),
      setTargetHumidity: async () => this.unsupported('climate humidity'),
      setSwingVertical: async () => this.unsupported('climate swing'),
      setSwingHorizontal: async () => this.unsupported('climate swing'),
    }
    this.ctx.registerNativeCap(climateControlCapability, provider)
    this.runtimeState.setCapState(CLIMATE_CAP, COLD_START)
  }

  protected override async refreshFromController(): Promise<void> {
    const client = this.resolveClient()
    if (client === null) return
    const state = await client.getServiceState<ShcRoomClimateState>(this.shcDeviceId, SERVICE)
    const level = await client
      .getServiceState<{ temperature?: number }>(this.shcDeviceId, 'TemperatureLevel')
      .catch((): { temperature?: number } => ({}))
    const persisted = shcDeviceSchema.parse(this.config.values)
    const schedules = await client.getHeatingSchedules(this.shcDeviceId).catch(() => null)
    const selection =
      schedules === null
        ? { preset: '', availablePresets: [] as readonly string[] }
        : climatePresetSelection(heatingProfilesFromSchedule(schedules))
    const slice = applyPersistedClimateTempStep(
      {
        ...mapRoomClimateStateToSlice({
          ...state,
          temperature: level.temperature ?? state.temperature,
        }),
        preset: selection.preset,
        availablePresets: [...selection.availablePresets],
      },
      persisted.tempStep,
    )
    const prev = this.runtimeState.getCapState<ClimateControlStatus>(CLIMATE_CAP)
    this.runtimeState.setCapState(CLIMATE_CAP, slice)
    if (
      prev !== undefined &&
      (prev.mode !== slice.mode ||
        prev.target !== slice.target ||
        prev.currentTemp !== slice.currentTemp ||
        prev.preset !== slice.preset)
    ) {
      this.deviceLog('info', 'SHC climate state updated from controller', {
        mode: slice.mode,
        target: slice.target,
        currentTemp: slice.currentTemp,
        preset: slice.preset,
        previousMode: prev.mode,
        previousTarget: prev.target,
        previousTemp: prev.currentTemp,
        previousPreset: prev.preset,
      })
    }
  }
}
