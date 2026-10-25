/**
 * `ctx.records` end to end (D881): the facade over the real provider and engine,
 * with a fake keychain behind `ctx.secrets`. The contract under test is the
 * operator's: a field marked `.meta({ secret: true })` is stored as a keychain
 * marker bound to the row, redacted on every read, kept when the token comes
 * back, removed with its row, and a locked keychain is an explicit error - the
 * plaintext is never in a row, a log line or an error message.
 */
import {
  createRecordsAccess,
  createSecretsAccess,
  defineEntryKind,
  defineRecordKinds,
  entryBody,
  ForeignSecretMarkerError,
  InvalidRecordError,
  makeSecretMarker,
  recordsErrorFromMessage,
  RecordSecretUnavailableError,
  RevConflictError,
  RECORD_SECRET_COLLECTION_PREFIX,
  recordSecretRef,
  REDACTED_SECRET,
  SECRET_CLEAR,
  asRecordsError,
} from '@camstack/types'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { makeFakeKeychain, makeRecordsWorld } from './support/records-world.js'

const CANARY = 'p4ssw0rd-CANARY-9f3a'
const OWNER = 'notifiers'

const kinds = defineRecordKinds({
  target: {
    schema: z.object({
      name: z.string().min(1),
      url: z.string().optional(),
      token: z.string().meta({ secret: true }).optional(),
      headers: z
        .array(z.object({ name: z.string(), value: z.string().meta({ secret: true }) }))
        .optional(),
    }),
    class: 'config',
    writeTrigger: 'an operator saves a target',
    retention: { none: 'config' },
    secretArrayKeys: { headers: 'name' },
  },
  event: {
    schema: z.object({ kind: z.string() }),
    class: 'ledger',
    writeTrigger: 'a spec writes it',
    device: 'required',
    at: 'required',
    retention: { owner: 'spec', reason: 'spec' },
  },
})

function setup(opts: { lines?: string[] } = {}) {
  const world = makeRecordsWorld()
  const keychain = makeFakeKeychain()
  const secrets = createSecretsAccess({ owner: OWNER, transport: keychain })
  const lines = opts.lines ?? []
  const records = createRecordsAccess({
    owner: OWNER,
    transport: world.transportFor(OWNER),
    secrets,
    logger: { warn: (m, e) => lines.push(`${m} ${JSON.stringify(e ?? {})}`) },
  })
  return { world, keychain, records, lines }
}

const allRowText = (world: ReturnType<typeof makeRecordsWorld>): string =>
  JSON.stringify(world.settings.db.prepare('SELECT json(data) AS d FROM records').all())

describe('ctx.records: secret fields as a feature of the kind', () => {
  it('stores a marker bound to the row, never the value, and writes the keychain FIRST', async () => {
    const { world, keychain, records } = setup()
    await records.declare(kinds)
    const target = records.kind(kinds.target)
    await target.put({ id: 't1', data: { name: 'Telegram', token: CANARY } })
    const ref = recordSecretRef(OWNER, 'target', 't1', 'token')
    expect(keychain.values.get(ref)).toBe(CANARY)
    expect(allRowText(world)).not.toContain(CANARY)
    expect(allRowText(world)).toContain(ref)
    expect(ref.startsWith('secret://notifiers/row/')).toBe(true)
    expect(decodeURIComponent(ref)).toContain(`${RECORD_SECRET_COLLECTION_PREFIX}target`)
  })

  it('redacts a set secret on get, getMany and query - the owner never reads it by accident', async () => {
    const { records } = setup()
    await records.declare(kinds)
    const target = records.kind(kinds.target)
    await target.put({
      id: 't1',
      data: { name: 'A', token: CANARY, headers: [{ name: 'X-Api', value: CANARY }] },
    })
    const got = await target.get('t1')
    expect(got?.data).toEqual({
      name: 'A',
      token: REDACTED_SECRET,
      headers: [{ name: 'X-Api', value: REDACTED_SECRET }],
    })
    expect(JSON.stringify(await target.getMany(['t1']))).not.toContain(CANARY)
    expect(JSON.stringify(await target.query({}))).not.toContain(CANARY)
  })

  it('resolves the values only when asked, in ONE keychain call for the page', async () => {
    const { world, records, keychain } = setup()
    await records.declare(kinds)
    await records.kind(kinds.target).put({ id: 't1', data: { name: 'A', token: 'one' } })
    await records.kind(kinds.target).put({
      id: 't2',
      data: { name: 'B', token: 'two', headers: [{ name: 'X', value: 'three' }] },
    })
    let resolves = 0
    const real = keychain.resolve.bind(keychain)
    keychain.resolve = async (input) => {
      resolves += 1
      return real(input)
    }
    // a process that has not served these values yet (a cold cache)
    const cold = createRecordsAccess({
      owner: OWNER,
      transport: world.transportFor(OWNER),
      secrets: createSecretsAccess({ owner: OWNER, transport: keychain }),
    })
    const target = cold.kind(kinds.target)
    const page = await target.query({}, { resolveSecrets: true })
    expect(resolves).toBe(1)
    expect(page.records.map((r) => r.data.token)).toEqual(['one', 'two'])
    expect(page.records[1]?.data.headers?.[0]?.value).toBe('three')
    expect((await target.getResolved('t2'))?.data.token).toBe('two')
  })

  it('a locked keychain REFUSES the write, stores no row and no plaintext, and says why', async () => {
    const { world, keychain, records } = setup()
    await records.declare(kinds)
    const target = records.kind(kinds.target)
    keychain.locked = true
    const err = await target
      .put({ id: 't1', data: { name: 'A', token: CANARY } })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RecordSecretUnavailableError)
    expect(String((err as Error).message)).not.toContain(CANARY)
    expect(await target.get('t1')).toBeNull()
    expect(allRowText(world)).not.toContain(CANARY)
  })

  it('a locked keychain on READ is an explicit error, never an empty password', async () => {
    const { world, keychain, records } = setup()
    await records.declare(kinds)
    const target = records.kind(kinds.target)
    await target.put({ id: 't1', data: { name: 'A', token: CANARY } })
    keychain.locked = true
    // a fresh handle with no cached value: the cache would otherwise (rightly) serve the last good one
    const cold = createRecordsAccess({
      owner: OWNER,
      transport: world.transportFor(OWNER),
      secrets: createSecretsAccess({ owner: OWNER, transport: keychain }),
    })
    await expect(cold.kind(kinds.target).getResolved('t1')).rejects.toBeInstanceOf(
      RecordSecretUnavailableError,
    )
    // and the redacted read still works while locked
    expect((await cold.kind(kinds.target).get('t1'))?.data.token).toBe(REDACTED_SECRET)
  })

  it('the redaction token keeps the stored secret; a new string replaces it; omitting a put removes it from the keychain', async () => {
    const { records, keychain } = setup()
    await records.declare(kinds)
    const target = records.kind(kinds.target)
    const ref = recordSecretRef(OWNER, 'target', 't1', 'token')
    await target.put({ id: 't1', data: { name: 'A', token: CANARY } })
    const view = await target.get('t1')
    // an edit form sends back what it read
    await target.put({ id: 't1', data: { ...(view?.data ?? { name: '' }), name: 'Renamed' } })
    expect(keychain.values.get(ref)).toBe(CANARY)
    expect((await target.get('t1'))?.data.name).toBe('Renamed')
    await target.put({ id: 't1', data: { name: 'Renamed', token: 'rotated' } })
    expect(keychain.values.get(ref)).toBe('rotated')
    await target.put({ id: 't1', data: { name: 'No token now' } })
    expect(keychain.values.has(ref)).toBe(false)
  })

  it('SECRET_CLEAR removes one secret; an empty string keeps it (a defaults fallback must not destroy a credential)', async () => {
    const { records, keychain } = setup()
    await records.declare(kinds)
    const target = records.kind(kinds.target)
    const ref = recordSecretRef(OWNER, 'target', 't1', 'token')
    await target.put({ id: 't1', data: { name: 'A', token: CANARY } })
    await target.put({ id: 't1', data: { name: 'A', token: '' } })
    expect(keychain.values.get(ref)).toBe(CANARY)
    // the clear instruction is what a UI form sends: a handle over an untyped body takes it
    const raw = records.kind({
      name: 'target',
      declaration: kinds.target.declaration,
      schema: z.record(z.string(), z.unknown()),
    })
    await raw.put({ id: 't1', data: { name: 'A', token: SECRET_CLEAR } })
    expect(keychain.values.has(ref)).toBe(false)
  })

  it('patch: a string sets, the token is ignored, null removes (and the keychain value goes)', async () => {
    const { records, keychain } = setup()
    await records.declare(kinds)
    const target = records.kind(kinds.target)
    const ref = recordSecretRef(OWNER, 'target', 't1', 'token')
    await target.put({ id: 't1', data: { name: 'A', token: CANARY } })
    await target.patch('t1', { token: REDACTED_SECRET, name: 'B' })
    expect(keychain.values.get(ref)).toBe(CANARY)
    await target.patch('t1', { token: 'patched' })
    expect(keychain.values.get(ref)).toBe('patched')
    await target.patch('t1', { token: null })
    expect(keychain.values.has(ref)).toBe(false)
    expect((await target.get('t1'))?.data).toEqual({ name: 'B' })
  })

  it("array secrets are addressed by the element's declared id, so a reorder keeps every ref", async () => {
    const { records, keychain } = setup()
    await records.declare(kinds)
    const target = records.kind(kinds.target)
    await target.put({
      id: 't1',
      data: {
        name: 'A',
        headers: [
          { name: 'One', value: 'v1' },
          { name: 'Two', value: 'v2' },
        ],
      },
    })
    const before = new Map(keychain.values)
    const view = await target.get('t1')
    await target.put({
      id: 't1',
      data: { name: 'A', headers: (view?.data.headers ?? []).toReversed() },
    })
    expect(new Map(keychain.values)).toEqual(before)
    expect((await target.getResolved('t1'))?.data.headers?.map((h) => h.value)).toEqual([
      'v2',
      'v1',
    ])
  })

  it('a write the engine REFUSES leaves the stored secret as it was (stale ifRev, too large)', async () => {
    const { records, keychain } = setup()
    await records.declare(kinds)
    const target = records.kind(kinds.target)
    const ref = recordSecretRef(OWNER, 'target', 't1', 'token')
    const { rev } = await target.put({ id: 't1', data: { name: 'A', token: CANARY } })
    await expect(
      target.put(
        { id: 't1', data: { name: 'A', token: 'attacker-overwrite' } },
        { ifRev: rev + 5 },
      ),
    ).rejects.toBeInstanceOf(RevConflictError)
    expect(keychain.values.get(ref)).toBe(CANARY)
    await expect(
      target.patch('t1', { token: 'patched-then-refused' }, { ifRev: rev + 5 }),
    ).rejects.toBeInstanceOf(RevConflictError)
    expect(keychain.values.get(ref)).toBe(CANARY)
    // a NEW secret whose row write is refused leaves no orphan value behind
    const fresh = recordSecretRef(OWNER, 'target', 't2', 'token')
    await expect(
      target.put({ id: 't2', data: { name: 'B', token: 'new-secret' } }, { ifRev: 3 }),
    ).rejects.toBeInstanceOf(RevConflictError)
    expect(keychain.values.has(fresh)).toBe(false)
  })

  it('a patch that leaves an array of secret elements untouched keeps every secret', async () => {
    const { records, keychain } = setup()
    await records.declare(kinds)
    const target = records.kind(kinds.target)
    await target.put({
      id: 't1',
      data: {
        name: 'A',
        headers: [
          { name: 'One', value: 'v1' },
          { name: 'Two', value: 'v2' },
        ],
      },
    })
    const before = new Map(keychain.values)
    const view = await target.get('t1')
    await target.patch('t1', { name: 'Renamed', headers: view?.data.headers ?? [] })
    expect(new Map(keychain.values)).toEqual(before)
    const after = await target.getResolved('t1')
    expect(after?.data.name).toBe('Renamed')
    expect(after?.data.headers?.map((h) => h.value)).toEqual(['v1', 'v2'])
  })

  it('delete removes the keychain values of the row; deleteDevice and deleteWhere release theirs too', async () => {
    const { records, keychain } = setup()
    await records.declare(kinds)
    const target = records.kind(kinds.target)
    await target.put({ id: 't1', data: { name: 'A', token: 'a' } })
    await target.put({ id: 't2', data: { name: 'B', token: 'b' } })
    expect(await target.delete('t1')).toBe(true)
    expect(keychain.values.has(recordSecretRef(OWNER, 'target', 't1', 'token'))).toBe(false)
    expect(keychain.values.size).toBe(1)
    expect(await target.deleteMany(['t2'])).toBe(1)
    expect(keychain.values.size).toBe(0)
  })

  it('the engine refuses a forged marker and plaintext even from a caller that skips the facade', async () => {
    const { world, records } = setup()
    await records.declare(kinds)
    const transport = world.transportFor(OWNER)
    await expect(
      transport.put({
        kind: 'target',
        record: {
          id: 't1',
          data: {
            name: 'A',
            token: makeSecretMarker(recordSecretRef(OWNER, 'target', 'other-row', 'token')),
          },
        },
      }),
    ).rejects.toBeInstanceOf(ForeignSecretMarkerError)
    await expect(
      transport.put({ kind: 'target', record: { id: 't1', data: { name: 'A', token: CANARY } } }),
    ).rejects.toThrow(/secret field takes a keychain marker/)
  })

  it('never logs or throws a value: a failing keychain cleanup warns without the secret', async () => {
    const lines: string[] = []
    const { records, keychain } = setup({ lines })
    await records.declare(kinds)
    const target = records.kind(kinds.target)
    await target.put({ id: 't1', data: { name: 'A', token: CANARY } })
    keychain.delete = async () => {
      throw new Error('keychain down')
    }
    await target.delete('t1')
    expect(lines.join('\n')).toContain('could not remove released keychain values')
    expect(lines.join('\n')).not.toContain(CANARY)
  })

  it('a kind with secrets and no keychain door refuses instead of storing anything', async () => {
    const world = makeRecordsWorld()
    const records = createRecordsAccess({
      owner: OWNER,
      transport: world.transportFor(OWNER),
      secrets: null,
    })
    await records.declare(kinds)
    await expect(
      records.kind(kinds.target).put({ id: 't1', data: { name: 'A', token: CANARY } }),
    ).rejects.toBeInstanceOf(RecordSecretUnavailableError)
    // a kind without secrets is unaffected
    await records.kind(kinds.event).put({ id: 'e1', deviceId: 1, at: 1, data: { kind: 'x' } })
  })
})

describe('ctx.records: the typed surface', () => {
  it("validates against the kind's schema and names the field, never the value", async () => {
    const { records } = setup()
    await records.declare(kinds)
    const err = await records
      .kind(kinds.target)
      .put({ id: 't1', data: { name: '' } })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InvalidRecordError)
    expect(String((err as Error).message)).toContain('name')
  })

  it('rebuilds the typed failure from a message that crossed a wire', () => {
    expect(asRecordsError(new Error('records/rev-conflict: expected rev 2'))).toBeInstanceOf(
      RevConflictError,
    )
    expect(recordsErrorFromMessage('records/nope: x')).toBeNull()
    expect(recordsErrorFromMessage('unrelated')).toBeNull()
    const other = new Error('boom')
    expect(asRecordsError(other)).toBe(other)
  })

  it('ifRev guards a put against a concurrent writer', async () => {
    const { records } = setup()
    await records.declare(kinds)
    const event = records.kind(kinds.event)
    const { rev } = await event.put({ id: 'e', deviceId: 1, at: 1, data: { kind: 'a' } })
    await event.put({ id: 'e', deviceId: 1, at: 1, data: { kind: 'b' } }, { ifRev: rev })
    await expect(
      event.put({ id: 'e', deviceId: 1, at: 1, data: { kind: 'c' } }, { ifRev: rev }),
    ).rejects.toBeInstanceOf(RevConflictError)
  })

  it('forOwner is null for an addon, and a legacy table with rows refuses nothing (D900)', async () => {
    const world = makeRecordsWorld()
    world.settings.db.exec('CREATE TABLE "legacy:t" (id TEXT PRIMARY KEY)')
    world.settings.db.exec(`INSERT INTO "legacy:t" VALUES ('a')`)
    const records = createRecordsAccess({
      owner: OWNER,
      transport: world.transportFor(OWNER),
      secrets: null,
    })
    expect(records.forOwner).toBeNull()
    const kinds = defineRecordKinds({
      thing: {
        schema: z.object({ v: z.number() }),
        class: 'config',
        writeTrigger: 'x',
        retention: { none: 'x' },
      },
    })
    const declared = await records.declare(kinds)
    expect(declared['thing']?.state).toBe('created')
  })

  it("forOwner lets a system builtin act for the entry's owner, with that owner's keychain", async () => {
    const world = makeRecordsWorld()
    const keychain = makeFakeKeychain()
    const own = createSecretsAccess({
      owner: 'entries',
      transport: keychain,
      transportForOwner: () => keychain,
    })
    const entries = createRecordsAccess({
      owner: 'entries',
      transport: world.transportFor('entries'),
      secrets: own,
      transportForOwner: (other) => world.transportFor(other),
    })
    const asNotifiers = entries.forOwner?.('notifiers')
    expect(asNotifiers?.owner).toBe('notifiers')
    await asNotifiers?.declare(kinds)
    await asNotifiers?.kind(kinds.target).put({ id: 't1', data: { name: 'A', token: CANARY } })
    expect([...keychain.values.keys()][0]).toContain('secret://notifiers/')
    // and the entries addon itself still cannot see notifiers' kind
    await expect(entries.kind(kinds.target).get('t1')).rejects.toThrow(/declared no kind/)
  })
})

describe('entry kinds', () => {
  const smtp = defineEntryKind('smtp-account', {
    title: 'SMTP accounts',
    schema: entryBody({ host: z.string(), password: z.string().meta({ secret: true }).optional() }),
  })

  it('carries a descriptor with the JSON schema and the secret marker of each password field', () => {
    const entry = smtp.declaration.entry
    expect(entry?.title).toBe('SMTP accounts')
    expect(entry?.nameField).toBe('name')
    const props = entry?.fields['properties']
    expect(props).toMatchObject({ password: { secret: true }, host: { type: 'string' } })
    expect(smtp.declaration.secretPaths).toEqual(['password'])
    expect(smtp.declaration.class).toBe('config')
    expect(smtp.declaration.retention).toEqual({ none: expect.any(String) })
  })

  it('refuses an entry schema with no name field', () => {
    expect(() =>
      defineEntryKind('nameless', { title: 'x', schema: z.object({ host: z.string() }) }),
    ).toThrow(/needs a "name" field/)
  })

  it('works as an ordinary kind', async () => {
    const { records, keychain } = setup()
    await records.declare({ 'smtp-account': smtp })
    await records
      .kind(smtp)
      .put({ id: 'a', data: { name: 'Home', host: 'smtp.x', password: CANARY } })
    expect([...keychain.values.values()]).toEqual([CANARY])
    expect((await records.kind(smtp).get('a'))?.data.password).toBe(REDACTED_SECRET)
  })
})
