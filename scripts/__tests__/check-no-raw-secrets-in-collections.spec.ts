/**
 * D879 - a credential-named field of a persisted row is a keychain marker, or
 * pinned with a reason. Fixtures plant a raw secret in a fake collection (the
 * disarm); the last test runs the real tree.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ALLOWLIST,
  evaluate,
  RAW_UNTIL_RECORDS,
  scan,
  type RawCensusRow,
} from '../check-no-raw-secrets-in-collections.ts'
import { itRealTree } from './lib/real-tree.js'

const roots: string[] = []

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'raw-secrets-'))
  roots.push(root)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  return root
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

const ids = (root: string): string[] => scan(root).map((f) => `${f.kind}:${f.file}#${f.key}`)

const STORE = (shape: string): string =>
  `import { z } from 'zod'\n/** @durable class=config owner=x */\nexport const X_COLLECTION = 'x:rows'\n${shape}\n`

describe('check-no-raw-secrets-in-collections', () => {
  it('flags a raw token planted in a Zod row schema of a collection', () => {
    const root = tree({
      'packages/addon-x/src/store.ts': STORE(
        'const Row = z.object({ id: z.string(), token: z.string() })',
      ),
    })
    expect(ids(root)).toEqual(['zod:packages/addon-x/src/store.ts#token'])
  })

  it('accepts a marker-typed field', () => {
    const root = tree({
      'packages/addon-x/src/store.ts': STORE(
        'const Row = z.object({ id: z.string(), token: SecretMarkerSchema })',
      ),
    })
    expect(ids(root)).toEqual([])
  })

  it('accepts a Zod field declared `.meta({ secret: true })`', () => {
    const root = tree({
      'packages/addon-x/src/store.ts': STORE(
        'const Row = z.object({ id: z.string(), apiKey: z.string().meta({ secret: true }) })',
      ),
    })
    expect(ids(root)).toEqual([])
  })

  it('follows a row type declared in another file', () => {
    const root = tree({
      'packages/addon-x/src/store.ts': STORE('const parse = (d: unknown) => RowSchema.parse(d)'),
      'packages/types/src/row.ts': 'export const RowSchema = z.object({ apiKey: z.string() })',
    })
    expect(ids(root)).toEqual(['zod:packages/types/src/row.ts#apiKey'])
  })

  it('flags a credential column and a credential key written to the store', () => {
    const root = tree({
      'packages/addon-x/src/store.ts': STORE(
        "const cols = [{ name: 'password', type: 'TEXT' }]\n" +
          "async function save(store: S) { await store.insert('c', { id: '1', data: { botToken: t } }) }",
      ),
    })
    expect(ids(root).sort()).toEqual([
      'column:packages/addon-x/src/store.ts#password',
      'write:packages/addon-x/src/store.ts#botToken',
    ])
  })

  it('ignores files that own no collection and test files', () => {
    const root = tree({
      'packages/addon-x/src/form.ts': 'const F = z.object({ token: z.string() })',
      'packages/addon-x/src/__tests__/s.ts': STORE('const R = z.object({ token: z.string() })'),
    })
    expect(ids(root)).toEqual([])
  })

  it('flags broker rows persisted with no keychain declaration, and accepts secretStatePaths', () => {
    const write = 'await this.updateGlobalSettings({ brokers: next })'
    const bad = tree({ 'packages/addon-b/src/addon.ts': write })
    expect(ids(bad)).toEqual(['broker-rows:pkg:addon-b#brokers'])
    const good = tree({
      'packages/addon-b/src/addon.ts': `${write}\nprotected override readonly secretStatePaths = ['brokers[id].auth.accessToken']`,
    })
    expect(ids(good)).toEqual([])
  })

  it('flags a credential-named hidden state key unless secretStatePaths names it', () => {
    const bad = tree({
      'packages/addon-h/src/a.ts': "this.state<string>('linkSecret', S, '')",
    })
    expect(ids(bad)).toEqual(['hidden-state:packages/addon-h/src/a.ts#linkSecret'])
    const good = tree({
      'packages/addon-h/src/a.ts':
        "readonly secretStatePaths = ['linkSecret']\nthis.state<string>('linkSecret', S, '')",
    })
    expect(ids(good)).toEqual([])
  })
})

describe('evaluate', () => {
  const finding = { file: 'a.ts', key: 'token', kind: 'zod' as const }
  const row: RawCensusRow = {
    owner: 'o',
    where: 'w',
    field: 'f',
    phase: 2,
    file: 'a.ts',
    evidence: /still raw/,
    covers: ['a.ts#token'],
  }

  it('fails a finding that is neither allowlisted nor in the census', () => {
    expect(evaluate([finding], new Map(), []).raw).toHaveLength(1)
  })

  it('passes a pinned or census-covered finding', () => {
    expect(evaluate([finding], new Map([['a.ts#token', 'hash']]), []).raw).toEqual([])
    expect(evaluate([finding], new Map(), [row], () => 'still raw').raw).toEqual([])
  })

  it('fails a stale allowlist entry and a census row whose evidence is gone', () => {
    expect(evaluate([], new Map([['gone.ts#k', 'r']]), []).stale).toEqual(['gone.ts#k'])
    expect(evaluate([finding], new Map(), [row], () => 'moved to markers').stale).toEqual([
      'census o: a.ts',
    ])
  })

  it('every allowlist entry carries a reason', () => {
    for (const reason of ALLOWLIST.values()) expect(reason.length).toBeGreaterThan(5)
  })
})

describe('the real tree', () => {
  itRealTree('is green: nothing new is raw, no exemption is stale', { timeout: 180_000 }, () => {
    const root = resolve(import.meta.dirname, '../..')
    const { raw, stale } = evaluate(scan(root), ALLOWLIST, RAW_UNTIL_RECORDS, (rel) => {
      try {
        return readFileSync(join(root, rel), 'utf8')
      } catch {
        return ''
      }
    })
    expect({ raw, stale }).toEqual({ raw: [], stale: [] })
  })
})
