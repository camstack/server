/**
 * A credential an older version stored as plain text is moved into the keychain BEFORE the secret
 * kind is declared; a failure keeps the plain declaration and the next boot tries again.
 */
import { makeInMemoryRecords, REDACTED_SECRET, type SecretsAccess } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { type SealLog, sealPlaintextCredentials } from '../seal-plaintext.js'
import { plainWasteSourceKind, wasteSourceEntryKind } from '../waste-source-record-kinds.js'
import { WasteSourceStore } from '../waste-source-store.js'

const quiet = (): SealLog & { errors: string[] } => {
  const errors: string[] = []
  return {
    errors,
    info: () => undefined,
    error: (message) => {
      errors.push(message)
    },
  }
}

async function seeded(passwords: Record<string, string>) {
  const world = makeInMemoryRecords('waste-collections')
  await world.records.declare({ 'waste-source': plainWasteSourceKind })
  const plain = world.records.kind(plainWasteSourceKind)
  for (const [id, password] of Object.entries(passwords)) {
    await plain.put({
      id,
      data: { name: id, module: 'junker_app', args: { city: 'Torino', password } },
    })
  }
  return { world, plain }
}

function failingPut(real: SecretsAccess, failOn: (ref: string) => boolean): SecretsAccess {
  return {
    ...real,
    put: async (ref, value) => {
      if (failOn(ref)) throw new Error('keychain locked')
      return real.put(ref, value)
    },
  }
}

describe('sealing plain-text credentials before the secret kind', () => {
  it('moves each into the keychain, then the secret kind serves the real value', async () => {
    const { world } = await seeded({ home: 'hunter2' })
    const outcome = await sealPlaintextCredentials(world.records, world.secrets, quiet())
    expect(outcome).toEqual({ state: 'sealed', sealed: 1 })

    await world.records.declare({ 'waste-source': wasteSourceEntryKind })
    const store = WasteSourceStore.of(world.records)
    expect((await store.readResolved('home'))?.args).toMatchObject({ password: 'hunter2' })
    const shown = await world.records.kind(wasteSourceEntryKind).get('home')
    expect(shown?.data.args.password).toBe(REDACTED_SECRET)
    expect(JSON.stringify([...world.tables.values()])).not.toContain('hunter2')
  })

  it('a failed seal leaves every record as it was and the plain declaration open; the next boot seals it', async () => {
    const { world, plain } = await seeded({ a: 'pw-a', b: 'pw-b' })
    const log = quiet()
    const locked = failingPut(world.secrets, (ref) => ref.includes('b'))
    const first = await sealPlaintextCredentials(world.records, locked, log)
    expect(first.state).toBe('failed')
    expect(first.state === 'failed' && first.failures.map((f) => f.id)).toEqual(['b'])
    expect(log.errors).toHaveLength(1)
    // Both texts are still readable, and the plain declaration is still accepted (the secret kind
    // was not declared).
    expect((await plain.get('a'))?.data.args).toMatchObject({ password: 'pw-a' })
    expect((await plain.get('b'))?.data.args).toMatchObject({ password: 'pw-b' })
    await world.records.declare({ 'waste-source': plainWasteSourceKind })

    const second = await sealPlaintextCredentials(world.records, world.secrets, quiet())
    expect(second).toEqual({ state: 'sealed', sealed: 2 })
    await world.records.declare({ 'waste-source': wasteSourceEntryKind })
    const store = WasteSourceStore.of(world.records)
    expect((await store.readResolved('a'))?.args).toMatchObject({ password: 'pw-a' })
    expect((await store.readResolved('b'))?.args).toMatchObject({ password: 'pw-b' })
  })

  it('a record write failing after the keychain landed leaves the text and retries next boot', async () => {
    const { world, plain } = await seeded({ a: 'pw-a', b: 'pw-b' })
    let puts = 0
    const flipping: SecretsAccess = {
      ...world.secrets,
      put: async (ref, value) => {
        const stored = await world.secrets.put(ref, value)
        puts += 1
        if (puts === 2) world.failWrites(true)
        return stored
      },
    }
    const outcome = await sealPlaintextCredentials(world.records, flipping, quiet())
    expect(outcome.state).toBe('failed')
    world.failWrites(false)
    expect((await plain.get('a'))?.data.args).toMatchObject({ password: 'pw-a' })
    expect((await plain.get('b'))?.data.args).toMatchObject({ password: 'pw-b' })
    expect(await sealPlaintextCredentials(world.records, world.secrets, quiet())).toEqual({
      state: 'sealed',
      sealed: 2,
    })
  })

  it('records without a credential seal nothing, and a declared secret kind is a no-op', async () => {
    const { world } = await seeded({})
    expect(await sealPlaintextCredentials(world.records, world.secrets, quiet())).toEqual({
      state: 'sealed',
      sealed: 0,
    })
    await world.records.declare({ 'waste-source': wasteSourceEntryKind })
    expect(await sealPlaintextCredentials(world.records, world.secrets, quiet())).toEqual({
      state: 'already-secret',
    })
  })
})
