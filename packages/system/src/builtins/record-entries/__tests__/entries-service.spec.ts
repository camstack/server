/**
 * The entries service (D881) over the real records engine and a fake keychain:
 * a generic list/add/edit/delete of an entry kind it knows only by descriptor.
 * Password fields come from the schema, a read never carries a secret, a locked
 * keychain refuses the write, and an edit that sends the redaction token keeps
 * the stored secret.
 */
import {
  createRecordsAccess,
  createSecretsAccess,
  defineEntryKind,
  entryBody,
  InvalidRecordError,
  isSecretFieldView,
  RecordSecretUnavailableError,
  RevConflictError,
  UnknownRecordKindError,
} from '@camstack/types'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import {
  makeFakeKeychain,
  makeRecordsWorld,
} from '../../sqlite-storage/__tests__/support/records-world.js'
import { EntriesService } from '../entries-service.js'

const CANARY = 'smtp-pass-CANARY-77'

const smtp = defineEntryKind('smtp-account', {
  title: 'SMTP accounts',
  schema: entryBody({
    host: z.string().min(1),
    port: z.number().int().optional(),
    password: z.string().meta({ secret: true }).optional(),
  }),
})

async function setup() {
  const world = makeRecordsWorld()
  const keychain = makeFakeKeychain()
  const secretsOf = (owner: string) => createSecretsAccess({ owner, transport: keychain })
  // the OWNER declares its kind through its own door
  const owner = createRecordsAccess({
    owner: 'notifiers',
    transport: world.transportFor('notifiers'),
    secrets: secretsOf('notifiers'),
  })
  await owner.declare({ 'smtp-account': smtp })
  // the entries service acts FOR the owner: one door per owner, each with the owner's keychain
  const service = new EntriesService({
    listKinds: async (counts) => (await world.provider.listKinds({ counts })).kinds,
    recordsFor: (o) =>
      createRecordsAccess({ owner: o, transport: world.transportFor(o), secrets: secretsOf(o) }),
    newId: (() => {
      let n = 0
      return () => `id-${(n += 1)}`
    })(),
  })
  return { world, keychain, owner, service }
}

const listed = async (service: EntriesService) =>
  (await service.listEntries({ owner: 'notifiers', kind: 'smtp-account' })).entries

describe('entries service', () => {
  it('lists the entry kinds with the schema descriptor that marks each password field', async () => {
    const { service } = await setup()
    const { kinds } = await service.listEntryKinds()
    expect(kinds).toHaveLength(1)
    expect(kinds[0]).toMatchObject({
      owner: 'notifiers',
      kind: 'smtp-account',
      title: 'SMTP accounts',
      nameField: 'name',
      secretPaths: ['password'],
      rows: 0,
    })
    expect(kinds[0]?.fields['properties']).toMatchObject({
      password: { type: 'string', secret: true },
      host: { type: 'string' },
    })
  })

  it("adds an entry (the secret goes to the OWNER's keychain), lists it redacted, edits it keeping the secret, deletes it", async () => {
    const { keychain, service } = await setup()
    const created = await service.putEntry({
      owner: 'notifiers',
      kind: 'smtp-account',
      data: { name: 'Home', host: 'smtp.x', password: CANARY },
    })
    expect(created).toEqual({ id: 'id-1', rev: 1 })
    expect([...keychain.values.keys()][0]).toContain('secret://notifiers/')
    const [entry] = await listed(service)
    expect(entry).toMatchObject({ id: 'id-1', name: 'Home', rev: 1 })
    // a stored secret is read as a VIEW carrying the row's keychain ref (so the form can
    // reveal it through the audited keychain-admin), never as the value or a bare token
    expect(entry?.data['password']).toEqual({
      $secret: [...keychain.values.keys()][0],
      v: 1,
      set: true,
    })
    expect(JSON.stringify(entry)).not.toContain(CANARY)

    // the form sends back what it read, with one field edited
    const edited = await service.putEntry({
      owner: 'notifiers',
      kind: 'smtp-account',
      id: 'id-1',
      data: { ...entry?.data, host: 'smtp.y' },
      ifRev: 1,
    })
    expect(edited.rev).toBe(2)
    expect([...keychain.values.values()]).toEqual([CANARY])
    expect((await listed(service))[0]?.data['host']).toBe('smtp.y')

    expect(
      await service.deleteEntry({ owner: 'notifiers', kind: 'smtp-account', id: 'id-1' }),
    ).toEqual({ deleted: true })
    expect(keychain.values.size).toBe(0)
    expect(await listed(service)).toEqual([])
  })

  it('a locked keychain refuses the write: nothing is stored', async () => {
    const { keychain, service } = await setup()
    keychain.locked = true
    await expect(
      service.putEntry({
        owner: 'notifiers',
        kind: 'smtp-account',
        data: { name: 'Home', host: 'h', password: CANARY },
      }),
    ).rejects.toBeInstanceOf(RecordSecretUnavailableError)
    expect(await listed(service)).toEqual([])
  })

  it('validates the body against the descriptor, names the field and never the value', async () => {
    const { service } = await setup()
    const err = await service
      .putEntry({
        owner: 'notifiers',
        kind: 'smtp-account',
        data: { name: 'Home', host: '', password: CANARY },
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InvalidRecordError)
    expect(err instanceof Error ? err.message : '').not.toContain(CANARY)
  })

  it('an edit guarded by a stale rev is refused; a create never overwrites an existing id', async () => {
    const { service } = await setup()
    await service.putEntry({
      owner: 'notifiers',
      kind: 'smtp-account',
      id: 'fixed',
      data: { name: 'A', host: 'h' },
    })
    await expect(
      service.putEntry({
        owner: 'notifiers',
        kind: 'smtp-account',
        id: 'fixed',
        data: { name: 'B', host: 'h' },
        ifRev: 9,
      }),
    ).rejects.toBeInstanceOf(RevConflictError)
  })

  it('refuses a kind that is not an entry kind or not declared', async () => {
    const { owner, service } = await setup()
    const plain = (await import('@camstack/types')).defineRecordKinds({
      plain: {
        schema: z.object({ v: z.number() }),
        class: 'config',
        writeTrigger: 'x',
        retention: { none: 'x' },
      },
    })
    await owner.declare(plain)
    await expect(service.listEntries({ owner: 'notifiers', kind: 'plain' })).rejects.toBeInstanceOf(
      UnknownRecordKindError,
    )
    await expect(service.listEntries({ owner: 'notifiers', kind: 'ghost' })).rejects.toBeInstanceOf(
      UnknownRecordKindError,
    )
    await expect(
      service.listEntries({ owner: 'someone-else', kind: 'smtp-account' }),
    ).rejects.toBeInstanceOf(UnknownRecordKindError)
  })

  it('the secret view is what the form sends back untouched: it keeps the stored value', async () => {
    const { keychain, service } = await setup()
    await service.putEntry({
      owner: 'notifiers',
      kind: 'smtp-account',
      id: 'a',
      data: { name: 'A', host: 'h', password: CANARY },
    })
    const [entry] = await listed(service)
    await service.putEntry({
      owner: 'notifiers',
      kind: 'smtp-account',
      id: 'a',
      data: { ...entry?.data, host: 'h2' },
      ifRev: 1,
    })
    expect([...keychain.values.values()]).toEqual([CANARY])
    expect((await listed(service))[0]?.data['password']).toMatchObject({ set: true })
  })

  it('an entry with no secret set reads with no secret field at all (not an empty view)', async () => {
    const { service } = await setup()
    await service.putEntry({
      owner: 'notifiers',
      kind: 'smtp-account',
      id: 'b',
      data: { name: 'B', host: 'h' },
    })
    expect('password' in ((await listed(service))[0]?.data ?? {})).toBe(false)
  })

  it('holds for a secret nested in the body, for every kind that declares secret paths', async () => {
    const { world, keychain, owner, service } = await setup()
    const nested = defineEntryKind('webhook', {
      title: 'Webhooks',
      schema: entryBody({
        url: z.string(),
        auth: z.object({ token: z.string().meta({ secret: true }).optional() }).optional(),
      }),
    })
    await owner.declare({ webhook: nested })
    void world
    await service.putEntry({
      owner: 'notifiers',
      kind: 'webhook',
      id: 'w1',
      data: { name: 'W', url: 'https://example.com', auth: { token: CANARY } },
    })
    const { entries } = await service.listEntries({ owner: 'notifiers', kind: 'webhook' })
    const auth = entries[0]?.data['auth']
    const view =
      typeof auth === 'object' && auth !== null && 'token' in auth ? auth.token : undefined
    expect(view).toMatchObject({ v: 1, set: true })
    expect(isSecretFieldView(view)).toBe(true)
    expect([...keychain.values.keys()]).toContain(isSecretFieldView(view) ? view.$secret : null)
    expect(JSON.stringify(entries)).not.toContain(CANARY)
  })
})
