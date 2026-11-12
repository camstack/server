import type { ReactElement, ReactNode } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import type { CardGlyph } from '../../icons'
import { AmbientFx } from '../../illustrations/AmbientFx'
import { HeatPumpIllustration } from '../../illustrations/HeatPumpIllustration'
import { ButtonGroup } from '../../parts/ButtonGroup'
import { CardButton } from '../../parts/CardButton'
import { LevelBar } from '../../parts/LevelBar'
import { MenuButton } from '../../parts/MenuButton'
import { PopoverButton } from '../../parts/PopoverButton'
import { CardReadings } from '../../parts/Readings'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation, CardTone } from '../../shell/model'
import type {
  HeatPumpActivity,
  HeatPumpCardActions,
  HeatPumpCardModel,
  HeatPumpCircuitView,
  HeatPumpSystemModeId,
  HeatPumpSystemModeView,
} from './model'

export interface HeatPumpCardProps {
  readonly model: HeatPumpCardModel
  readonly actions: HeatPumpCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

const TONE: Readonly<Record<HeatPumpActivity, CardTone>> = {
  heat: 'primary',
  dhw: 'primary',
  cool: 'info',
  defrost: 'info',
  idle: 'muted',
}

const SYSTEM_GLYPH: Readonly<Record<HeatPumpSystemModeId, CardGlyph>> = {
  silent: 'mute',
  away: 'away',
  additionalHeater: 'flame',
  holiday: 'holiday',
}

export function heatPumpStateLabel(activity: HeatPumpActivity, t: UiTextFn): string {
  switch (activity) {
    case 'heat':
      return t('uiLibrary.deviceCard.heatPump.heating', 'Heating')
    case 'dhw':
      return t('uiLibrary.deviceCard.heatPump.hotWater', 'Hot water')
    case 'cool':
      return t('uiLibrary.deviceCard.heatPump.cooling', 'Cooling')
    case 'defrost':
      return t('uiLibrary.deviceCard.heatPump.defrost', 'Defrosting')
    case 'idle':
      return t('uiLibrary.deviceCard.heatPump.idle', 'Standby')
  }
}

function systemModeLabel(id: HeatPumpSystemModeId, t: UiTextFn): string {
  switch (id) {
    case 'silent':
      return t('uiLibrary.deviceCard.heatPump.silent', 'Silent')
    case 'away':
      return t('uiLibrary.deviceCard.heatPump.away', 'Away')
    case 'additionalHeater':
      return t('uiLibrary.deviceCard.heatPump.additionalHeater', 'Additional heater')
    case 'holiday':
      return t('uiLibrary.deviceCard.heatPump.holiday', 'Holiday')
  }
}

const degrees = (value: number | null): string | null =>
  value === null ? null : `${value.toFixed(1)}°`
const kilowatts = (watts: number | null): string | null =>
  watts === null ? null : `${(watts / 1000).toFixed(1)} kW`

function CircuitButton({
  circuit,
  onPick,
  t,
}: {
  readonly circuit: HeatPumpCircuitView
  readonly onPick: HeatPumpCardActions['onCircuit']
  readonly t: UiTextFn
}): ReactElement {
  const picker = circuit.picker
  return (
    <PopoverButton
      testId={`dc-hp-circuit-${circuit.id}`}
      ariaLabel={t('uiLibrary.deviceCard.heatPump.openCircuit', 'Open {{name}}', {
        name: circuit.label,
      })}
      label={
        <span className="truncate">
          {`${circuit.label} · ${circuit.status}`}
          {circuit.detail === null ? null : (
            <small className="ml-1 text-foreground-muted">{circuit.detail}</small>
          )}
        </span>
      }
    >
      <div className="text-sm font-semibold">{circuit.label}</div>
      {picker === null ? (
        <div className="text-xs text-foreground-muted">
          {t('uiLibrary.deviceCard.heatPump.noSettings', 'Nothing to set on this circuit')}
        </div>
      ) : (
        <ButtonGroup
          testId={`dc-hp-circuit-${circuit.id}-${picker.kind}`}
          ariaLabel={
            picker.kind === 'level'
              ? t('uiLibrary.deviceCard.heatPump.level', 'Level')
              : t('uiLibrary.deviceCard.heatPump.mode', 'Mode')
          }
          options={picker.options}
          value={picker.value}
          onChange={(value) => onPick(circuit.id, picker.kind, value)}
        />
      )}
    </PopoverButton>
  )
}

function SystemMode({
  mode,
  onChange,
  t,
}: {
  readonly mode: HeatPumpSystemModeView
  readonly onChange: HeatPumpCardActions['onSystemMode']
  readonly t: UiTextFn
}): ReactElement {
  const label = systemModeLabel(mode.id, t)
  const toggleOn = mode.toggleOn
  if (toggleOn !== null) {
    const pressed = mode.value !== null && mode.value !== 'off'
    return (
      <CardButton
        glyph={SYSTEM_GLYPH[mode.id]}
        tone={pressed ? 'on' : 'default'}
        aria-pressed={pressed}
        data-testid={`dc-hp-system-${mode.id}`}
        onClick={() => onChange(mode.id, pressed ? 'off' : toggleOn)}
      >
        {label}
      </CardButton>
    )
  }
  const current = mode.options.find((o) => o.id === mode.value)
  return (
    <MenuButton
      testId={`dc-hp-system-${mode.id}`}
      ariaLabel={label}
      triggerLabel={current === undefined ? label : `${label} · ${current.label}`}
      options={mode.options.map((o) => ({ ...o, glyph: SYSTEM_GLYPH[mode.id] }))}
      value={mode.value}
      onChange={(value) => onChange(mode.id, value)}
    />
  )
}

function bottomRow(model: HeatPumpCardModel, actions: HeatPumpCardActions, t: UiTextFn): ReactNode {
  if (model.circuits.length === 0 && model.system.length === 0) return null
  return (
    <>
      {model.circuits.length === 0 ? null : (
        <div
          data-testid="dc-hp-circuits"
          className="flex max-w-full flex-wrap justify-center gap-1.5"
        >
          {model.circuits.map((c) => (
            <CircuitButton key={c.id} circuit={c} onPick={actions.onCircuit} t={t} />
          ))}
        </div>
      )}
      {model.system.length === 0 ? null : (
        <div
          data-testid="dc-hp-system"
          className="flex max-w-full flex-wrap justify-center gap-1.5"
        >
          {model.system.map((m) => (
            <SystemMode key={m.id} mode={m} onChange={actions.onSystemMode} t={t} />
          ))}
        </div>
      )}
    </>
  )
}

/**
 * A heat pump: the outdoor unit whose fan turns with the compressor, the loop
 * temperatures on the left, thermal and electrical power with the COP on the
 * right, and below one button per circuit (it opens that circuit's mode or
 * hot-water level) and the system modes the gateway declares. A value the
 * gateway does not report is a dash, never a zero.
 */
export function HeatPumpCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: HeatPumpCardProps): ReactElement {
  const t = useUiText()
  const cold = model.activity === 'cool' || model.activity === 'defrost'
  const comp = model.compressorPct
  return (
    <DeviceCard
      kind="heat-pump"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={model.activity}
      state={{
        label: heatPumpStateLabel(model.activity, t),
        since: model.since,
        tone: TONE[model.activity],
      }}
      scene={{
        fx: (
          <AmbientFx
            role="heat-pump"
            activity={model.activity === 'idle' ? 'idle' : cold ? 'cool' : 'heat'}
            swing={false}
          />
        ),
        left: (
          <CardReadings
            testId="dc-hp-temps"
            align="end"
            items={[
              {
                id: 'outdoor',
                label: t('uiLibrary.deviceCard.heatPump.outdoor', 'Outdoor'),
                value: degrees(model.temperatures.outdoor),
              },
              {
                id: 'supply',
                label: t('uiLibrary.deviceCard.heatPump.supply', 'Flow'),
                value: degrees(model.temperatures.supply),
              },
              {
                id: 'return',
                label: t('uiLibrary.deviceCard.heatPump.return', 'Return'),
                value: degrees(model.temperatures.return),
              },
              {
                id: 'pressure',
                label: t('uiLibrary.deviceCard.heatPump.pressure', 'Pressure'),
                value: model.pressureBar === null ? null : `${model.pressureBar} bar`,
              },
            ]}
          />
        ),
        image: (
          <div className="grid w-26 justify-items-center gap-1.5">
            <HeatPumpIllustration compressorPct={comp} cold={cold} className="h-auto w-26" />
            <div
              data-testid="dc-hp-compressor"
              className="grid w-full gap-1 text-center text-xs text-foreground-muted"
            >
              {t('uiLibrary.deviceCard.heatPump.compressor', 'Compressor {{value}}', {
                value: comp === null ? '—' : `${Math.round(comp)}%`,
              })}
              <LevelBar
                percent={comp ?? 0}
                ariaLabel={t('uiLibrary.deviceCard.heatPump.compressorBar', 'Compressor speed')}
              />
            </div>
          </div>
        ),
        right: (
          <CardReadings
            testId="dc-hp-power"
            items={[
              {
                id: 'thermal',
                label: t('uiLibrary.deviceCard.heatPump.thermal', 'Thermal'),
                value: kilowatts(model.thermalW),
              },
              {
                id: 'electrical',
                label: t('uiLibrary.deviceCard.heatPump.electrical', 'Electrical'),
                value: kilowatts(model.electricalW),
              },
              {
                id: 'cop',
                label: t('uiLibrary.deviceCard.heatPump.cop', 'COP'),
                value: model.cop === null ? null : model.cop.toFixed(1),
              },
            ]}
          />
        ),
        bottom: bottomRow(model, actions, t),
      }}
    />
  )
}
