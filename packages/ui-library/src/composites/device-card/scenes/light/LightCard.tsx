import { NOT_REPORTED } from '@camstack/types'
import type { ReactElement } from 'react'
import { useUiText } from '../../../../contexts/ui-text'
import { LightIllustration, rgbCss } from '../../illustrations/LightIllustration'
import { CardButton } from '../../parts/CardButton'
import { HorizontalSlider } from '../../parts/sliders'
import { columnButton, columnPopover, columnSlider } from '../../shell/column-items'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation } from '../../shell/model'
import { SCENE_DRAWING_CLASS } from '../../shell/scene-layout'
import {
  LIGHT_PALETTE,
  LIGHT_WHITE_MAX_K,
  LIGHT_WHITE_MIN_K,
  LIGHT_WHITE_STEP_K,
  type LightCardActions,
  type LightCardModel,
} from './model'

export interface LightCardProps {
  readonly model: LightCardModel
  readonly actions: LightCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

/** The colours the light can be set to, one press each. */
function Palette({ onColor }: { readonly onColor: LightCardActions['onColor'] }): ReactElement {
  return (
    <div className="grid grid-cols-4 gap-2" data-testid="dc-light-palette">
      {LIGHT_PALETTE.map((c) => (
        <CardButton
          key={`${c.r}-${c.g}-${c.b}`}
          aria-label={`RGB ${c.r} ${c.g} ${c.b}`}
          className="h-8 min-h-8 w-8 min-w-8 rounded-full p-0"
          style={{ backgroundColor: rgbCss(c) }} // ui-check-ok: a colour sent to the device (data), not a theme colour
          onClick={() => onColor(c)}
        />
      ))}
    </div>
  )
}

/**
 * The light: on / off, its level beside the bulb, and the colour and white
 * popovers when it takes them. The bulb shines in the light's own colour.
 */
export function LightCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: LightCardProps): ReactElement {
  const t = useUiText()
  const on = model.on === true
  const label =
    model.on === null
      ? NOT_REPORTED.en
      : on
        ? t('uiLibrary.deviceCard.light.on', 'On')
        : t('uiLibrary.deviceCard.light.off', 'Off')
  const since = on ? (model.brightness === null ? null : `${model.brightness}%`) : model.since
  const brightnessLabel = t('uiLibrary.deviceCard.light.brightness', 'Brightness')
  const colourLabel = t('uiLibrary.deviceCard.light.colour', 'Colour')
  const whiteLabel = t('uiLibrary.deviceCard.light.white', 'White')
  return (
    <DeviceCard
      kind="light"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={on ? 'on' : 'off'}
      state={{ label, since, tone: on ? 'primary' : 'muted' }}
      scene={{
        columns: {
          left:
            model.brightness === null
              ? []
              : [
                  columnSlider('brightness', {
                    value: model.brightness,
                    min: 1,
                    max: 100,
                    ariaLabel: brightnessLabel,
                    disabled: !on,
                    valueLabel: (v) => (on ? `${v}%` : null),
                    onCommit: actions.onBrightness,
                    testId: 'dc-light-brightness',
                  }),
                ],
          right: [
            columnButton('power', {
              glyph: 'power',
              tone: on ? 'primary' : 'default',
              label: on
                ? t('uiLibrary.deviceCard.turnOff', 'Turn off')
                : t('uiLibrary.deviceCard.turnOn', 'Turn on'),
              testId: 'dc-light-power',
              onPress: () => actions.onPower(!on),
            }),
            ...(model.palette
              ? [
                  columnPopover('colour', {
                    glyph: 'colour',
                    label: colourLabel,
                    align: 'end',
                    disabled: !on,
                    testId: 'dc-light-colour',
                    panel: <Palette onColor={actions.onColor} />,
                  }),
                ]
              : []),
            ...(model.white === null
              ? []
              : [
                  columnPopover('white', {
                    glyph: 'white',
                    label: whiteLabel,
                    align: 'end',
                    disabled: !on,
                    testId: 'dc-light-white',
                    panel: (
                      <>
                        <div className="flex items-center justify-between text-xs text-foreground-muted">
                          <span>{t('uiLibrary.deviceCard.light.warm', 'Warm')}</span>
                          <span>{t('uiLibrary.deviceCard.light.cold', 'Cold')}</span>
                        </div>
                        <HorizontalSlider
                          value={model.white.kelvin ?? LIGHT_WHITE_MIN_K}
                          min={LIGHT_WHITE_MIN_K}
                          max={LIGHT_WHITE_MAX_K}
                          step={LIGHT_WHITE_STEP_K}
                          ariaLabel={t(
                            'uiLibrary.deviceCard.light.whiteTemperature',
                            'White temperature',
                          )}
                          valueLabel={(k) => `${k} K`}
                          onCommit={actions.onWhite}
                          testId="dc-light-kelvin"
                        />
                      </>
                    ),
                  }),
                ]),
          ],
        },
        image: (
          <LightIllustration
            on={on}
            color={model.color}
            brightness={model.brightness}
            className={SCENE_DRAWING_CLASS}
          />
        ),
      }}
    />
  )
}
