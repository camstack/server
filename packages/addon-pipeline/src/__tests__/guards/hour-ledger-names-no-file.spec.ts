import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { evaluateHourLedgerGuard, hourLedgerFailures } from './hour-ledger-names-no-file.guard.js'

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '../../..')

const LEDGER_OK = [
  'export const RECORDING_SEGMENT_HOURS_COLUMNS = [',
  "  { name: 'hourStart' },",
  "  { name: 'bytes' },",
  '] as const',
  'export interface SegmentHourRow {',
  '  readonly hourStart: number',
  '  readonly bytes: number',
  '}',
].join('\n')
const ROOTS_OK = [
  'export async function hydrateWindowFromStorage(dir: string) {',
  '  const names = await fs.readdir(dir)',
  '  return names',
  '}',
  '',
].join('\n')

describe('hour ledger names no file (D523)', () => {
  it('the checked-out recorder passes', () => {
    expect(evaluateHourLedgerGuard(PACKAGE_ROOT)).toEqual([])
  })

  it('a clean synthetic tree passes', () => {
    expect(hourLedgerFailures({ ledger: LEDGER_OK, roots: ROOTS_OK, sources: [] })).toEqual([])
  })

  it('refuses the column that caused the 2026-09-17 loss', () => {
    const ledger = LEDGER_OK.replace(
      "  { name: 'bytes' },",
      "  { name: 'bytes' },\n  { name: 'paths' },",
    )
    const out = hourLedgerFailures({ ledger, roots: ROOTS_OK, sources: [] })
    expect(out.some((f) => f.includes('`paths` column'))).toBe(true)
  })

  it('refuses a row field and a reader of the path list', () => {
    const ledger = LEDGER_OK.replace(
      '  readonly bytes: number',
      '  readonly bytes: number\n  readonly pathsResident?: string[]',
    )
    const out = hourLedgerFailures({
      ledger,
      roots: ROOTS_OK,
      sources: [{ rel: 'src/recorder/x.ts', text: 'const p = ledger.hourPaths(h)\n' }],
    })
    expect(out.some((f) => f.includes('`pathsResident`'))).toBe(true)
    expect(out.some((f) => f.startsWith('src/recorder/x.ts:1'))).toBe(true)
  })

  it('a comment naming the removed surface is not a reader', () => {
    const out = hourLedgerFailures({
      ledger: LEDGER_OK,
      roots: ROOTS_OK,
      sources: [{ rel: 'src/recorder/x.ts', text: '// hourPaths( is gone since D523\n' }],
    })
    expect(out).toEqual([])
  })

  it('refuses a hydrate that no longer lists the directory', () => {
    const roots = ROOTS_OK.replace(
      '  const names = await fs.readdir(dir)',
      '  const names = ledger.detail(dir)',
    )
    const out = hourLedgerFailures({ ledger: LEDGER_OK, roots, sources: [] })
    expect(out.some((f) => f.includes('no longer reads a directory'))).toBe(true)
  })
})
