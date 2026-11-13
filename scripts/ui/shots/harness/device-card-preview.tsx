/**
 * Fixture page for the device card. Not an admin route: `ui:shots` mounts it for
 * the path `/device-card-preview`; `?type=plug|climate|climate-extra|cover|light|fan|heater|washer|dryer|dish|media|vacuum|heatpump|water|energy|ir|lock|alarm|humid|valve|siren|pet|weather|button|update|script|automation|control|event|image|notifier|gateway|misc|camera|sensor` picks the scene (`climate-extra`: the
 * variants real devices have and the mockup does not draw). Every
 * fixture carries the data of one variant of the approved mockup, so
 * `scripts/ui/card-parity.mjs` can shoot the two side by side. Strings are the
 * Italian catalogue, the mockup's language.
 */
import i18n from '@admin/i18n'
import { bridgeUiText } from '@admin/i18n/ui-text-bridge'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactElement, type ReactNode, useMemo, useState } from 'react'
import { fakeClient } from './stubs/transport'
import { ACTUATION_FIXTURE_DEVICE_ID } from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/actuations'
import {
  ApplianceCard,
  type ApplianceCardActions,
  ClimateCard,
  type ClimateCardActions,
  CoverCard,
  type CoverCardActions,
  FanCard,
  type FanCardActions,
  HeaterCard,
  type HeaterCardActions,
  HeatPumpCard,
  type HeatPumpCardActions,
  LightCard,
  type LightCardActions,
  type MediaCardActions,
  MediaPlayerCard,
  PlugCard,
  type PlugCardActions,
  RobotCard,
  type RobotCardActions,
  trpc,
  UiTextProvider,
  WaterHeaterCard,
  type WaterHeaterCardActions,
  EnergyCard,
  type EnergyCardActions,
  IrTransmitterCard,
  SensorCard,
  type IrTransmitterCardActions,
} from '@camstack/ui-library'
import { applianceFixtures } from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/appliance'
import {
  CLIMATE_EXTRA_FIXTURES,
  CLIMATE_FIXTURES,
} from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/climate'
import { coverFixtures } from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/cover'
import { energyFixtures } from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/energy'
import { fanFixtures } from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/fan'
import { heaterFixtures } from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/heater'
import { heatPumpFixtures } from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/heat-pump'
import { lightFixtures } from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/light'
import { mediaFixtures } from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/media'
import { plugFixtures } from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/plug'
import { robotFixtures } from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/robot'
import { waterHeaterFixtures } from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/water-heater'
import { irFixtures } from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/ir'
import { sensorFixtures } from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/sensor'
import { WAVE_D_TYPES, WaveDScene } from './device-card-preview-wave-d'
import { WAVE_E_TYPES, WaveEScene } from './device-card-preview-wave-e'

function ValueHistoryMark(): ReactElement {
  return (
    <p data-testid="dc-value-history" className="text-xs text-foreground-muted">
      24 °C · 22 °C
    </p>
  )
}

/** One climate card opened on History, with invented actuations from the fixture transport. */
function HistoryActuations(): ReactElement {
  const fixture = CLIMATE_FIXTURES[0]
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  )
  if (fixture === undefined) return <p>No climate fixture</p>
  const common = {
    ...fixture.model.common,
    deviceId: ACTUATION_FIXTURE_DEVICE_ID,
    history: { charts: <ValueHistoryMark />, events: null },
  }
  return (
    <trpc.Provider client={fakeClient()} queryClient={client}>
      <QueryClientProvider client={client}>
        <ClimateCard
          model={{ ...fixture.model, common }}
          actions={CLIMATE_ACTIONS}
          initialView="history"
        />
      </QueryClientProvider>
    </trpc.Provider>
  )
}

const noop = (): void => undefined
const PLUG_ACTIONS: PlugCardActions = { onPower: noop, onTimerStart: noop, onTimerStop: noop }
const CLIMATE_ACTIONS: ClimateCardActions = {
  onPower: noop,
  onTarget: noop,
  onMode: noop,
  onFan: noop,
  onSwing: noop,
  onSwingHorizontal: noop,
  onRange: noop,
  onPreset: noop,
  onHeatCool: noop,
}
const COVER_ACTIONS: CoverCardActions = {
  onOpen: noop,
  onClose: noop,
  onStop: noop,
  onPosition: noop,
  onTilt: noop,
}
const LIGHT_ACTIONS: LightCardActions = {
  onPower: noop,
  onBrightness: noop,
  onColor: noop,
  onWhite: noop,
}
const FAN_ACTIONS: FanCardActions = {
  ...PLUG_ACTIONS,
  onSpeed: noop,
  onPreset: noop,
  onDirection: noop,
  onOscillating: noop,
  onAxis: noop,
}
const HEATER_ACTIONS: HeaterCardActions = PLUG_ACTIONS
const APPLIANCE_ACTIONS: ApplianceCardActions = {
  onPower: noop,
  onProgram: noop,
  onStart: noop,
  onPause: noop,
  onResume: noop,
  onStop: noop,
}
const MEDIA_ACTIONS: MediaCardActions = {
  onPower: noop,
  onVolumeUp: noop,
  onVolumeDown: noop,
  onVolume: noop,
  onMute: noop,
  onSource: noop,
  onSeek: noop,
  onPlay: noop,
  onPause: noop,
  onStop: noop,
  onNext: noop,
  onPrevious: noop,
  onShuffle: noop,
  onRepeat: noop,
}
const ROBOT_ACTIONS: RobotCardActions = {
  onStart: noop,
  onPause: noop,
  onDock: noop,
  onStop: noop,
  onLocate: noop,
  onSuction: noop,
}
const HEAT_PUMP_ACTIONS: HeatPumpCardActions = { onCircuit: noop, onSystemMode: noop }
const WATER_HEATER_ACTIONS: WaterHeaterCardActions = {
  onPower: noop,
  onTarget: noop,
  onMode: noop,
  onAway: noop,
}
const ENERGY_ACTIONS: EnergyCardActions = {}
const IR_ACTIONS: IrTransmitterCardActions = { onLearn: noop }
const APPLIANCE_KIND = { washer: 'washer', dryer: 'dryer', dish: 'dish' } as const

interface WaveBSceneProps {
  readonly type: string
  /** Opens every media card on its remote sheet, with shuffle and repeat declared. */
  readonly remote: boolean
}

/** Wave B: appliances (washer, dryer, dishwasher), media, robots (vacuum + mower). */
function WaveBScene({ type, remote }: WaveBSceneProps): ReactElement | null {
  if (type === 'washer' || type === 'dryer' || type === 'dish') {
    return (
      <>
        {applianceFixtures(APPLIANCE_KIND[type]).map((f) => (
          <Cell key={f.id} id={f.id} caption={f.caption} wide={f.orientation === 'horizontal'}>
            <ApplianceCard
              model={f.model}
              actions={APPLIANCE_ACTIONS}
              orientation={f.orientation}
            />
          </Cell>
        ))}
      </>
    )
  }
  if (type === 'media') {
    return (
      <>
        {mediaFixtures().map((f) => (
          <Cell key={f.id} id={f.id} caption={f.caption} wide={f.orientation === 'horizontal'}>
            <MediaPlayerCard
              model={remote ? { ...f.model, playback: { shuffle: true, repeat: 'all' } } : f.model}
              actions={MEDIA_ACTIONS}
              orientation={f.orientation}
              initialView={remote ? 'remote' : 'scene'}
            />
          </Cell>
        ))}
      </>
    )
  }
  if (type === 'vacuum') {
    return (
      <>
        {robotFixtures().map((f) => (
          <Cell key={f.id} id={f.id} caption={f.caption} wide={f.orientation === 'horizontal'}>
            <RobotCard model={f.model} actions={ROBOT_ACTIONS} orientation={f.orientation} />
          </Cell>
        ))}
      </>
    )
  }
  return null
}

const WAVE_B_TYPES: ReadonlySet<string> = new Set(['washer', 'dryer', 'dish', 'media', 'vacuum'])

/** Wave C: heat pump, water heater, energy system, camera, presence sensor. */
function WaveCScene({ type }: { readonly type: string }): ReactElement | null {
  switch (type) {
    case 'heatpump':
      return (
        <>
          {heatPumpFixtures().map((f) => (
            <Cell key={f.id} id={f.id} caption={f.caption} wide={f.orientation === 'horizontal'}>
              <HeatPumpCard
                model={f.model}
                actions={HEAT_PUMP_ACTIONS}
                orientation={f.orientation}
              />
            </Cell>
          ))}
        </>
      )
    case 'water':
      return (
        <>
          {waterHeaterFixtures().map((f) => (
            <Cell key={f.id} id={f.id} caption={f.caption} wide={f.orientation === 'horizontal'}>
              <WaterHeaterCard
                model={f.model}
                actions={WATER_HEATER_ACTIONS}
                orientation={f.orientation}
              />
            </Cell>
          ))}
        </>
      )
    case 'energy':
      return (
        <>
          {energyFixtures().map((f) => (
            <Cell key={f.id} id={f.id} caption={f.caption} wide={f.orientation === 'horizontal'}>
              <EnergyCard model={f.model} actions={ENERGY_ACTIONS} orientation={f.orientation} />
            </Cell>
          ))}
        </>
      )
    default:
      return null
  }
}

const WAVE_C_TYPES: ReadonlySet<string> = new Set(['heatpump', 'water', 'energy'])

/** One scene per `?type=`: the fixtures of that mockup page, each in its cell. */
function WaveAScene({ type }: { readonly type: string }): ReactElement | null {
  switch (type) {
    case 'cover':
      return (
        <>
          {coverFixtures().map((f) => (
            <Cell key={f.id} id={f.id} caption={f.caption} wide={false}>
              <CoverCard model={f.model} actions={COVER_ACTIONS} orientation={f.orientation} />
            </Cell>
          ))}
        </>
      )
    case 'light':
      return (
        <>
          {lightFixtures().map((f) => (
            <Cell key={f.id} id={f.id} caption={f.caption} wide={false}>
              <LightCard model={f.model} actions={LIGHT_ACTIONS} orientation={f.orientation} />
            </Cell>
          ))}
        </>
      )
    case 'fan':
      return (
        <>
          {fanFixtures().map((f) => (
            <Cell key={f.id} id={f.id} caption={f.caption} wide={false}>
              <FanCard model={f.model} actions={FAN_ACTIONS} orientation={f.orientation} />
            </Cell>
          ))}
        </>
      )
    case 'heater':
      return (
        <>
          {heaterFixtures().map((f) => (
            <Cell key={f.id} id={f.id} caption={f.caption} wide={false}>
              <HeaterCard model={f.model} actions={HEATER_ACTIONS} orientation={f.orientation} />
            </Cell>
          ))}
        </>
      )
    default:
      return null
  }
}

const WAVE_A_TYPES: ReadonlySet<string> = new Set(['cover', 'light', 'fan', 'heater'])

function Cell({
  id,
  caption,
  wide,
  children,
}: {
  readonly id: string
  readonly wide: boolean
  readonly caption: string
  readonly children: ReactNode
}): ReactElement {
  return (
    <figure
      data-fixture={id}
      className={`flex max-w-full flex-col gap-2 ${wide ? 'w-180' : 'w-85'}`}
    >
      <figcaption className="text-xs uppercase tracking-wide text-foreground-muted">
        {caption}
      </figcaption>
      {children}
    </figure>
  )
}

export function DeviceCardPreview(): ReactElement {
  const params = new URLSearchParams(window.location.search)
  const type = params.get('type') ?? 'plug'
  const remote = params.get('view') === 'remote'
  const history = params.get('view') === 'history'
  if (history) document.documentElement.lang = 'it'
  const theme = sessionStorage.getItem('ui-shots:theme') === 'dark' ? 'dark' : 'light'
  const t = useMemo(() => {
    const it = i18n.cloneInstance({ lng: 'it' })
    return bridgeUiText(it.t.bind(it))
  }, [])
  return (
    <UiTextProvider t={t}>
      <main
        data-card-type={type}
        className={`${theme} flex min-h-screen flex-wrap content-start items-start gap-4 bg-background p-4 text-foreground`}
      >
        {history ? (
          <HistoryActuations />
        ) : WAVE_A_TYPES.has(type) ? (
          <WaveAScene type={type} />
        ) : WAVE_B_TYPES.has(type) ? (
          <WaveBScene type={type} remote={remote} />
        ) : WAVE_C_TYPES.has(type) ? (
          <WaveCScene type={type} />
        ) : type === 'ir' ? (
          irFixtures().map((f) => (
            <Cell key={f.id} id={f.id} caption={f.caption} wide={f.orientation === 'horizontal'}>
              <IrTransmitterCard model={f.model} actions={IR_ACTIONS} orientation={f.orientation} />
            </Cell>
          ))
        ) : type === 'sensor' ? (
          sensorFixtures().map((f) => (
            <Cell key={f.id} id={f.id} caption={f.caption} wide={f.orientation === 'horizontal'}>
              <SensorCard model={f.model} orientation={f.orientation} />
            </Cell>
          ))
        ) : WAVE_D_TYPES.has(type) ? (
          <WaveDScene type={type} Cell={Cell} />
        ) : WAVE_E_TYPES.has(type) ? (
          <WaveEScene type={type} Cell={Cell} />
        ) : type === 'climate' || type === 'climate-extra' ? (
          (type === 'climate' ? CLIMATE_FIXTURES : CLIMATE_EXTRA_FIXTURES).map((f) => (
            <Cell key={f.id} id={f.id} caption={f.caption} wide={f.orientation === 'horizontal'}>
              <ClimateCard model={f.model} actions={CLIMATE_ACTIONS} orientation={f.orientation} />
            </Cell>
          ))
        ) : (
          plugFixtures().map((f) => (
            <Cell key={f.id} id={f.id} caption={f.caption} wide={f.orientation === 'horizontal'}>
              <PlugCard model={f.model} actions={PLUG_ACTIONS} orientation={f.orientation} />
            </Cell>
          ))
        )}
      </main>
    </UiTextProvider>
  )
}
