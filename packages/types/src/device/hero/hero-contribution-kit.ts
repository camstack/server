/**
 * The pieces every cap contribution is written with (D1023): the contribution
 * shape, the boundary parse, and the builders of an action, a reading and a
 * fact. Shared by `hero-contributions.ts` and the per-theme contribution files,
 * so a contribution reads the same wherever it lives.
 */
import type { z } from 'zod'
import type { VocabIcon } from './cap-vocabulary-icon.js'
import type { HeroContext, HeroFragment, StateReading } from './hero-fragment.js'
import type {
  HeroAction,
  HeroArgs,
  HeroConfirm,
  HeroControl,
  HeroFact,
  HeroRow,
} from './hero-model.js'
import type { HeroState } from './hero-state.js'
import { heroText, type HeroText } from './hero-text.js'

export interface HeroContribution {
  readonly cap: string
  readonly contribute: (slice: unknown, ctx: HeroContext) => HeroFragment
}

/** Parses the raw slice with the cap's own schema; `undefined` when it does not parse. */
export function contribution<S>(
  cap: string,
  schema: z.ZodType<S>,
  build: (slice: S | undefined, ctx: HeroContext) => HeroFragment,
): HeroContribution {
  return {
    cap,
    contribute: (raw, ctx) => {
      const parsed = schema.safeParse(raw)
      return build(parsed.success ? parsed.data : undefined, ctx)
    },
  }
}

export function action(
  id: string,
  label: HeroText,
  icon: VocabIcon,
  cap: string,
  method: string,
  args: HeroArgs = {},
  emphasis: 'primary' | 'normal' = 'normal',
  confirm: HeroConfirm | null = null,
): HeroAction {
  return { id, label, icon, call: { cap, method, args }, emphasis, confirm }
}

export const asAction = (a: HeroAction): HeroControl => ({
  kind: 'action',
  action: a,
})

export function reading(
  source: StateReading['source'],
  state: HeroState,
  assumed = false,
  title?: HeroText,
): StateReading {
  return title === undefined ? { source, state, assumed } : { source, state, assumed, title }
}

export function fact(
  id: HeroFact['id'],
  icon: HeroFact['icon'],
  text: HeroText,
  tone: HeroFact['tone'] = 'muted',
): HeroFact {
  return { id, icon, text, tone }
}

export function row(
  id: HeroRow['id'],
  icon: HeroRow['icon'],
  status: HeroText | null,
  controls: readonly HeroControl[] = [],
): HeroRow {
  return { id, icon, status, controls: [...controls] }
}

/** "5 min" / "3 h" / "2 d" since `at`; `null` when the moment is unknown (0) or in the future. */
export function elapsedText(at: number, now: number): HeroText | null {
  if (at <= 0 || at > now) return null
  const min = Math.floor((now - at) / 60_000)
  if (min < 1) return heroText('just now', 'adesso')
  if (min < 60) return heroText(`${min} min ago`, `${min} min fa`)
  const h = Math.floor(min / 60)
  if (h < 48) return heroText(`${h} h ago`, `${h} h fa`)
  const d = Math.floor(h / 24)
  return heroText(`${d} d ago`, `${d} g fa`)
}

/** Joins words with " · ", skipping what is not there. */
export function joinText(parts: readonly (HeroText | null)[]): HeroText | null {
  const present = parts.filter((p): p is HeroText => p !== null)
  if (present.length === 0) return null
  return heroText(present.map((p) => p.en).join(' · '), present.map((p) => p.it).join(' · '))
}
