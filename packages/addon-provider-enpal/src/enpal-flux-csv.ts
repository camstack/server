import { normalizeEnpalUnit } from './enpal-units.js'
import type { EnpalReading } from './enpal-snapshot.js'

/** A real data point key is dotted and starts with a letter; `measureId` and friends are not. */
const KEY_SHAPE = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z0-9-]+)+$/

/** Split one CSV line, honouring double-quoted cells (`""` is a quote). */
function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') {
        quoted = false
      } else {
        cell += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      cells.push(cell)
      cell = ''
    } else {
      cell += ch
    }
  }
  cells.push(cell)
  return cells
}

interface Columns {
  readonly value: number
  readonly field: number
  readonly measurement: number
  readonly unit: number
}

function columnsOf(header: readonly string[]): Columns | null {
  const value = header.indexOf('_value')
  const field = header.indexOf('_field')
  const measurement = header.indexOf('_measurement')
  if (value < 0 || field < 0 || measurement < 0) return null
  return { value, field, measurement, unit: header.indexOf('unit') }
}

/**
 * Parse an annotated Flux CSV answer (`#group`/`#datatype`/`#default` lines, blank lines
 * between result tables, a repeated header per table) into readings. Tolerant by design:
 * a malformed or empty body yields `[]`, a non-numeric value or a non-data key is skipped.
 */
export function parseFluxCsv(body: string): EnpalReading[] {
  const readings: EnpalReading[] = []
  let columns: Columns | null = null
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line.trim().length === 0 || line.startsWith('#')) continue
    const cells = splitCsvLine(line)
    const header = columnsOf(cells)
    if (header !== null) {
      columns = header
      continue
    }
    if (columns === null) continue
    const key = cells[columns.field]
    const rawValue = cells[columns.value]
    if (key === undefined || rawValue === undefined || !KEY_SHAPE.test(key)) continue
    const value = Number(rawValue)
    if (rawValue.trim().length === 0 || !Number.isFinite(value)) continue
    readings.push({
      key,
      value,
      unit: normalizeEnpalUnit(columns.unit >= 0 ? cells[columns.unit] : undefined),
      measurement: cells[columns.measurement] || undefined,
    })
  }
  return readings
}
