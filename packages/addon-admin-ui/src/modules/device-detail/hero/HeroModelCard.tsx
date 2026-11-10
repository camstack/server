import {
  heroArgsWithValue,
  HERO_ROW_LABELS,
  type HeroAction,
  type HeroCall,
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
  type HeroScenePower,
  HeroSegmented,
  HeroUtilityGrid,
  IconButton,
  resolveSceneVisual,
  SCENES_WITH_ART,
  Select,
  Slider,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useDisplayIconResolver,
} from '@camstack/ui-library'
import { Minus, Plus } from 'lucide-react'
import { Fragment, type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { badgeVariantOf, type HeroLang, pickText, sceneOf, tilesOf } from './hero-model-view'
import { useHeroUtilities } from './hero-utilities'

/** What the card asks its host to do: run the cap method an action or a control names. */
export interface HeroCardHost {
  readonly lang: HeroLang
  readonly busy: boolean
  /** Runs the call; `confirm` asks first. Resolves when the call settled. */
  readonly run: (call: HeroCall, action: HeroAction | null) => void
  /** Opens the device's history (cycles, meals, access ...). Absent: the history utility is not drawn. */
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
  className,
}: {
  readonly action: HeroAction
  readonly host: HeroCardHost
  readonly disabled?: boolean
  readonly className?: string
}): ReactNode {
  return (
    <Button
      size="sm"
      {...(className === undefined ? {} : { className })}
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
  const { t } = useTranslation()
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
        options={control.options.map((o) => ({
          value: o,
          label: optionLabel(o),
        }))}
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
        ...(control.current === null
          ? [{ value: '', label: t('deviceHero.model.noValue', '–') }]
          : []),
        ...control.options.map((o) => ({ value: o, label: optionLabel(o) })),
      ]}
      onChange={(e) => choose(e.target.value)}
    />
  )
}

type SliderModel = Extract<HeroControl, { kind: 'slider' }>

/** A scene-placed row without the controls the scene draws; what only a row can hold (a picker) stays. */
function withoutSceneControls(row: HeroRow): HeroRow {
  if (row.placement !== 'scene') return row
  const rest = row.controls.filter((c) => !isSceneControl(c))
  return { ...row, status: rest.length === 0 ? null : row.status, controls: rest }
}

/** A row without the slider the scene already draws in its centre. */
function withoutDial(row: HeroRow, dial: Dial | null): HeroRow {
  if (dial === null || row.controls.every((c) => c !== dial.control)) return row
  return {
    ...row,
    status: null,
    controls: row.controls.filter((c) => c !== dial.control),
  }
}

/** What the centre dial prints: the number, the small mark after it and an optional heading. */
interface DialView {
  readonly text: string
  readonly mark: string
  readonly heading: string | null
}

/** A centre dial: the setpoint of a climate scene, the speed of a fan. */
interface Dial {
  readonly kind: 'setpoint' | 'speed'
  readonly control: SliderModel
}

/** The slider the scene draws in its centre: a climate's target, else a fan's speed. */
function dialOf(model: HeroModel): Dial | null {
  const gated = new Set(model.gated)
  const find = (id: string): SliderModel | null => {
    const control = model.rows.find((r) => r.id === id && !gated.has(r.id))?.controls[0]
    return control !== undefined && control.kind === 'slider' ? control : null
  }
  const setpoint = find('setpoint')
  if (setpoint !== null) return { kind: 'setpoint', control: setpoint }
  const speed = model.scene.id === 'fan' ? find('fan') : null
  return speed === null ? null : { kind: 'speed', control: speed }
}

/** A fan speed in percent reads as a step of its own scale: 60 % on a 20 % step is "3 / 5". */
function dialView(dial: Dial, lang: HeroLang): DialView {
  const { control } = dial
  const value = control.value
  if (dial.kind === 'setpoint') {
    return {
      text: value === null ? '–' : String(value),
      mark: control.unit,
      heading: null,
    }
  }
  const heading = pickText(control.label, lang)
  if (value === null) return { text: '–', mark: '', heading }
  const steps = control.step > 0 ? Math.round((control.max - control.min) / control.step) : 0
  if (steps <= 1) return { text: `${String(value)}${control.unit}`, mark: '', heading }
  return {
    text: String(Math.round((value - control.min) / control.step)),
    mark: `/${steps}`,
    heading,
  }
}

/** The centre dial of a scene: the value in big digits with a round minus and plus at its sides. */
function DialCentre({
  dial,
  host,
}: {
  readonly dial: Dial
  readonly host: HeroCardHost
}): ReactNode {
  const { control } = dial
  const value = control.value
  const view = dialView(dial, host.lang)
  const step = (direction: 1 | -1): void => {
    if (value === null) return
    const next = Math.min(control.max, Math.max(control.min, value + direction * control.step))
    if (next === value) return
    host.run(
      {
        ...control.call,
        args: heroArgsWithValue(control.call.args, control.valueArg, next),
      },
      null,
    )
  }
  const label = pickText(control.label, host.lang)
  return (
    <div
      data-testid={dial.kind === 'setpoint' ? 'setpoint-centre' : 'speed-centre'}
      className="flex flex-col items-center gap-1 text-current"
    >
      {view.heading === null ? null : (
        <span className="text-[11px] font-semibold uppercase tracking-wide">{view.heading}</span>
      )}
      <div className="flex items-center gap-2">
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
          {view.text}
          <span
            className={
              dial.kind === 'setpoint' ? 'align-top text-xl' : 'text-xl text-foreground-muted'
            }
          >
            {view.mark}
          </span>
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
    </div>
  )
}

/** Seconds left as "18:42" (or "1:05:09" past the hour). */
function countdownText(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const two = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${String(h)}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`
}

/** The time now, re-read every second while a deadline is pending. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/** A run on a timer, in the scene's centre: the time left as the big value, with Stop and the quick run again. */
function CountdownCentre({
  slot,
  host,
  actionable,
}: {
  readonly slot: HeroTimedRunSlot
  readonly host: HeroCardHost
  readonly actionable: boolean
}): ReactNode {
  const until = slot.activeUntil
  const now = useNow(until !== null)
  if (until === null) return null
  return (
    <div data-testid="countdown-centre" className="flex flex-col items-center gap-2 text-current">
      <span className="text-5xl font-semibold tabular-nums leading-none text-current">
        {countdownText(until - now)}
      </span>
      {actionable ? (
        <div className="flex items-center gap-1.5 text-foreground">
          <ActionButton action={slot.cancel} host={host} className="whitespace-nowrap" />
          <ActionButton
            action={{ ...slot.run, emphasis: 'normal' }}
            host={host}
            className="whitespace-nowrap"
          />
        </div>
      ) : null}
    </div>
  )
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

/** A command on the scene: an icon button, named by its label in a tooltip and for assistive tech. */
function SceneAction({
  action,
  host,
}: {
  readonly action: HeroAction
  readonly host: HeroCardHost
}): ReactNode {
  const resolve = useDisplayIconResolver()
  const label = pickText(action.label, host.lang)
  return (
    <Tooltip className="inline-block">
      <TooltipTrigger>
        <IconButton
          aria-label={label}
          icon={resolve(action.icon) ?? Minus}
          size="md"
          variant={action.emphasis === 'primary' ? 'primary' : 'outline'}
          disabled={host.busy}
          data-testid={`scene-action-${action.id}`}
          onClick={() => host.run(action.call, action)}
        />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** The controls of a scene-placed row that the scene can draw: commands and sliders. */
const isSceneControl = (control: HeroControl): boolean =>
  control.kind === 'action' || control.kind === 'slider'

function SceneControls({
  rows,
  host,
}: {
  readonly rows: readonly HeroRow[]
  readonly host: HeroCardHost
}): ReactNode {
  const controls = rows.flatMap((r) => r.controls.filter(isSceneControl))
  if (controls.length === 0) return null
  const actions = controls.filter((c) => c.kind === 'action')
  const sliders = controls.filter((c) => c.kind === 'slider')
  return (
    <>
      {actions.length === 0 ? null : (
        <div className="flex items-center gap-1.5">
          {actions.map((c) => (
            <SceneAction key={c.action.id} action={c.action} host={host} />
          ))}
        </div>
      )}
      {sliders.map((c) => (
        <div key={c.id} className="w-full max-w-64">
          <SliderControl control={c} host={host} />
        </div>
      ))}
    </>
  )
}

/** Rows whose status (the circuit's temperatures) stays beside their selector instead of giving way to it. */
const STATUS_BESIDE_CONTROLS: ReadonlySet<HeroRow['id']> = new Set(['circuit', 'system-mode'])

function GroupHeader({ text }: { readonly text: string }): ReactNode {
  return (
    <div
      data-testid="hero-row-group"
      className="px-1 pt-1 text-xs font-semibold uppercase tracking-wide text-foreground-muted"
    >
      {text}
    </div>
  )
}

function PillsRow({
  row,
  host,
}: {
  readonly row: HeroRow
  readonly host: HeroCardHost
}): ReactNode {
  const label = pickText(row.label ?? HERO_ROW_LABELS[row.id], host.lang)
  return (
    <div
      data-testid={`hero-row-${row.id}`}
      className="flex flex-col gap-1.5 rounded-lg border border-border-subtle bg-surface px-3 py-2"
    >
      <span className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {(row.pills ?? []).map((pill, i) => (
          <Badge
            key={i}
            variant={badgeVariantOf(pill.tone)}
            style={pill.tone === 'muted' ? 'outline' : 'solid'} // ui-check-ok: Badge's own fill-style prop, not CSS
            size="md"
            {...(pill.icon === null ? {} : { icon: <IconGlyph name={pill.icon} /> })}
          >
            {pickText(pill.text, host.lang)}
          </Badge>
        ))}
      </div>
    </div>
  )
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
  if (row.pills !== undefined && row.pills.length > 0) return <PillsRow row={row} host={host} />
  const label = pickText(row.label ?? HERO_ROW_LABELS[row.id], host.lang)
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
          {status === null ||
          (valueControls.length > 0 && !STATUS_BESIDE_CONTROLS.has(row.id)) ? null : (
            <div>{status}</div>
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

/**
 * The device's own on/off, drawn by the scene: its state leads the caption and, for a
 * session that may act, is the switch. A climate device switches off through its own mode
 * picker, so it carries none; an unanswered device carries none either.
 */
function powerOf(model: HeroModel, host: HeroCardHost): HeroScenePower | undefined {
  const { ownPower } = model
  if (ownPower === null || ownPower.source === 'climate-control' || ownPower.on === null) {
    return undefined
  }
  const value = ownPower.on
    ? host.lang === 'it'
      ? 'Acceso'
      : 'On'
    : host.lang === 'it'
      ? 'Spento'
      : 'Off'
  if (model.gated.includes('own-power')) return { value, on: ownPower.on }
  const next = ownPower.on ? ownPower.turnOff : ownPower.turnOn
  return {
    value,
    on: ownPower.on,
    action: {
      label: pickText(next.label, host.lang),
      disabled: host.busy,
      onPress: () => host.run(next.call, next),
    },
  }
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
  const utilities = useHeroUtilities(model, host)
  const power = powerOf(model, host)
  const captionText = pickText(model.caption ?? model.title, lang)
  // "ON" already leads the caption: a state title that only says it again is dropped.
  const captionRepeatsPower =
    power !== undefined && captionText.toLowerCase() === power.value.toLowerCase()
  const dial = dialOf(model)
  const sceneRows = model.rows.filter((r) => r.placement === 'scene' && !gated.has(r.id))
  const hasSceneControls = sceneRows.some((r) => r.controls.some(isSceneControl))
  const timed = model.timedRun
  const countdown =
    timed !== null && timed.activeUntil !== null && model.scene.id !== 'pet-fountain'
  const tonedCentre = dial !== null || countdown
  return (
    <HeroCardA
      title={model.name}
      chips={<Chips model={model} lang={lang} />}
      scene={
        <HeroScene
          {...scene}
          {...(dial?.kind === 'speed' || captionRepeatsPower ? {} : { caption: captionText })}
          {...(power === undefined ? {} : { power })}
          {...(hasSceneControls
            ? { controls: <SceneControls rows={sceneRows} host={host} /> }
            : {})}
          toneCentre={tonedCentre}
          leftTiles={tilesOf(model.sideTiles.left, lang)}
          rightTiles={tilesOf(model.sideTiles.right, lang)}
        >
          {model.background.kind === 'artwork' ? (
            <img
              src={model.background.url}
              alt=""
              className="size-24 rounded-lg border border-border object-cover"
            />
          ) : dial !== null ? (
            <DialCentre dial={dial} host={host} />
          ) : countdown && timed !== null ? (
            <CountdownCentre slot={timed} host={host} actionable={!gated.has('timed-run')} />
          ) : SCENES_WITH_ART.has(scene.scene) ? undefined : (
            <span className="text-foreground [&>svg]:h-8 [&>svg]:w-8">
              <IconGlyph name={model.look.icon} />
            </span>
          )}
        </HeroScene>
      }
      rows={
        <>
          {model.rows
            .filter(
              (row) =>
                !gated.has(row.id) &&
                !(dial?.kind === 'setpoint' && row.id === 'setpoint') &&
                !(countdown && row.id === 'run-for'),
            )
            .map((row) => withoutSceneControls(withoutDial(row, dial)))
            .filter(
              (row) =>
                row.controls.length > 0 ||
                row.status !== null ||
                row.progress != null ||
                (row.pills?.length ?? 0) > 0,
            )
            .map((row, i, shown) => {
              const group = row.group === undefined ? null : pickText(row.group, lang)
              const previous = shown[i - 1]
              const same = previous?.group !== undefined && pickText(previous.group, lang) === group
              return (
                <Fragment key={`${row.id}-${i}`}>
                  {group === null || same ? null : <GroupHeader text={group} />}
                  <ModelRow row={row} host={host} tone={tone} />
                </Fragment>
              )
            })}
        </>
      }
      footAction={showRemote && remote !== undefined ? remote : undefined}
      utility={utilities.length > 0 ? <HeroUtilityGrid items={utilities} /> : undefined}
    />
  )
}
