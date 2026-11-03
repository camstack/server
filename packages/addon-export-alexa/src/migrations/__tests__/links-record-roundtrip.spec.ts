/**
 * The `skill-links` record on the REAL records engine over SQLite (the path production uses):
 * a body with a linked account and an Amazon grant must come back from `getResolved` with
 * `tokens` as an ARRAY of the exact grants written, and the migration's ports must converge
 * from any record state a failed earlier pass left.
 */
import { createRecordsAccess, createSecretsAccess, type RecordKindHandle } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  makeFakeKeychain,
  makeRecordsWorld,
} from '../../../../system/src/builtins/sqlite-storage/__tests__/support/records-world.js'
import { ALEXA_INSTANCE_ID, alexaSkillLinksKind, type SkillLinksBody } from '../../skill-records.js'
import {
  type DropMovedSettingsPorts,
  moveLedgersToLinks,
  type MoveLedgersPorts,
  planDropMovedSettings,
} from '../settings-to-records.js'

const OWNER = 'export-alexa'
const ACCOUNT = {
  userId: 'amzn1.u1',
  username: 'alice',
  linkedAt: 1700000000000,
}
const TOKEN = {
  userId: 'amzn1.u1',
  accessToken: 'Atza|fake-access',
  refreshToken: 'Atzr|fake-refresh',
  brokerCredential: 'fake-broker-credential',
  expiresAt: 1800000000000,
  receivedAt: 1700000002000,
}
const BODY: SkillLinksBody = {
  name: 'Alexa account links',
  linkedAccounts: [ACCOUNT],
  tokens: [TOKEN],
}

function setup() {
  const world = makeRecordsWorld()
  const keychain = makeFakeKeychain()
  const secrets = createSecretsAccess({ owner: OWNER, transport: keychain })
  const records = createRecordsAccess({
    owner: OWNER,
    transport: world.transportFor(OWNER),
    secrets,
    logger: { warn: () => {} },
  })
  return { world, records }
}

async function links(): Promise<RecordKindHandle<SkillLinksBody>> {
  const { records } = setup()
  await records.declare({ 'skill-links': alexaSkillLinksKind })
  return records.kind(alexaSkillLinksKind)
}

describe('skill-links on the real records engine', () => {
  it('getResolved returns tokens as an array equal to what was put', async () => {
    const handle = await links()
    await handle.put({ id: ALEXA_INSTANCE_ID, data: BODY }, { ifRev: 0 })
    const back = await handle.getResolved(ALEXA_INSTANCE_ID)
    expect(Array.isArray(back?.data.tokens)).toBe(true)
    expect(back?.data).toEqual(BODY)
    const plain = await handle.get(ALEXA_INSTANCE_ID)
    expect(Array.isArray(plain?.data.tokens)).toBe(true)
  })
})

describe('moveLedgersToLinks retry', () => {
  function portsOver(handle: RecordKindHandle<SkillLinksBody>, legacy: Record<string, unknown>) {
    const state = { cleared: false }
    const ports: MoveLedgersPorts = {
      readStored: async () => legacy,
      warn: () => {},
      putLinks: async (body) => {
        if ((await handle.get(ALEXA_INSTANCE_ID)) !== null) return 'exists'
        await handle.put({ id: ALEXA_INSTANCE_ID, data: body }, { ifRev: 0 })
        return 'created'
      },
      replaceLinks: async (body) => {
        await handle.put({ id: ALEXA_INSTANCE_ID, data: body })
      },
      readLinks: async () => (await handle.getResolved(ALEXA_INSTANCE_ID))?.data ?? null,
      clearOldTokenSecrets: async () => {
        state.cleared = true
      },
    }
    return { ports, state }
  }

  it('first pass moves and clears', async () => {
    const handle = await links()
    const { ports, state } = portsOver(handle, {
      linkedAccounts: [ACCOUNT],
      tokens: [TOKEN],
    })
    const result = await moveLedgersToLinks(ports)
    expect(result.outcome).toBe('done')
    expect(state.cleared).toBe(true)
  })

  it('a record an earlier pass left without the grant is rewritten from the settings, then the legacy is cleared', async () => {
    const handle = await links()
    await handle.put({ id: ALEXA_INSTANCE_ID, data: { ...BODY, tokens: [] } }, { ifRev: 0 })
    const { ports, state } = portsOver(handle, {
      linkedAccounts: [ACCOUNT],
      tokens: [TOKEN],
    })
    const result = await moveLedgersToLinks(ports)
    expect(result.outcome).toBe('done')
    expect(state.cleared).toBe(true)
    expect((await handle.getResolved(ALEXA_INSTANCE_ID))?.data).toEqual(BODY)
  })

  it('a record holding something the settings lack is never overwritten and nothing is cleared', async () => {
    const handle = await links()
    const extra = { userId: 'amzn1.u2', username: 'bob', linkedAt: 1 }
    await handle.put(
      {
        id: ALEXA_INSTANCE_ID,
        data: { ...BODY, linkedAccounts: [ACCOUNT, extra] },
      },
      { ifRev: 0 },
    )
    const { ports, state } = portsOver(handle, {
      linkedAccounts: [ACCOUNT],
      tokens: [TOKEN],
    })
    const result = await moveLedgersToLinks(ports)
    expect(result.outcome).toBe('already-done')
    expect(state.cleared).toBe(false)
    expect((await handle.get(ALEXA_INSTANCE_ID))?.data.linkedAccounts).toHaveLength(2)
  })
})

describe('planDropMovedSettings needs positive proof', () => {
  const MARKER = {
    $secret: 'secret://export-alexa/global/tokens[amzn1.u1].accessToken',
  }
  function dropPorts(raw: Record<string, unknown>, held: SkillLinksBody | null) {
    const ports: DropMovedSettingsPorts = {
      readRawStored: async () => raw,
      hasSkill: async () => true,
      readLinks: async () => held,
      warn: () => {},
    }
    return ports
  }
  const legacy = (tokens: unknown): Record<string, unknown> => ({
    linkedAccounts: [ACCOUNT],
    tokens,
  })

  it('refuses while the old settings still carry a credential marker', async () => {
    const raw = legacy([{ ...TOKEN, accessToken: MARKER }])
    await expect(planDropMovedSettings(dropPorts(raw, BODY))).rejects.toThrow(/still carry/)
  })

  it('refuses a tokens value it does not understand, even with a matching-looking record', async () => {
    await expect(
      planDropMovedSettings(dropPorts(legacy({ u1: { accessToken: MARKER } }), BODY)),
    ).rejects.toThrow(/not a list/)
  })

  it('refuses when the record holds the account differently from the settings', async () => {
    const held = {
      ...BODY,
      linkedAccounts: [{ ...ACCOUNT, username: 'someone-else' }],
    }
    await expect(planDropMovedSettings(dropPorts(legacy([]), held))).rejects.toThrow(/differently/)
  })

  it('deletes the ledgers once the credentials are gone and the record holds the accounts', async () => {
    const plan = await planDropMovedSettings(dropPorts(legacy([]), BODY))
    expect(plan.edits).toHaveLength(1)
  })

  it('treats the leftover of a credential clear as "no credentials"', async () => {
    const plan = await planDropMovedSettings(dropPorts(legacy({ $secretClear: true }), BODY))
    expect(plan.edits).toHaveLength(1)
  })
})
