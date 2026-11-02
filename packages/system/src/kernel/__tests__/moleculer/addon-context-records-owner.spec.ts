/**
 * A grouped runner is stamped with its GROUP id (the transport vouches for the runner, not the
 * addon). The records engine builds the one ref a secret field may carry from that stamp, so the
 * facade of an addon inside a group must build its markers under the same owner - otherwise every
 * secret write of a grouped addon is refused `records/foreign-marker`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { z } from 'zod'
import {
  defineEntryKind,
  isSecretMarker,
  recordSecretRef,
  type AddonDeclaration,
} from '@camstack/types'
import { createUdsAddonContext } from '../../moleculer/addon-context-factory.js'
import type { CapCallInput } from '../../transport/child-cap-protocol.js'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import { LocalChildClient } from '../../transport/local-child-client.js'
import { LocalChildRegistry } from '../../transport/local-child-registry.js'

const GROUP = 'records-owner-group'
const kind = defineEntryKind('accounts', {
  title: 'Account',
  nameField: 'name',
  schema: z.object({
    name: z.string(),
    token: z.string().optional().meta({ secret: true }),
  }),
})

describe('ctx.records in a grouped runner', () => {
  let registry: LocalChildRegistry
  let client: LocalChildClient
  let tmpDir: string
  const calls: CapCallInput[] = []

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'records-owner-'))
    calls.length = 0
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer('hub'),
      resolveChildIdForAddon: (addonId) => (addonId === 'member-addon' ? GROUP : addonId),
      onUnownedCall: async (input) => {
        calls.push(input)
        if (input.capName === 'records' && input.method === 'declareKinds') return { kinds: [] }
        if (input.capName === 'records') return { rev: 1, releasedRefs: [], secretRefs: [] }
        if (input.capName === 'keychain' && input.method === 'resolve') return {}
        return { version: 1 }
      },
    })
    registry.onReadinessSnapshotRequest(() => [])
    await registry.start()
    client = new LocalChildClient({
      nodeId: 'hub',
      childId: GROUP,
      caps: [],
      dispatch: async () => {
        throw new Error('no inbound caps')
      },
    })
    await client.start()
  })

  afterEach(async () => {
    await client.close()
    await registry.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const member: AddonDeclaration = {
    id: 'member-addon',
    entry: './index.js',
    execution: { placement: 'hub-only', group: GROUP },
  }

  it('keys the rows and the secret ref by the ADDON id, not by the group', async () => {
    const ctx = await createUdsAddonContext(client, `hub/${GROUP}`, member, tmpDir)
    const records = ctx.records
    if (records === undefined) throw new Error('no records')
    await records.declare({ accounts: kind })
    await records.kind(kind).put({ id: 'row', data: { name: 'n', token: 'plain' } }, { ifRev: 0 })

    const put = calls.find((c) => c.capName === 'records' && c.method === 'put')
    expect(put?.callerAddonId).toBe('member-addon')
    const body: unknown = Reflect.get(
      Reflect.get(Reflect.get(put?.args ?? {}, 'record') ?? {}, 'data') ?? {},
      'token',
    )
    if (!isSecretMarker(body)) throw new Error('the token was not stored as a marker')
    expect(body.$secret).toBe(recordSecretRef('member-addon', 'accounts', 'row', 'token'))
    // The keychain is checked against the runner, so its stamp is unchanged.
    const keychainPut = calls.find((c) => c.capName === 'keychain' && c.method === 'put')
    expect(keychainPut?.callerAddonId).toBe(GROUP)
  })

  it('refuses a call that claims an addon the runner does not host', async () => {
    const stranger: AddonDeclaration = { id: 'stranger', entry: './index.js' }
    const ctx = await createUdsAddonContext(client, `hub/${GROUP}`, stranger, tmpDir)
    const records = ctx.records
    if (records === undefined) throw new Error('no records')
    await expect(records.declare({ accounts: kind })).rejects.toThrow(/acting-addon-not-hosted/)
    expect(calls.filter((c) => c.capName === 'records')).toEqual([])
  })
})
