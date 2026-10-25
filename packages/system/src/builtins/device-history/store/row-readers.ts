/**
 * Typed reads of a door row. The door hands back `Record<string, unknown>`;
 * a column that is not what the schema promised is a corrupt or foreign row,
 * and a store that guessed (`Number(x ?? 0)`) would turn "unknown" into zero
 * (D393). So these throw, naming the column.
 */
export type RowData = Readonly<Record<string, unknown>>

export function readNumber(data: RowData, column: string): number {
  const v = data[column]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  throw new Error(`history row: column "${column}" is not a number (${typeof v})`)
}

export function readNumberOrNull(data: RowData, column: string): number | null {
  const v = data[column]
  if (v === null || v === undefined) return null
  if (typeof v === 'number' && Number.isFinite(v)) return v
  throw new Error(`history row: column "${column}" is not a number or null (${typeof v})`)
}

export function readText(data: RowData, column: string): string {
  const v = data[column]
  if (typeof v === 'string') return v
  throw new Error(`history row: column "${column}" is not a string (${typeof v})`)
}

export function readTextOrNull(data: RowData, column: string): string | null {
  const v = data[column]
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v
  throw new Error(`history row: column "${column}" is not a string or null (${typeof v})`)
}
