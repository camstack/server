/**
 * The vocabulary of a device hero's LOOK (D1023): the states a hero can be in,
 * and the tokens a renderer draws a state with. Pure data — no React, no I/O.
 *
 * A state is drawn by an icon, a tone, a background and ONE animation. The
 * tokens are closed unions so each client types its renderer map over them
 * (`Record<HeroBackgroundToken, …>`): a token without a renderer is a build
 * error there, a state without a look is a build error in `hero-look.ts`.
 */
import { z } from 'zod'
import { IconKeySchema } from '../icon-catalog.js'

/** What a hero tells at a glance. `unknown` is its own state: never drawn as `off` (D315/D393). */
export const HERO_STATES = [
  'on',
  'off',
  'running',
  'idle',
  'standby',
  'alert',
  'offline',
  'unknown',
] as const
export type HeroState = (typeof HERO_STATES)[number]

export const HERO_TONES = ['success', 'warning', 'danger', 'primary', 'info', 'muted'] as const
export type HeroTone = (typeof HERO_TONES)[number]

export const HERO_ANIMATIONS = [
  'none',
  'pulse',
  'spin',
  'glow',
  'halo',
  'wave',
  'rise',
  'fall',
  'tumble',
  'equalizer',
  'blink',
  'breathe',
] as const
export type HeroAnimation = (typeof HERO_ANIMATIONS)[number]

export const HERO_BACKGROUNDS = [
  'plain',
  'heat-rise',
  'cool-fall',
  'glow',
  'water',
  'drum',
  'sky',
  'mist',
  'alert-wash',
] as const
export type HeroBackgroundToken = (typeof HERO_BACKGROUNDS)[number]

export const HeroStateSchema = z.enum(HERO_STATES)
export const HeroToneSchema = z.enum(HERO_TONES)
export const HeroAnimationSchema = z.enum(HERO_ANIMATIONS)
export const HeroBackgroundTokenSchema = z.enum(HERO_BACKGROUNDS)

/** How one state is drawn: the main icon, its tone, the backdrop and the ONE animation. */
export const StateLookSchema = z.object({
  icon: IconKeySchema,
  tone: HeroToneSchema,
  background: HeroBackgroundTokenSchema,
  animation: HeroAnimationSchema,
})
export type StateLook = z.infer<typeof StateLookSchema>

/** Exhaustive over {@link HeroState}: a new state fails the build in every look. */
export type HeroLook = Readonly<Record<HeroState, StateLook>>
