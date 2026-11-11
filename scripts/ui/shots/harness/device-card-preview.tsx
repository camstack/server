/**
 * Fixture page for the device card. Not an admin route: `ui:shots` mounts it for
 * the path `/device-card-preview`; `?type=plug|climate` picks the scene. Every
 * fixture carries the data of one variant of the approved mockup, so
 * `scripts/ui/card-parity.mjs` can shoot the two side by side. Strings are the
 * Italian catalogue, the mockup's language.
 */
import i18n from '@admin/i18n'
import { bridgeUiText } from '@admin/i18n/ui-text-bridge'
import {
  CLIMATE_FIXTURES,
  ClimateCard,
  type ClimateCardActions,
  PlugCard,
  type PlugCardActions,
  plugFixtures,
  UiTextProvider,
} from '@camstack/ui-library'
import { type ReactElement, type ReactNode, useMemo } from 'react'

const noop = (): void => undefined
const PLUG_ACTIONS: PlugCardActions = { onPower: noop, onTimerStart: noop, onTimerStop: noop }
const CLIMATE_ACTIONS: ClimateCardActions = {
  onPower: noop,
  onTarget: noop,
  onMode: noop,
  onFan: noop,
  onSwing: noop,
  onPreset: noop,
  onHeatCool: noop,
}

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
        {type === 'climate'
          ? CLIMATE_FIXTURES.map((f) => (
              <Cell key={f.id} id={f.id} caption={f.caption} wide={f.orientation === 'horizontal'}>
                <ClimateCard
                  model={f.model}
                  actions={CLIMATE_ACTIONS}
                  orientation={f.orientation}
                />
              </Cell>
            ))
          : plugFixtures().map((f) => (
              <Cell key={f.id} id={f.id} caption={f.caption} wide={f.orientation === 'horizontal'}>
                <PlugCard model={f.model} actions={PLUG_ACTIONS} orientation={f.orientation} />
              </Cell>
            ))}
      </main>
    </UiTextProvider>
  )
}
