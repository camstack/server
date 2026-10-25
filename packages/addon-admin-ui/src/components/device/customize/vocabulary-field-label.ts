/**
 * The operator-facing name of a capability and of a source field (D920).
 * A path with no vocabulary row and no clock phrase keeps the path, so an
 * unnamed leaf is still identifiable.
 */
import { CAP_VOCABULARY_BY_NAME } from '@camstack/types'

interface L10nPair {
  readonly en: string
  readonly it: string
}

const CLOCK_FIELD_LABELS: Readonly<Record<string, L10nPair>> = {
  lastChangedAt: { en: 'Last change', it: 'Ultima variazione' },
  lastFetchedAt: { en: 'Last update', it: 'Ultimo aggiornamento' },
  lastDetectedAt: { en: 'Last detection', it: 'Ultimo rilevamento' },
  lastPressedAt: { en: 'Last press', it: 'Ultima pressione' },
  pressCountSinceStart: { en: 'Press count', it: 'Conteggio pressioni' },
  since: { en: 'Since', it: 'Da' },
}

function pick(pair: L10nPair, language: string): string {
  return language.startsWith('it') ? pair.it : pair.en
}

function displayUnit(row: object): string | undefined {
  if (!('unit' in row)) return undefined
  const unit: unknown = row.unit
  return typeof unit === 'string' && unit.length > 0 ? unit : undefined
}

export function vocabularyCapTitle(cap: string, language: string): string {
  const noun = CAP_VOCABULARY_BY_NAME[cap]?.noun
  if (noun === undefined) {
    return cap
      .split('-')
      .filter((part) => part.length > 0)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  }
  return pick(noun, language)
}

export function vocabularyFieldLabel(cap: string, fieldPath: string, language: string): string {
  const entry = CAP_VOCABULARY_BY_NAME[cap]
  const row = entry?.state?.find((state) => state.field === fieldPath)
  if (row !== undefined) {
    const label = pick(row.label, language)
    const unit = displayUnit(row)
    return unit === undefined ? label : `${label} (${unit})`
  }
  const clock = CLOCK_FIELD_LABELS[fieldPath]
  if (clock !== undefined) return pick(clock, language)
  return fieldPath
}
