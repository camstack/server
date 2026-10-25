/**
 * D880 - the live shape scan reports where a credential-named field holds a raw
 * string, and NEVER the string. Every canary below is fabricated.
 */
import { describe, expect, it } from 'vitest'
import type { HubCall } from '../hub/migrate-raw-secrets.ts'
import {
  formatReport,
  parseArgs,
  rawSecretPaths,
  scanHub,
  splitTable,
  type ScanOptions,
} from '../hub/scan-raw-secrets.ts'

const CANARY = 'canary-secret-value-0001'
const CANARY_2 = 'canary-secret-value-0002'
const CANARY_3 = 'canary-secret-value-0003'
const MARKER = { $secret: 'secret://x/global/password', v: 1 }

interface Row {
  readonly id: string
  readonly data: unknown
}

interface FakeHub {
  readonly call: HubCall
  readonly routes: string[]
}

function fakeHub(
  tables: Record<string, readonly Row[]>,
  opts: {
    readonly failing?: readonly string[]
    readonly reportedRows?: Record<string, number>
  } = {},
): FakeHub {
  const routes: string[] = []
  const call: HubCall = async (route, input) => {
    routes.push(route)
    if (route === 'storageAdmin.listTables') {
      return {
        tables: Object.entries(tables).map(([name, rows]) => ({
          name,
          rows: opts.reportedRows?.[name] ?? rows.length,
        })),
      }
    }
    if (route !== 'settingsStore.query') throw new Error(`unexpected route ${route}`)
    const q = input as {
      namespace?: string
      collection: string
      filter: { limit: number; offset: number }
    }
    const name = q.namespace === undefined ? q.collection : `${q.namespace}:${q.collection}`
    if (opts.failing?.includes(name) === true) {
      throw new Error(`boom with ${CANARY} inside`)
    }
    const all = tables[name] ?? []
    return all.slice(q.filter.offset, q.filter.offset + q.filter.limit)
  }
  return { call, routes }
}

const OPTS: ScanOptions = { maxRows: 100, page: 2, pauseMs: 0 }

describe('rawSecretPaths', () => {
  it('finds a nested raw credential-named string and reports the path only', () => {
    const paths = rawSecretPaths({
      connection: { host: 'h', password: CANARY },
      list: [{ token: CANARY_2 }],
    })
    expect(paths).toEqual(['connection.password', 'list[0].token'])
    expect(JSON.stringify(paths)).not.toContain(CANARY)
    expect(JSON.stringify(paths)).not.toContain(CANARY_2)
  })

  it('reads an addon-settings row: the field NAME is the sibling `key`', () => {
    const paths = rawSecretPaths({ addonId: 'a', key: 'password', value: CANARY })
    expect(paths).toEqual(['value (key-named pair)'])
    expect(rawSecretPaths({ addonId: 'a', key: 'host', value: CANARY })).toEqual([])
    // The sibling's VALUE (here a field name an operator typed) is never in the path.
    expect(JSON.stringify(rawSecretPaths({ key: 'password-to-nas', value: CANARY }))).not.toContain(
      'password-to-nas',
    )
  })

  it('walks JSON text held in a string column', () => {
    expect(rawSecretPaths({ values: JSON.stringify({ password: CANARY }) })).toEqual([
      'values.password',
    ])
  })

  it('ignores markers (object or JSON text), empties, hashes and non-values', () => {
    expect(
      rawSecretPaths({
        password: MARKER,
        apiKey: JSON.stringify(MARKER),
        token: '',
        passwordHash: CANARY,
        tokenHash: CANARY,
        tokenType: 'bearer',
        secret: null,
        retries: 3,
      }),
    ).toEqual([])
  })

  it('is bounded: a self-deep structure does not run away', () => {
    let deep: Record<string, unknown> = { password: CANARY }
    for (let i = 0; i < 40; i += 1) deep = { child: deep }
    expect(rawSecretPaths(deep)).toEqual([])
  })
})

describe('splitTable', () => {
  it('splits a namespaced canonical base and keeps a declared collection whole', () => {
    expect(splitTable('recorder:addon-settings')).toEqual({
      namespace: 'recorder',
      collection: 'addon-settings',
    })
    expect(splitTable('ai:llm-profiles')).toEqual({ collection: 'ai:llm-profiles' })
    expect(splitTable('addon-settings')).toEqual({ collection: 'addon-settings' })
  })
})

describe('scanHub', () => {
  it('finds raw fields across tables, including an orphan row no code writes', async () => {
    const hub = fakeHub({
      'addon-settings': [
        {
          id: 'provider-dreame.brokers',
          data: {
            addonId: 'provider-dreame',
            key: 'brokers',
            value: [{ connection: { password: CANARY } }],
          },
        },
        { id: 'x.host', data: { addonId: 'x', key: 'host', value: 'h' } },
      ],
      'legacy:orphan-table': [{ id: 'r1', data: { apiKey: CANARY_2 } }],
      'ai:llm-profiles': [{ id: 'p1', data: { apiKey: MARKER } }],
    })
    const report = await scanHub(hub.call, OPTS)
    expect(report.findings).toEqual([
      {
        table: 'addon-settings',
        rowId: 'provider-dreame.brokers',
        path: 'value[0].connection.password',
      },
      { table: 'legacy:orphan-table', rowId: 'r1', path: 'apiKey' },
    ])
  })

  it('pages through a table', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, data: { password: CANARY } }))
    const report = await scanHub(fakeHub({ t: rows }).call, OPTS)
    expect(report.rowsScanned).toBe(5)
    expect(report.findings).toHaveLength(5)
  })

  it('lists a table over the ceiling as skipped - never silently', async () => {
    const hub = fakeHub({ big: [] }, { reportedRows: { big: 5000 } })
    const report = await scanHub(hub.call, OPTS)
    expect(report.skipped).toEqual([{ table: 'big', reason: 'too-large', rows: 5000 }])
    expect(formatReport(report).join('\n')).toContain('NOT checked')
  })

  it('the records engine tables are not scanned and not reported as skipped (a kind cannot hold plaintext, D881)', async () => {
    const hub = fakeHub({ records: [{ id: 'r', data: { password: CANARY } }], _record_kinds: [] })
    const report = await scanHub(hub.call, OPTS)
    expect(report.findings).toEqual([])
    expect(report.skipped).toEqual([])
    expect(report.tables).toBe(0)
  })

  it('an unreadable table is reported by name, without the error text', async () => {
    const hub = fakeHub({ bad: [{ id: 'r', data: {} }] }, { failing: ['bad'] })
    const report = await scanHub(hub.call, OPTS)
    expect(report.skipped).toEqual([{ table: 'bad', reason: 'unreadable', rows: 1 }])
    expect(JSON.stringify(report)).not.toContain(CANARY)
  })

  it('only reads: the routes called are the listing and the query', async () => {
    const hub = fakeHub({ t: [{ id: 'r', data: { password: CANARY } }] })
    await scanHub(hub.call, OPTS)
    expect(new Set(hub.routes)).toEqual(new Set(['storageAdmin.listTables', 'settingsStore.query']))
  })

  it('NO value reaches any output: not the text report, not the JSON report', async () => {
    const hub = fakeHub(
      {
        a: [{ id: 'r1', data: { password: CANARY, nested: { token: CANARY_2 } } }],
        b: [{ id: 'r2', data: { values: JSON.stringify({ apiKey: CANARY_3 }) } }],
        bad: [{ id: 'r3', data: {} }],
      },
      { failing: ['bad'] },
    )
    const report = await scanHub(hub.call, OPTS)
    expect(report.findings).toHaveLength(3)
    const everything = `${formatReport(report).join('\n')}\n${JSON.stringify(report)}`
    for (const canary of [CANARY, CANARY_2, CANARY_3]) expect(everything).not.toContain(canary)
  })

  it('a clean hub says so', async () => {
    const report = await scanHub(
      fakeHub({ t: [{ id: 'r', data: { password: MARKER } }] }).call,
      OPTS,
    )
    expect(formatReport(report).at(-1)).toContain('clean')
  })

  it('names known entries-census orphan row ids and points at the delete script', async () => {
    const hub = fakeHub({
      'addon-settings': [
        {
          id: 'provider-dreame.brokers',
          data: {
            addonId: 'provider-dreame',
            key: 'brokers',
            value: [{ connection: { password: CANARY } }],
          },
        },
      ],
    })
    const lines = formatReport(await scanHub(hub.call, OPTS))
    expect(lines.some((l) => l.includes('delete-entries-leftovers'))).toBe(true)
    expect(lines.join('\n')).not.toContain(CANARY)
  })
})

describe('parseArgs', () => {
  it('refuses to pick a hub', () => {
    expect(parseArgs([])).toContain('--server')
    expect(parseArgs(['--server', 'h'])).toMatchObject({ server: 'h', json: false })
    expect(parseArgs(['--server', 'h', '--page', '0'])).toContain('--page')
    expect(parseArgs(['--server', 'h', '--max-rows', 'x'])).toContain('--max-rows')
  })
})
