import {
  type IScopedLogger,
  makeInMemoryRecords,
  RecordSecretUnavailableError,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ALEXA_INSTANCE_ID, alexaSkillStateKind, type SkillStateBody } from '../skill-records.js'
import { SkillStateStore } from '../skill-state-store.js'

const logger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
  withTags: () => logger,
}
const GENERATE = { token: () => 'generated-token', namespace: () => 'generated-namespace' }

async function setup(existing?: Partial<SkillStateBody>) {
  const memory = makeInMemoryRecords('export-alexa')
  await memory.records.declare({ 'skill-state': alexaSkillStateKind })
  const handle = memory.records.kind(alexaSkillStateKind)
  if (existing !== undefined) {
    await handle.put(
      {
        id: ALEXA_INSTANCE_ID,
        data: {
          name: 'S',
          visionNamespace: '',
          detectionClasses: {},
          accountVisibility: {},
          exportedEndpoints: {},
          exportedSignatures: {},
          advertisedBrokerUrl: '',
          lwaClientId: '',
          ...existing,
        },
      },
      { ifRev: 0 },
    )
  }
  return { handle, store: new SkillStateStore({ handle, instanceId: ALEXA_INSTANCE_ID, logger }) }
}

describe('SkillStateStore', () => {
  it('generates the token and the namespace when the record is absent', async () => {
    const { handle, store } = await setup()
    await store.ensureIdentity(GENERATE)
    expect((await handle.getResolved(ALEXA_INSTANCE_ID))?.data).toMatchObject({
      ingressToken: 'generated-token',
      visionNamespace: 'generated-namespace',
    })
  })

  it('never overwrites a token that exists, and fills only the missing namespace', async () => {
    const { handle, store } = await setup({ ingressToken: 'real-token-from-the-lambda' })
    await store.ensureIdentity(GENERATE)
    expect((await handle.getResolved(ALEXA_INSTANCE_ID))?.data).toMatchObject({
      ingressToken: 'real-token-from-the-lambda',
      visionNamespace: 'generated-namespace',
    })
  })

  it('writes nothing while the keychain is locked', async () => {
    const puts: string[] = []
    const store = new SkillStateStore({
      instanceId: ALEXA_INSTANCE_ID,
      logger,
      handle: {
        getResolved: async () => {
          throw new RecordSecretUnavailableError('locked')
        },
        put: async (input) => {
          puts.push(input.id)
          return { rev: 1 }
        },
      },
    })
    await store.ensureIdentity(GENERATE)
    expect(puts).toEqual([])
    await expect(store.update({ lwaClientId: 'x' })).rejects.toThrow('keychain is locked')
  })

  it('serialises updates so none is lost', async () => {
    const { handle, store } = await setup({ ingressToken: 't' })
    await store.refresh()
    await Promise.all([
      store.update({ advertisedBrokerUrl: 'https://b' }),
      store.update({ lwaClientId: 'cid' }),
      store.update({ exportedSignatures: { '7': 'sig' } }),
    ])
    expect((await handle.getResolved(ALEXA_INSTANCE_ID))?.data).toMatchObject({
      ingressToken: 't',
      advertisedBrokerUrl: 'https://b',
      lwaClientId: 'cid',
      exportedSignatures: { '7': 'sig' },
    })
  })
})
