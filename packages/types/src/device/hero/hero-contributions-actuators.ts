/**
 * What the moving and dimming caps add to a hero (D1023): a light's brightness
 * and colour, a cover, a valve and a humidifier. Moving a cover or a valve is
 * an ACTION the person presses, never a toggle that fires by itself; a slice
 * that does not parse reads `unknown`, never closed or off (D315/D393).
 */
import { BrightnessStatusSchema } from '../../capabilities/brightness.cap.js'
import { ColorStatusSchema } from '../../capabilities/color.cap.js'
import { CoverStatusSchema } from '../../capabilities/cover.cap.js'
import { HumidifierStatusSchema } from '../../capabilities/humidifier.cap.js'
import { ValveStatusSchema } from '../../capabilities/valve.cap.js'
import { DeviceFeature } from '../device-type.js'
import {
  action,
  asAction,
  contribution,
  fact,
  joinText,
  reading,
  row,
  type HeroContribution,
} from './hero-contribution-kit.js'
import type { HeroContext, HeroFragment } from './hero-fragment.js'
import type { HeroAction, HeroControl } from './hero-model.js'
import type { HeroSceneMode } from './hero-scene.js'
import type { HeroState } from './hero-state.js'
import { heroText, type HeroText } from './hero-text.js'

const has = (ctx: HeroContext, f: DeviceFeature): boolean => ctx.features.includes(f)
const pct = (n: number): HeroText => heroText(`${Math.round(n)}%`, `${Math.round(n)}%`)

// ── brightness ─────────────────────────────────────────────────────────────

const brightnessContribution = contribution('brightness', BrightnessStatusSchema, (slice) => {
  const level = slice?.level ?? null
  return {
    // The switch says on / off when the light has one; a dimmer alone reads from its level.
    ...(level === null ? {} : { reading: reading('brightness', level > 0 ? 'on' : 'off') }),
    ...(level === null
      ? {}
      : {
          facts: [fact('level', 'sun-dim', pct(level), level > 0 ? 'primary' : 'muted')],
          scene: { level: level / 100 },
          tiles: { left: [{ label: heroText('Brightness', 'Luminosità'), value: pct(level) }] },
        }),
    rows: [
      row(
        'brightness',
        'sun-dim',
        level === null
          ? null
          : heroText(`Brightness ${Math.round(level)}%`, `Luminosità ${Math.round(level)}%`),
        [
          {
            kind: 'slider',
            id: 'brightness.level',
            label: heroText('Brightness', 'Luminosità'),
            value: level,
            min: 0,
            max: 100,
            step: 1,
            unit: '%',
            call: { cap: 'brightness', method: 'setBrightness', args: {} },
            valueArg: 'level',
          },
        ],
      ),
    ],
  }
})

// ── color ──────────────────────────────────────────────────────────────────

/**
 * Preset colours as actions: `setColor` takes a nested `{ mode, … }` argument, which a
 * hero action carries (D1023). Only the modes the bulb declares are offered, each a
 * valid `setColor` input; a bulb that declares none is shown, not set.
 */
const WHITE_PRESETS = [
  { id: 'color.warm', en: 'Warm white', it: 'Bianco caldo', icon: 'sun', mired: 370 },
  { id: 'color.neutral', en: 'Neutral white', it: 'Bianco neutro', icon: 'lightbulb', mired: 250 },
  { id: 'color.cool', en: 'Cool white', it: 'Bianco freddo', icon: 'snowflake', mired: 154 },
] as const

const HUE_PRESETS = [
  { id: 'color.red', en: 'Red', it: 'Rosso', hue: 0 },
  { id: 'color.amber', en: 'Amber', it: 'Ambra', hue: 40 },
  { id: 'color.green', en: 'Green', it: 'Verde', hue: 120 },
  { id: 'color.cyan', en: 'Cyan', it: 'Ciano', hue: 180 },
  { id: 'color.blue', en: 'Blue', it: 'Blu', hue: 240 },
  { id: 'color.purple', en: 'Purple', it: 'Viola', hue: 280 },
] as const

function colorControls(
  ctx: HeroContext,
  current: { readonly s: number; readonly v: number } | null,
): HeroControl[] {
  const controls: HeroControl[] = []
  if (has(ctx, DeviceFeature.LightColorMired)) {
    for (const p of WHITE_PRESETS) {
      controls.push(
        asAction(
          action(p.id, heroText(p.en, p.it), p.icon, 'color', 'setColor', {
            color: { mode: 'mired', colorTemperature: p.mired },
          }),
        ),
      )
    }
  }
  if (has(ctx, DeviceFeature.LightColorHsv)) {
    const s = current?.s ?? 100
    const v = current?.v ?? 100
    for (const p of HUE_PRESETS) {
      controls.push(
        asAction(
          action(p.id, heroText(p.en, p.it), 'palette', 'color', 'setColor', {
            color: { mode: 'hsv', hsv: { h: p.hue, s, v } },
          }),
        ),
      )
    }
  }
  return controls
}

const colorContribution = contribution('color', ColorStatusSchema, (slice, ctx) => {
  let words: HeroText | null = null
  if (slice !== undefined) {
    if (
      slice.mode === 'mired' &&
      slice.colorTemperature !== undefined &&
      slice.colorTemperature > 0
    ) {
      const kelvin = Math.round(1_000_000 / slice.colorTemperature)
      words = heroText(`${kelvin} K`, `${kelvin} K`)
    } else if (slice.mode === 'rgb' && slice.rgb !== undefined) {
      const c = `RGB ${slice.rgb.r}, ${slice.rgb.g}, ${slice.rgb.b}`
      words = heroText(c, c)
    } else if (slice.mode === 'hsv' && slice.hsv !== undefined) {
      words = heroText(`Hue ${Math.round(slice.hsv.h)}°`, `Tonalità ${Math.round(slice.hsv.h)}°`)
    }
  }
  return {
    ...(words === null ? {} : { facts: [fact('reading', 'palette', words)] }),
    rows: [
      row(
        'color',
        'palette',
        words,
        colorControls(ctx, slice?.mode === 'hsv' && slice.hsv !== undefined ? slice.hsv : null),
      ),
    ],
  }
})

// ── cover & valve (the same lifecycle) ─────────────────────────────────────

type TravelState = 'open' | 'opening' | 'closing' | 'closed' | 'stopped'

interface TravelWords {
  readonly state: HeroState
  readonly title: HeroText
  readonly mode: HeroSceneMode | null
}

function travelWords(state: TravelState, position: number | null): TravelWords {
  const partial = position !== null && position > 0 && position < 100
  const at = position === null ? null : Math.round(position)
  switch (state) {
    case 'open':
      return {
        state: 'on',
        title: partial ? heroText(`${at}% open`, `Aperto al ${at}%`) : heroText('Open', 'Aperto'),
        mode: 'open',
      }
    case 'closed':
      return {
        state: 'off',
        title: heroText('Closed', 'Chiuso'),
        mode: 'closed',
      }
    case 'opening':
      return {
        state: 'running',
        title: heroText('Opening', 'In apertura'),
        mode: 'open',
      }
    case 'closing':
      return {
        state: 'running',
        title: heroText('Closing', 'In chiusura'),
        mode: 'closed',
      }
    case 'stopped':
      return {
        state: 'idle',
        title:
          at === null
            ? heroText('Stopped', 'Fermo')
            : heroText(`Stopped at ${at}%`, `Fermo al ${at}%`),
        mode: position === null ? null : position > 0 ? 'open' : 'closed',
      }
  }
}

interface TravelSurface {
  readonly cap: 'cover' | 'valve'
  readonly rowId: 'cover' | 'valve'
  readonly source: 'cover' | 'valve'
  readonly stoppable: boolean
  readonly positionable: boolean
}

/** Open / stop / close are actions; the one that makes sense next carries the emphasis. */
function travelActions(
  s: TravelSurface,
  state: TravelState | undefined,
  moving: boolean,
): HeroAction[] {
  const emphasis = (wanted: boolean): 'primary' | 'normal' => (wanted ? 'primary' : 'normal')
  const open = action(
    `${s.cap}.open`,
    heroText('Open', 'Apri'),
    'arrow-up',
    s.cap,
    'open',
    {},
    emphasis(state === 'closed' || state === 'closing'),
  )
  const stop = action(
    `${s.cap}.stop`,
    heroText('Stop', 'Ferma'),
    'square',
    s.cap,
    'stop',
    {},
    emphasis(moving),
  )
  const close = action(
    `${s.cap}.close`,
    heroText('Close', 'Chiudi'),
    'arrow-down',
    s.cap,
    'close',
    {},
    emphasis(state === 'open' || state === 'opening'),
  )
  return s.stoppable || moving ? [open, stop, close] : [open, close]
}

function positionSlider(s: TravelSurface, position: number | null): HeroControl {
  return {
    kind: 'slider',
    id: `${s.cap}.position`,
    label: heroText('Position', 'Posizione'),
    value: position,
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    call: { cap: s.cap, method: 'setPosition', args: {} },
    valueArg: 'position',
  }
}

function travelFragment(
  s: TravelSurface,
  state: TravelState | undefined,
  position: number | null,
  tilt: number | null,
  ctx: HeroContext,
): HeroFragment {
  if (state === undefined) {
    return {
      reading: reading(s.source, 'unknown'),
      rows: [row(s.rowId, 'arrow-up', null, travelActions(s, undefined, false).map(asAction))],
    }
  }
  const words = travelWords(state, position)
  const moving = state === 'opening' || state === 'closing'
  const controls: HeroControl[] = travelActions(s, state, moving).map(asAction)
  if (position !== null || s.positionable) controls.push(positionSlider(s, position))
  if (s.cap === 'cover' && (tilt !== null || has(ctx, DeviceFeature.CoverTilt))) {
    controls.push({
      kind: 'slider',
      id: 'cover.tilt',
      label: heroText('Tilt', 'Inclinazione'),
      value: tilt,
      min: 0,
      max: 100,
      step: 1,
      unit: '%',
      call: { cap: 'cover', method: 'setTiltPosition', args: {} },
      valueArg: 'tiltPosition',
    })
  }
  return {
    reading: reading(s.source, words.state, false, words.title),
    ...(position === null ? {} : { facts: [fact('level', 'arrow-up-down', pct(position))] }),
    ...(position === null
      ? {}
      : { tiles: { left: [{ label: heroText('Opening', 'Apertura'), value: pct(position) }] } }),
    scene: {
      ...(words.mode === null ? {} : { mode: words.mode }),
      ...(position === null ? {} : { level: position / 100 }),
    },
    rows: [
      row(
        s.rowId,
        'arrow-up-down',
        joinText([words.title, position !== null && state !== 'open' ? pct(position) : null]),
        controls,
      ),
    ],
  }
}

const coverContribution = contribution('cover', CoverStatusSchema, (slice, ctx) =>
  travelFragment(
    {
      cap: 'cover',
      rowId: 'cover',
      source: 'cover',
      stoppable: has(ctx, DeviceFeature.CoverStoppable),
      positionable: has(ctx, DeviceFeature.CoverPositionable),
    },
    slice?.state,
    slice?.position ?? null,
    slice?.tiltPosition ?? null,
    ctx,
  ),
)

const valveContribution = contribution('valve', ValveStatusSchema, (slice, ctx) =>
  travelFragment(
    {
      cap: 'valve',
      rowId: 'valve',
      source: 'valve',
      stoppable: false,
      positionable: has(ctx, DeviceFeature.ValvePositionable),
    },
    slice?.state,
    slice?.position ?? null,
    null,
    ctx,
  ),
)

// ── humidifier ─────────────────────────────────────────────────────────────

const humidifierContribution = contribution('humidifier', HumidifierStatusSchema, (slice) => {
  if (slice === undefined) return { reading: reading('humidifier', 'unknown') }
  const action_ = slice.action
  let state: HeroState = 'off'
  let title = heroText('Off', 'Spento')
  if (slice.on) {
    if (action_ === 'humidifying') {
      state = 'running'
      title = heroText('Humidifying', 'Umidifica')
    } else if (action_ === 'drying') {
      state = 'running'
      title = heroText('Drying', 'Deumidifica')
    } else if (action_ === 'idle') {
      state = 'idle'
      title = heroText('Idle', 'In attesa')
    } else {
      state = 'on'
      title = heroText('On', 'Acceso')
    }
  }
  const controls: HeroControl[] = [
    {
      kind: 'toggle',
      id: 'humidifier.power',
      label: heroText('Power', 'Accensione'),
      on: slice.on,
      turnOn: action(
        'humidifier.on',
        heroText('Turn on', 'Accendi'),
        'power',
        'humidifier',
        'setOn',
        {
          on: true,
        },
      ),
      turnOff: action(
        'humidifier.off',
        heroText('Turn off', 'Spegni'),
        'power-off',
        'humidifier',
        'setOn',
        { on: false },
      ),
    },
  ]
  if (slice.targetHumidity !== null) {
    controls.push({
      kind: 'slider',
      id: 'humidifier.target',
      label: heroText('Target', 'Obiettivo'),
      value: slice.targetHumidity,
      min: slice.minHumidity ?? 0,
      max: slice.maxHumidity ?? 100,
      step: 1,
      unit: '%',
      call: { cap: 'humidifier', method: 'setTargetHumidity', args: {} },
      valueArg: 'humidity',
    })
  }
  if (slice.availableModes.length > 0) {
    controls.push({
      kind: 'picker',
      id: 'humidifier.mode',
      label: heroText('Mode', 'Modalità'),
      current: slice.mode,
      options: [...slice.availableModes],
      call: { cap: 'humidifier', method: 'setMode', args: {} },
      valueArg: 'mode',
    })
  }
  const now = slice.currentHumidity
  return {
    reading: reading('humidifier', state, false, title),
    ...(now === null ? {} : { facts: [fact('level', 'droplets', pct(now), 'info')] }),
    ...(slice.targetHumidity === null
      ? {}
      : {
          tiles: {
            right: [
              {
                label: heroText('Target', 'Obiettivo'),
                value: pct(slice.targetHumidity),
              },
            ],
          },
        }),
    ...(now === null ? {} : { scene: { level: now / 100 } }),
    rows: [
      row(
        'humidifier',
        'droplets',
        joinText([title, slice.mode === null ? null : heroText(slice.mode, slice.mode)]),
        controls,
      ),
    ],
  }
})

export const ACTUATORS_FAMILY_CONTRIBUTIONS: Readonly<Record<string, HeroContribution>> = {
  brightness: brightnessContribution,
  color: colorContribution,
  cover: coverContribution,
  valve: valveContribution,
  humidifier: humidifierContribution,
}
