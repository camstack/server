import type { HeroMeasurement, HeroMeasurementQuantity, HeroTone } from '@dominevo/types'

interface ReadingInput {
  /** The value as drawn ("—" = not reported). */
  readonly value: string
  /** The base-unit number; absent = no number (a contact, a word, or no data). */
  readonly number?: number
  readonly unit?: string
  readonly tone?: HeroTone
  readonly level?: number
  readonly since?: number | null
}

/** A measurement as the model sends it, spelled out (the pie's fixtures and specs). */
export function readingOf(quantity: HeroMeasurementQuantity, input: ReadingInput): HeroMeasurement {
  return {
    quantity,
    reading:
      input.number === undefined
        ? null
        : {
            value: input.number,
            quantity: quantity === 'illuminance' ? 'illuminance' : 'temperature',
          },
    icon: null,
    value: { en: input.value, it: input.value },
    unit: input.unit ?? null,
    band: null,
    level: input.level ?? null,
    word: { en: input.value, it: input.value },
    tone: input.tone ?? 'muted',
    since: input.since === undefined ? null : input.since,
    sinceKind: 'updated',
    historyKey: null,
  }
}
