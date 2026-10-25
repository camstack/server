/**
 * B0 operator script: delete census **X** addon-settings rows after verify.
 */
import { describe, expect, it } from 'vitest'
import { isSecretMarker } from '../../packages/types/src/keychain/secret-marker.js'
import type { HubCall } from '../hub/hub-call.js'
import {
  deleteEntriesLeftovers,
  verifyDreamePasswordMarker,
} from '../hub/delete-entries-leftovers.js'
import {
  DREAME_INTEGRATION_ID,
  DREAME_LEGACY_BROKERS_KEY,
} from '../hub/entries-leftover-targets.js'

const MARKER = { $secret: 'secret://provider-dreame/global/password', v: 1 }
const CANARY = 'canary-password-0001'

interface FakeHub extends HubCall {
  rows: Map<string, unknown>
  deleted: string[]
  integrationAddonId: string
  settingsPassword: unknown
  revealOk: boolean
}

function fakeHub(): FakeHub {
  const rows = new Map<string, unknown>()
  rows.set(DREAME_LEGACY_BROKERS_KEY, {
    addonId: 'provider-dreame',
    key: 'brokers',
    value: [{ connection: { password: CANARY } }],
  })
  rows.set('local-network.viewerBaseUrls', {
    addonId: 'local-network',
    key: 'viewerBaseUrls',
    value: ['https://old.example'],
  })
  const hub: FakeHub = {
    rows,
    deleted: [],
    integrationAddonId: 'provider-dreame',
    settingsPassword: MARKER,
    revealOk: true,
    query: async (route, input) => {
      if (route === 'integrations.get') {
        return { id: DREAME_INTEGRATION_ID, addonId: hub.integrationAddonId }
      }
      if (route === 'integrations.getSettings') {
        return { password: hub.settingsPassword, username: 'u' }
      }
      if (route === 'settingsStore.get') {
        const key = (input as { key: string }).key
        const row = hub.rows.get(key)
        return row === undefined ? null : { id: key, data: row }
      }
      throw new Error(`unexpected query ${route}`)
    },
    mutate: async (route, input) => {
      if (route === 'keychainAdmin.reveal') {
        if (!hub.revealOk) throw new Error('locked')
        return { value: 'revealed-not-logged', version: 1 }
      }
      if (route === 'settingsStore.delete') {
        const key = (input as { key: string }).key
        hub.deleted.push(key)
        hub.rows.delete(key)
        return undefined
      }
      throw new Error(`unexpected mutate ${route}`)
    },
  }
  return hub
}

describe('verifyDreamePasswordMarker', () => {
  it('passes when int_0009 is dreame and password is a resolving marker', async () => {
    const hub = fakeHub()
    const gate = await verifyDreamePasswordMarker(hub, DREAME_INTEGRATION_ID)
    expect(gate.ok).toBe(true)
    expect(isSecretMarker(hub.settingsPassword)).toBe(true)
  })

  it('refuses when the integration addon id is wrong', async () => {
    const hub = fakeHub()
    hub.integrationAddonId = 'provider-wyze'
    const gate = await verifyDreamePasswordMarker(hub, DREAME_INTEGRATION_ID)
    expect(gate.ok).toBe(false)
    expect(gate.reason).toContain('provider-dreame')
  })

  it('refuses when password is still raw', async () => {
    const hub = fakeHub()
    hub.settingsPassword = CANARY
    const gate = await verifyDreamePasswordMarker(hub, DREAME_INTEGRATION_ID)
    expect(gate.ok).toBe(false)
    expect(gate.reason).toContain('marker')
  })
})

describe('deleteEntriesLeftovers', () => {
  it('dry run counts present rows and deletes nothing', async () => {
    const hub = fakeHub()
    const out = await deleteEntriesLeftovers(hub, { apply: false })
    expect(out.status).toBe('done')
    if (out.status !== 'done') throw new Error('unreachable')
    expect(out.present).toBeGreaterThan(0)
    expect(out.deleted).toBe(0)
    expect(hub.deleted).toEqual([])
    expect(out.dreameGate?.ok).toBe(true)
  })

  it('apply deletes every present row when the dreame gate passes', async () => {
    const hub = fakeHub()
    const out = await deleteEntriesLeftovers(hub, { apply: true })
    expect(out.status).toBe('done')
    if (out.status !== 'done') throw new Error('unreachable')
    expect(out.deleted).toBe(out.present)
    expect(hub.rows.size).toBe(0)
    expect(JSON.stringify(out)).not.toContain(CANARY)
  })

  it('apply refuses when the dreame legacy row exists but the gate fails', async () => {
    const hub = fakeHub()
    hub.settingsPassword = CANARY
    const out = await deleteEntriesLeftovers(hub, { apply: true })
    expect(out.status).toBe('skipped')
    expect(hub.deleted).toEqual([])
    expect(hub.rows.has(DREAME_LEGACY_BROKERS_KEY)).toBe(true)
  })

  it('apply skips the dreame gate when the legacy brokers row is already gone', async () => {
    const hub = fakeHub()
    hub.rows.delete(DREAME_LEGACY_BROKERS_KEY)
    hub.settingsPassword = CANARY
    const out = await deleteEntriesLeftovers(hub, { apply: true })
    expect(out.status).toBe('done')
    expect(out.dreameGate).toBeUndefined()
    expect(hub.deleted.length).toBeGreaterThan(0)
  })
})
