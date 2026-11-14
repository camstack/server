import type { ReactElement } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import type { CardGlyph } from '../../icons'
import { AmbientFx } from '../../illustrations/AmbientFx'
import { HeatPumpIllustration } from '../../illustrations/HeatPumpIllustration'
import { ButtonGroup } from '../../parts/ButtonGroup'
import { CardButton } from '../../parts/CardButton'
import { LevelBar } from '../../parts/LevelBar'
import { MenuButton } from '../../parts/MenuButton'
import { PopoverButton } from '../../parts/PopoverButton'
import { type ColumnItem, columnValue } from '../../shell/column-items'
import { type BottomRow, rowButtons } from '../../shell/bottom-rows'
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

/** A reading the gateway may not report: a dash, never a zero. */
function reading(id: string, label: string, value: string | null): ColumnItem {
  return columnValue(id, {
    value: value ?? '—',
    caption: label,
    tone: value === null ? 'muted' : 'primary',
    testId: `dc-hp-${id}`,
  })
}

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
      options={mode.options.map((o) => ({
        ...o,
        glyph: SYSTEM_GLYPH[mode.id],
      }))}
      value={mode.value}
      onChange={(value) => onChange(mode.id, value)}
    />
  )
}

function bottomRows(
  model: HeatPumpCardModel,
  actions: HeatPumpCardActions,
  t: UiTextFn,
): readonly BottomRow[] {
  return [
    ...(model.circuits.length === 0
      ? []
      : [
          rowButtons('circuits', {
            testId: 'dc-hp-circuits',
            buttons: model.circuits.map((c) => (
              <CircuitButton key={c.id} circuit={c} onPick={actions.onCircuit} t={t} />
            )),
          }),
        ]),
    ...(model.system.length === 0
      ? []
      : [
          rowButtons('system', {
            testId: 'dc-hp-system',
            buttons: model.system.map((m) => (
              <SystemMode key={m.id} mode={m} onChange={actions.onSystemMode} t={t} />
            )),
          }),
        ]),
  ]
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
        columns: {
          left: [
            reading(
              'outdoor',
              t('uiLibrary.deviceCard.heatPump.outdoor', 'Outdoor'),
              degrees(model.temperatures.outdoor),
            ),
            reading(
              'supply',
              t('uiLibrary.deviceCard.heatPump.supply', 'Flow'),
              degrees(model.temperatures.supply),
            ),
            reading(
              'return',
              t('uiLibrary.deviceCard.heatPump.return', 'Return'),
              degrees(model.temperatures.return),
            ),
            reading(
              'pressure',
              t('uiLibrary.deviceCard.heatPump.pressure', 'Pressure'),
              model.pressureBar === null ? null : `${model.pressureBar} bar`,
            ),
          ],
          right: [
            reading(
              'thermal',
              t('uiLibrary.deviceCard.heatPump.thermal', 'Thermal'),
              kilowatts(model.thermalW),
            ),
            reading(
              'electrical',
              t('uiLibrary.deviceCard.heatPump.electrical', 'Electrical'),
              kilowatts(model.electricalW),
            ),
            reading(
              'cop',
              t('uiLibrary.deviceCard.heatPump.cop', 'COP'),
              model.cop === null ? null : model.cop.toFixed(1),
            ),
          ],
        },
        image: (
          <div className="grid w-full min-w-26 max-w-52 justify-items-center gap-1.5">
            <HeatPumpIllustration compressorPct={comp} cold={cold} className="h-auto w-full" />
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
        bottom: bottomRows(model, actions, t),
      }}
    />
  )
}
