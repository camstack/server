/**
 * The instance descriptor and the addon agree on the Test action: the descriptor offers it AND
 * the `test` hook runs the Dreo sign-in check with the stored account merged under the edited form.
 */
import { makeInMemoryRecords, REDACTED_SECRET } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { buildDreoConnectionTestProvider } from '../dreo-connection-test.js'
import { buildDreoInstances, dreoConnectionsEntryKind, dreoRecordKinds } from '../dreo-instances.js'
import type { DreoFacadeFactory } from '../dreo-integration-manager.js'

const STORED_PASSWORD = 'stored-pw'

/** A Dreo cloud that accepts exactly one password; records every account it was asked to sign in. */
function setup() {
  const seen: Array<{ email: string; password: string; region: string }> = []
  const makeFacade: DreoFacadeFactory = (config) => {
    seen.push({ email: config.email, password: config.password, region: config.region })
    return {
      login: async () => {
        if (config.password !== STORED_PASSWORD) throw new Error('refused')
      },
      close: async () => undefined,
    } as unknown as ReturnType<DreoFacadeFactory>
  }
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const tester = buildDreoConnectionTestProvider({ makeFacade, logger: logger as never })
  return { seen, tester, logger }
}

async function build() {
  const mem = makeInMemoryRecords('provider-dreo')
  await mem.records.declare(dreoRecordKinds)
  const s = setup()
  const instances = buildDreoInstances(mem.records, {
    onChanged: async () => undefined,
    tester: s.tester,
  })
  const seed = async (body: { email: string; password: string; region: 'eu' | 'us' }) =>
    mem.records
      .kind(dreoConnectionsEntryKind)
      .put({ id: 'int_1', data: { name: 'Home', ...body } }, { ifRev: 0 })
  return { instances, seed, ...s }
}

describe('dreo instance descriptor', () => {
  it('offers the Test action', async () => {
    const { instances } = await build()
    expect((await instances.describe()).canTest).toBe(true)
  })

  it('Test on a saved instance signs in with the stored password when the form does not retype it', async () => {
    const { instances, seen, seed } = await build()
    await seed({ email: 'a@example.com', password: STORED_PASSWORD, region: 'eu' })
    const id = 'int_1'
    const result = await instances.testInstance({
      id,
      values: { email: 'a@example.com', password: REDACTED_SECRET, region: 'eu' },
    })
    expect(result.success).toBe(true)
    expect(seen.at(-1)?.password).toBe(STORED_PASSWORD)
  })

  it('Test uses a retyped password and reports a refusal', async () => {
    const { instances, seen, seed } = await build()
    await seed({ email: 'a@example.com', password: STORED_PASSWORD, region: 'eu' })
    const id = 'int_1'
    const result = await instances.testInstance({
      id,
      values: { email: 'b@example.com', password: 'wrong', region: 'eu' },
    })
    expect(result.success).toBe(false)
    expect(seen.at(-1)).toMatchObject({ email: 'b@example.com', password: 'wrong' })
  })
})
