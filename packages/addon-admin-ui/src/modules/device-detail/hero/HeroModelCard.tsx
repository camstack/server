import {
  heroArgsWithValue,
  HERO_ROW_LABELS,
  type HeroAction,
  type HeroCall,
  type HeroConsumableItem,
  type HeroControl,
  type HeroModel,
  type HeroRow,
  type HeroTimedRunSlot,
} from '@camstack/types'
import {
  Badge,
  Button,
  HeroCardA,
  HeroProgressBar,
  HeroRowLine,
  HeroScene,
  HeroSegmented,
  IconButton,
  resolveSceneVisual,
  SCENES_WITH_ART,
  Select,
  Slider,
  Switch,
  useDisplayIconResolver,
} from '@camstack/ui-library'
import { Minus, Plus } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { badgeVariantOf, type HeroLang, pickText, sceneOf, tilesOf } from './hero-model-view'

/** What the card asks its host to do: run the cap method an action or a control names. */
export interface HeroCardHost {
  readonly lang: HeroLang
  readonly busy: boolean
  /** Runs the call; `confirm` asks first. Resolves when the call settled. */
  readonly run: (call: HeroCall, action: HeroAction | null) => void
  /** Opens the device's history (cycles, meals, access ...). Absent: the foot button is not drawn. */
  readonly openHistory?: () => void
}

/** Facts the top line prints as chips; the rest are read in the scene tiles and rows. */
const CHIP_FACT_IDS: ReadonlySet<string> = new Set(['power', 'battery', 'link'])

/** A picker with at most this many options is a segmented control, a longer one a select. */
const SEGMENTED_MAX = 6

function IconGlyph({ name }: { readonly name: string }): ReactNode {
  const resolve = useDisplayIconResolver()
  const Glyph = resolve(name)
  return Glyph === undefined ? null : <Glyph className="h-4 w-4" aria-hidden />
}

function ActionButton({
  action,
  host,
  disabled,
}: {
  readonly action: HeroAction
  readonly host: HeroCardHost
  readonly disabled?: boolean
}): ReactNode {
  return (
    <Button
      size="sm"
      variant={action.emphasis === 'primary' ? 'primary' : 'outline'}
      disabled={host.busy || disabled === true}
      onClick={() => host.run(action.call, action)}
    >
      <IconGlyph name={action.icon} />
      {pickText(action.label, host.lang)}
    </Button>
  )
}

function SliderControl({
  control,
  host,
}: {
  readonly control: Extract<HeroControl, { kind: 'slider' }>
  readonly host: HeroCardHost
}): ReactNode {
  const [draft, setDraft] = useState<number | null>(null)
  const shown = draft ?? control.value ?? control.min
  const commit = (): void => {
    if (draft === null) return
    host.run(
      {
        ...control.call,
        args: heroArgsWithValue(control.call.args, control.valueArg, draft),
      },
      null,
    )
    setDraft(null)
  }
  return (
    <div className="flex items-center gap-2">
      <Slider
        aria-label={pickText(control.label, host.lang)}
        className="min-w-0 flex-1"
        min={control.min}
        max={control.max}
        step={control.step}
        value={shown}
        disabled={host.busy || control.value === null}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="w-12 text-right text-xs tabular-nums text-foreground-muted">
        {control.value === null ? '–' : `${String(shown)}${control.unit}`}
      </span>
    </div>
  )
}

function PickerControl({
  control,
  host,
  tone,
}: {
  readonly control: Extract<HeroControl, { kind: 'picker' }>
  readonly host: HeroCardHost
  readonly tone: Parameters<typeof HeroProgressBar>[0]['tone']
}): ReactNode {
  const choose = (value: string): void =>
    host.run(
      {
        ...control.call,
        args: heroArgsWithValue(control.call.args, control.valueArg, value),
      },
      null,
    )
  const label = pickText(control.label, host.lang)
  const optionLabel = (o: string): string => {
    const named = control.optionLabels?.[o]
    return named === undefined ? o : pickText(named, host.lang)
  }
  if (control.options.length <= SEGMENTED_MAX) {
    return (
      <HeroSegmented
        label={label}
        tone={tone}
        value={control.current}
        disabled={host.busy}
        options={control.options.map((o) => ({ value: o, label: optionLabel(o) }))}
        onChange={choose}
      />
    )
  }
  return (
    <Select
      aria-label={label}
      wrapperClassName="relative w-40 max-w-full"
      value={control.current ?? ''}
      disabled={host.busy}
      options={[
        ...(control.current === null ? [{ value: '', label: '–' }] : []),
        ...control.options.map((o) => ({ value: o, label: optionLabel(o) })),
      ]}
      onChange={(e) => choose(e.target.value)}
    />
  )
}

type SliderModel = Extract<HeroControl, { kind: 'slider' }>

/** The setpoint of a climate scene: the target in big digits with a round minus and plus at its sides. */
function SetpointCentre({
  control,
  host,
}: {
  readonly control: SliderModel
  readonly host: HeroCardHost
}): ReactNode {
  const value = control.value
  const step = (direction: 1 | -1): void => {
    if (value === null) return
    const next = Math.min(control.max, Math.max(control.min, value + direction * control.step))
    if (next === value) return
    host.run(
      { ...control.call, args: heroArgsWithValue(control.call.args, control.valueArg, next) },
      null,
    )
  }
  const label = pickText(control.label, host.lang)
  return (
    <div data-testid="setpoint-centre" className="flex items-center gap-2 text-current">
      <IconButton
        aria-label={`${label} −`}
        icon={Minus}
        size="lg"
        variant="outline"
        className="rounded-full"
        disabled={host.busy || value === null || value <= control.min}
        onClick={() => step(-1)}
      />
      <span className="text-5xl font-semibold tabular-nums leading-none text-current">
        {value === null ? '–' : String(value)}
        <span className="align-top text-xl">{control.unit}</span>
      </span>
      <IconButton
        aria-label={`${label} +`}
        icon={Plus}
        size="lg"
        variant="outline"
        className="rounded-full"
        disabled={host.busy || value === null || value >= control.max}
        onClick={() => step(1)}
      />
    </div>
  )
}

/** The setpoint slider of a model, when its scene draws it in the centre. */
function setpointOf(model: HeroModel): SliderModel | null {
  const control = model.rows.find((r) => r.id === 'setpoint' && !model.gated.includes(r.id))
    ?.controls[0]
  return control !== undefined && control.kind === 'slider' ? control : null
}

function ToggleControl({
  control,
  host,
}: {
  readonly control: Extract<HeroControl, { kind: 'toggle' }>
  readonly host: HeroCardHost
}): ReactNode {
  return (
    <Switch
      aria-label={pickText(control.label, host.lang)}
      checked={control.on === true}
      disabled={host.busy || control.on === null}
      onCheckedChange={(next) => {
        const action = next ? control.turnOn : control.turnOff
        host.run(action.call, action)
      }}
    />
  )
}

/** Sliders and pickers read as the row's value; buttons and switches sit at its right. */
const isValueControl = (control: HeroControl): boolean =>
  control.kind === 'slider' || control.kind === 'picker'

function ControlView({
  control,
  host,
  tone,
}: {
  readonly control: HeroControl
  readonly host: HeroCardHost
  readonly tone: Parameters<typeof HeroProgressBar>[0]['tone']
}): ReactNode {
  switch (control.kind) {
    case 'action':
      return <ActionButton action={control.action} host={host} />
    case 'toggle':
      return <ToggleControl control={control} host={host} />
    case 'slider':
      return <SliderControl control={control} host={host} />
    case 'picker':
      return <PickerControl control={control} host={host} tone={tone} />
  }
}

function ModelRow({
  row,
  host,
  tone,
}: {
  readonly row: HeroRow
  readonly host: HeroCardHost
  readonly tone: Parameters<typeof HeroProgressBar>[0]['tone']
}): ReactNode {
  const label = pickText(HERO_ROW_LABELS[row.id], host.lang)
  const valueControls = row.controls.filter(isValueControl)
  const actionControls = row.controls.filter((c) => !isValueControl(c))
  const status = row.status === null ? null : pickText(row.status, host.lang)
  return (
    <HeroRowLine
      testId={`hero-row-${row.id}`}
      label={label}
      actions={actionControls.map((control, i) => (
        <ControlView key={i} control={control} host={host} tone={tone} />
      ))}
    >
      {row.progress === undefined || row.progress === null ? (
        <>
          {status === null || valueControls.length > 0 ? null : (
            <div className="truncate">{status}</div>
          )}
          {valueControls.map((control, i) => (
            <ControlView key={i} control={control} host={host} tone={tone} />
          ))}
        </>
      ) : (
        <HeroProgressBar value={row.progress} label={label} tone={tone} />
      )}
    </HeroRowLine>
  )
}

function TimedRunRow({
  slot,
  host,
}: {
  readonly slot: HeroTimedRunSlot
  readonly host: HeroCardHost
}): ReactNode {
  return (
    <HeroRowLine
      testId="hero-timed-run"
      label={pickText(HERO_ROW_LABELS['run-for'], host.lang)}
      actions={
        <ActionButton action={slot.activeUntil !== null ? slot.cancel : slot.run} host={host} />
      }
    />
  )
}

function BaseSlotRows({
  model,
  host,
}: {
  readonly model: HeroModel
  readonly host: HeroCardHost
}): ReactNode {
  const gated = new Set(model.gated)
  const { ownPower, timedRun, powerSupply } = model
  return (
    <>
      {ownPower !== null && !gated.has('own-power') ? (
        <HeroRowLine
          testId="hero-own-power"
          label={host.lang === 'it' ? 'Accensione' : 'Power'}
          actions={
            <ToggleControl
              host={host}
              control={{
                kind: 'toggle',
                id: 'own-power',
                label: ownPower.turnOn.label,
                on: ownPower.on,
                turnOn: ownPower.turnOn,
                turnOff: ownPower.turnOff,
              }}
            />
          }
        />
      ) : null}
      {timedRun !== null && !gated.has('timed-run') ? (
        <TimedRunRow slot={timedRun} host={host} />
      ) : null}
      {powerSupply !== null && !gated.has('power-supply') ? (
        <HeroRowLine
          testId="hero-power-supply"
          label={host.lang === 'it' ? 'Alimentazione' : 'Supply'}
          actions={
            <>
              <ActionButton
                action={powerSupply.on === true ? powerSupply.powerOff : powerSupply.powerOn}
                host={host}
              />
              <ActionButton
                action={powerSupply.restart}
                host={host}
                disabled={powerSupply.on !== true}
              />
            </>
          }
        />
      ) : null}
    </>
  )
}

function Chips({ model, lang }: { readonly model: HeroModel; readonly lang: HeroLang }): ReactNode {
  const factIds = new Set(model.facts.map((f) => f.id))
  return (
    <>
      {model.badges
        .filter(
          (badge) =>
            badge.id === 'integration' ||
            !factIds.has(badge.id === 'network-link' ? 'link' : badge.id),
        )
        .map((badge) => (
          <Badge key={badge.id} variant={badgeVariantOf(badge.tone)} size="sm">
            {pickText(badge.label, lang)}
          </Badge>
        ))}
      {model.facts
        .filter((fact) => CHIP_FACT_IDS.has(fact.id))
        .map((fact) => (
          <Badge key={fact.id} variant={badgeVariantOf(fact.tone)} size="sm">
            {pickText(fact.text, lang)}
          </Badge>
        ))}
    </>
  )
}

function FootChips({ items }: { readonly items: HeroConsumableItem[] }): ReactNode {
  return (
    <>
      {items.map((item) => (
        <Badge key={item.key} variant={item.needsAttention ? 'warning' : 'neutral'} size="sm">
          {item.level === null ? item.label : `${item.label} ${String(Math.round(item.level))}%`}
        </Badge>
      ))}
    </>
  )
}

export interface HeroModelCardProps {
  readonly model: HeroModel
  readonly host: HeroCardHost
  /** The remote button, when the model carries the `remote` slot. */
  readonly remote?: ReactNode
}

/** Layout A, drawn from the hero model and nothing else (D1023). */
export function HeroModelCard({ model, host, remote }: HeroModelCardProps): ReactNode {
  const { lang } = host
  const scene = sceneOf(model)
  const gated = new Set(model.gated)
  const showRemote = model.remote !== null && !gated.has('remote')
  const tone = resolveSceneVisual(scene).tone
  const footItems = model.consumables?.items ?? []
  const hasFoot = host.openHistory !== undefined || showRemote
  const setpoint = setpointOf(model)
  return (
    <HeroCardA
      title={model.name}
      chips={<Chips model={model} lang={lang} />}
      scene={
        <HeroScene
          {...scene}
          caption={pickText(model.caption ?? model.title, lang)}
          toneCentre={setpoint !== null}
          leftTiles={tilesOf(model.sideTiles.left, lang)}
          rightTiles={tilesOf(model.sideTiles.right, lang)}
        >
          {model.background.kind === 'artwork' ? (
            <img
              src={model.background.url}
              alt=""
              className="size-24 rounded-lg border border-border object-cover"
            />
          ) : setpoint !== null ? (
            <SetpointCentre control={setpoint} host={host} />
          ) : SCENES_WITH_ART.has(scene.scene) ? undefined : (
            <span className="text-foreground [&>svg]:h-8 [&>svg]:w-8">
              <IconGlyph name={model.look.icon} />
            </span>
          )}
        </HeroScene>
      }
      rows={
        <>
          <BaseSlotRows model={model} host={host} />
          {model.rows
            .filter((row) => !gated.has(row.id) && !(setpoint !== null && row.id === 'setpoint'))
            .map((row) => (
              <ModelRow key={row.id} row={row} host={host} tone={tone} />
            ))}
        </>
      }
      footChips={footItems.length > 0 ? <FootChips items={footItems} /> : undefined}
      footAction={
        hasFoot ? (
          <div className="flex items-center gap-1.5">
            {showRemote ? remote : null}
            {host.openHistory === undefined ? null : (
              <Button size="sm" variant="outline" onClick={host.openHistory}>
                {pickText(model.historyLabel, lang)}
              </Button>
            )}
          </div>
        ) : undefined
      }
    />
  )
}
