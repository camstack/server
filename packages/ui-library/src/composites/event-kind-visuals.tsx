/**
 * Event-kind VISUALS — the UI-side half of the unified taxonomy dictionary
 * (`@camstack/types` `EVENT_TAXONOMY` owns the serializable data:
 * color / iconId / labelKey; this owns `iconId → lucide component` and
 * `labelKey → t()`).
 *
 * Every UI that renders an event kind (timeline, events tree, chips,
 * detection canvas/tree) resolves its glyph + translated label here — no
 * per-component hardcoded icon or label.
 */
import { createElement, type JSX } from 'react'
import {
  Activity,
  AlertTriangle,
  Baby,
  BellRing,
  Bike,
  Bird,
  Bus,
  Car,
  Cat,
  CircleDot,
  Cog,
  Crosshair,
  Dog,
  DoorOpen,
  Droplet,
  Droplets,
  Flame,
  Footprints,
  Hammer,
  Laugh,
  Lock,
  Megaphone,
  MessageSquare,
  Music,
  Package,
  PawPrint,
  Phone,
  Plane,
  Radar,
  Radio,
  Sailboat,
  ShieldAlert,
  Siren,
  SlidersHorizontal,
  Tag,
  ToggleRight,
  TrainFront,
  Truck,
  User,
  UserCheck,
  Users,
  Vibrate,
  Volume2,
  VolumeX,
  Wind,
  type LucideIcon,
} from 'lucide-react'
import type { EventKindDescriptor } from '@camstack/types'
import type { TranslationFn } from './config-form-builder'

/**
 * `iconId` → lucide component. Built ONLY from statically-imported icons
 * (bundle-safe). Unknown ids resolve to the neutral `Tag` fallback.
 */
export const EVENT_KIND_ICONS: Readonly<Record<string, LucideIcon>> = {
  // Macros.
  motion: Activity,
  audio: Volume2,
  person: User,
  vehicle: Car,
  animal: PawPrint,
  package: Package,
  sensor: Radio,
  control: SlidersHorizontal,
  // Detection subs.
  car: Car,
  truck: Truck,
  bus: Bus,
  motorcycle: Bike,
  bicycle: Bike,
  airplane: Plane,
  boat: Sailboat,
  train: TrainFront,
  bird: Bird,
  cat: Cat,
  dog: Dog,
  horse: PawPrint,
  sheep: PawPrint,
  cow: PawPrint,
  elephant: PawPrint,
  bear: PawPrint,
  zebra: PawPrint,
  giraffe: PawPrint,
  // Sensor / control subs.
  door: DoorOpen,
  pir: Radar,
  smoke: Flame,
  water: Droplet,
  gas: Wind,
  vibration: Vibrate,
  tamper: ShieldAlert,
  presence: UserCheck,
  generic: Tag,
  lock: Lock,
  siren: Siren,
  switch: ToggleRight,
  doorbell: BellRing,
  button: CircleDot,
  // Audio subs — one glyph per audio macro class (`AUDIO_MACRO_LABELS`); the
  // generic `audio` macro + any unmapped id fall back to the `Volume2` glyph.
  'audio-speech': MessageSquare,
  'audio-scream': Megaphone,
  'audio-crying': Baby,
  'audio-laughter': Laugh,
  'audio-music': Music,
  'audio-dog': Dog,
  'audio-cat': Cat,
  'audio-bird': Bird,
  'audio-animal': PawPrint,
  'audio-alarm': BellRing,
  'audio-doorbell': BellRing,
  'audio-glass_breaking': AlertTriangle,
  'audio-gunshot': Crosshair,
  'audio-vehicle': Car,
  'audio-siren': Siren,
  'audio-fire': Flame,
  'audio-water': Droplets,
  'audio-wind': Wind,
  'audio-door': DoorOpen,
  'audio-footsteps': Footprints,
  'audio-crowd': Users,
  'audio-telephone': Phone,
  'audio-engine': Cog,
  'audio-tools': Hammer,
  'audio-silence': VolumeX,
}

/** Resolve an `iconId` to a lucide component (falls back to `Tag`). */
export function resolveEventKindIcon(iconId: string): LucideIcon {
  if (Object.hasOwn(EVENT_KIND_ICONS, iconId)) return EVENT_KIND_ICONS[iconId]!
  // Audio subs without a specific glyph fall back to the audio icon.
  if (iconId.startsWith('audio-')) return Volume2
  return Tag
}

/**
 * Translated label for an event kind — `t(labelKey)` when a translation
 * exists, else the English `label` fallback. Robust to a missing key: an
 * i18n backend that echoes the key unchanged (react-i18next default) is
 * treated as "no translation" and the fallback label is returned, so the UI
 * never renders a raw `eventKind.*` key.
 */
export function eventKindLabel(
  descriptor: Pick<EventKindDescriptor, 'labelKey' | 'label'>,
  t?: TranslationFn,
): string {
  if (t === undefined) return descriptor.label
  const translated = t(descriptor.labelKey)
  return translated === descriptor.labelKey || translated.length === 0
    ? descriptor.label
    : translated
}

export interface EventKindGlyphProps {
  readonly iconId: string
  readonly size?: number
  readonly color?: string
  readonly className?: string
}

/** Small convenience component: renders the lucide glyph for an `iconId`. */
export function EventKindGlyph({
  iconId,
  size = 16,
  color,
  className,
}: EventKindGlyphProps): JSX.Element {
  const Icon = resolveEventKindIcon(iconId)
  return createElement(Icon, { size, color, className })
}
