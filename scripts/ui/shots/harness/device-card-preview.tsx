/**
 * Fixture page for the device card. Not an admin route: `ui:shots` mounts it for
 * the path `/device-card-preview`; `?type=plug|climate|climate-extra|cover|light|fan|heater` picks the scene (`climate-extra`: the
 * variants real devices have and the mockup does not draw). Every
 * fixture carries the data of one variant of the approved mockup, so
 * `scripts/ui/card-parity.mjs` can shoot the two side by side. Strings are the
 * Italian catalogue, the mockup's language.
 */
import i18n from '@admin/i18n'
import { bridgeUiText } from '@admin/i18n/ui-text-bridge'
import {
  ClimateCard,
  type ClimateCardActions,
  CoverCard,
  type CoverCardActions,
  FanCard,
  type FanCardActions,
  HeaterCard,
  type HeaterCardActions,
  LightCard,
  type LightCardActions,
  PlugCard,
  type PlugCardActions,
  UiTextProvider,
} from '@camstack/ui-library'
import {
  CLIMATE_EXTRA_FIXTURES,
  CLIMATE_FIXTURES,
} from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/climate'
import { coverFixtures } from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/cover'
import { fanFixtures } from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/fan'
import { heaterFixtures } from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/heater'
import { lightFixtures } from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/light'
import { plugFixtures } from '../../../../packages/ui-library/src/composites/device-card/__fixtures__/plug'
import { type ReactElement, type ReactNode, useMemo } from 'react'

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
  const type = new URLSearchParams(window.location.search).get('type') ?? 'plug'
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
        {WAVE_A_TYPES.has(type) ? (
          <WaveAScene type={type} />
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
