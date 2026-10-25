/**
 * ONE dictionary of human labels for event kinds (detection macros/subs,
 * sensors, audio macros, …) — the same vocabulary the viewer filters and the
 * notification centre speak (R7).
 *
 * Wire ids stay raw (`cat`, `animal`, `audio-dog`). What a human reads is a
 * label, and a surface that translates on its own is a surface that disagrees
 * with the next one. Admin UI, viewer and NC resolve through {@link eventKindLabel}.
 *
 * Keys match {@link EVENT_TAXONOMY}. An OPEN kind (a custom model class) falls
 * back to the raw word — never an exception, never an empty chip.
 */

/** A label in every locale both editors and the hub ship. */
export interface EventKindLabel {
  readonly en: string
  readonly it: string
}

/** The locales a {@link EventKindLabel} carries. */
export type EventKindLabelLocale = keyof EventKindLabel

/**
 * Every kind the dictionary answers for. Order is stable; the set is held to
 * {@link EVENT_TAXONOMY} by the spec.
 */
export const EVENT_KIND_LABEL_KEYS = [
  // macros
  'motion',
  'audio',
  'person',
  'vehicle',
  'animal',
  'package',
  'sensor',
  'control',
  // detection subs (vehicle / animal — reverse of COCO_TO_MACRO)
  'car',
  'truck',
  'bus',
  'motorcycle',
  'bicycle',
  'airplane',
  'boat',
  'train',
  'bird',
  'cat',
  'dog',
  'horse',
  'sheep',
  'cow',
  'elephant',
  'bear',
  'zebra',
  'giraffe',
  // package event types
  'package-delivered',
  'package-picked-up',
  // sensor subs
  'contact',
  'motion-sensor',
  'smoke',
  'flood',
  'gas',
  'carbon-monoxide',
  'vibration',
  'tamper',
  'presence',
  'enum-sensor',
  'device-event',
  // control subs
  'lock',
  'cover',
  'switch',
  'siren',
  'button',
  'doorbell',
  // audio subs (`audio-<id>` — AUDIO_MACRO_LABELS)
  'audio-speech',
  'audio-scream',
  'audio-crying',
  'audio-laughter',
  'audio-music',
  'audio-dog',
  'audio-cat',
  'audio-bird',
  'audio-animal',
  'audio-alarm',
  'audio-doorbell',
  'audio-glass_breaking',
  'audio-gunshot',
  'audio-vehicle',
  'audio-siren',
  'audio-fire',
  'audio-water',
  'audio-wind',
  'audio-door',
  'audio-footsteps',
  'audio-crowd',
  'audio-telephone',
  'audio-engine',
  'audio-tools',
  'audio-silence',
] as const

/** A key {@link EVENT_KIND_LABELS} answers for. */
export type EventKindLabelKey = (typeof EVENT_KIND_LABEL_KEYS)[number]

export const EVENT_KIND_LABELS: Readonly<Record<EventKindLabelKey, EventKindLabel>> = {
  motion: { en: 'Motion', it: 'Movimento' },
  audio: { en: 'Audio', it: 'Audio' },
  person: { en: 'Person', it: 'Persona' },
  vehicle: { en: 'Vehicle', it: 'Veicolo' },
  animal: { en: 'Animal', it: 'Animale' },
  package: { en: 'Package', it: 'Pacco' },
  sensor: { en: 'Sensor', it: 'Sensore' },
  control: { en: 'Control', it: 'Controllo' },
  car: { en: 'Car', it: 'Auto' },
  truck: { en: 'Truck', it: 'Camion' },
  bus: { en: 'Bus', it: 'Autobus' },
  motorcycle: { en: 'Motorcycle', it: 'Motocicletta' },
  bicycle: { en: 'Bicycle', it: 'Bicicletta' },
  airplane: { en: 'Airplane', it: 'Aereo' },
  boat: { en: 'Boat', it: 'Barca' },
  train: { en: 'Train', it: 'Treno' },
  bird: { en: 'Bird', it: 'Uccello' },
  cat: { en: 'Cat', it: 'Gatto' },
  dog: { en: 'Dog', it: 'Cane' },
  horse: { en: 'Horse', it: 'Cavallo' },
  sheep: { en: 'Sheep', it: 'Pecora' },
  cow: { en: 'Cow', it: 'Mucca' },
  elephant: { en: 'Elephant', it: 'Elefante' },
  bear: { en: 'Bear', it: 'Orso' },
  zebra: { en: 'Zebra', it: 'Zebra' },
  giraffe: { en: 'Giraffe', it: 'Giraffa' },
  'package-delivered': { en: 'Package delivered', it: 'Pacco consegnato' },
  'package-picked-up': { en: 'Package picked up', it: 'Pacco ritirato' },
  contact: { en: 'Contact', it: 'Contatto' },
  'motion-sensor': { en: 'Motion sensor', it: 'Sensore movimento' },
  smoke: { en: 'Smoke', it: 'Fumo' },
  flood: { en: 'Water leak', it: 'Allagamento' },
  gas: { en: 'Gas', it: 'Gas' },
  'carbon-monoxide': { en: 'Carbon monoxide', it: 'Monossido di carbonio' },
  vibration: { en: 'Vibration', it: 'Vibrazione' },
  tamper: { en: 'Tamper', it: 'Manomissione' },
  presence: { en: 'Presence', it: 'Presenza' },
  'enum-sensor': { en: 'Sensor state', it: 'Stato sensore' },
  'device-event': { en: 'Device event', it: 'Evento dispositivo' },
  lock: { en: 'Lock', it: 'Serratura' },
  cover: { en: 'Cover', it: 'Tapparella' },
  switch: { en: 'Switch', it: 'Interruttore' },
  siren: { en: 'Siren', it: 'Sirena' },
  button: { en: 'Button', it: 'Pulsante' },
  doorbell: { en: 'Doorbell', it: 'Campanello' },
  // EN matches AUDIO_MACRO_LABELS.name (and therefore EVENT_TAXONOMY.label).
  'audio-speech': { en: 'Speech', it: 'Voce' },
  'audio-scream': { en: 'Scream / Shout', it: 'Urlo' },
  'audio-crying': { en: 'Crying / Baby', it: 'Pianto / Neonato' },
  'audio-laughter': { en: 'Laughter', it: 'Risata' },
  'audio-music': { en: 'Music', it: 'Musica' },
  'audio-dog': { en: 'Dog', it: 'Cane' },
  'audio-cat': { en: 'Cat', it: 'Gatto' },
  'audio-bird': { en: 'Bird', it: 'Uccello' },
  'audio-animal': { en: 'Animal (other)', it: 'Animale (altro)' },
  'audio-alarm': { en: 'Alarm / Siren', it: 'Allarme' },
  'audio-doorbell': { en: 'Doorbell / Knock', it: 'Campanello' },
  'audio-glass_breaking': { en: 'Glass Breaking', it: 'Vetro rotto' },
  'audio-gunshot': { en: 'Gunshot / Explosion', it: 'Sparo / Esplosione' },
  'audio-vehicle': { en: 'Vehicle', it: 'Veicolo' },
  'audio-siren': { en: 'Emergency Siren', it: 'Sirena' },
  'audio-fire': { en: 'Fire / Smoke', it: 'Fuoco / Fumo' },
  'audio-water': { en: 'Water', it: 'Acqua' },
  'audio-wind': { en: 'Wind / Weather', it: 'Vento / Maltempo' },
  'audio-door': { en: 'Door', it: 'Porta' },
  'audio-footsteps': { en: 'Footsteps', it: 'Passi' },
  'audio-crowd': { en: 'Crowd / Chatter', it: 'Folla / Chiacchiericcio' },
  'audio-telephone': { en: 'Telephone', it: 'Telefono' },
  'audio-engine': { en: 'Engine / Motor', it: 'Motore' },
  'audio-tools': { en: 'Tools / Construction', it: 'Utensili / Lavori' },
  'audio-silence': { en: 'Silence', it: 'Silenzio' },
}

const KEY_SET: ReadonlySet<string> = new Set(EVENT_KIND_LABEL_KEYS)

/** Is `key` one the dictionary answers for? An own key only — never `toString`. */
export function isEventKindLabelKey(key: string): key is EventKindLabelKey {
  return KEY_SET.has(key)
}

/**
 * The human label of an event kind in `locale`, or the word itself when the
 * dictionary does not know it. Never throws. Case/whitespace normalised so a
 * pipeline that emitted `Cat` still finds `cat`.
 */
export function eventKindLabel(kind: string, locale: EventKindLabelLocale): string {
  const key = kind.trim().toLowerCase()
  return isEventKindLabelKey(key) ? EVENT_KIND_LABELS[key][locale] : kind
}
