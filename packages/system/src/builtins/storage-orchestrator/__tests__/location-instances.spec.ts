import type { StorageLocation, StorageLocationDeclaration } from '@camstack/types'
import { REDACTED_SECRET } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type LocationSaveInput,
  providerSections,
  StorageLocationInstances,
} from '../location-instances.js'
import type { StorageProviderListEntry } from '../provider-discovery.js'

const DECLARATIONS: readonly StorageLocationDeclaration[] = [
  {
    id: 'recordings',
    displayName: 'Recordings',
    cardinality: 'multi',
    access: 'local-path',
  },
  {
    id: 'backups',
    displayName: 'Backups',
    cardinality: 'multi',
    access: 'local-path',
  },
]

const SFTP: StorageProviderListEntry = {
  providerId: 'sftp-storage',
  displayName: 'SFTP',
  nodeLocal: false,
  shouldSaveDiskSpace: false,
  minFreePercent: null,
  configSchema: {
    sections: [
      {
        id: 'conn',
        title: 'Connection',
        fields: [
          { type: 'text', key: 'host', label: 'Host' },
          {
            type: 'select',
            key: 'authMethod',
            label: 'Auth',
            options: [
              { value: 'password', label: 'Password' },
              { value: 'privateKey', label: 'Key' },
            ],
          },
          {
            type: 'password',
            key: 'password',
            label: 'Password',
            showWhen: { field: 'authMethod', equals: 'password' },
          },
        ],
      },
    ],
  },
}
const WEBDAV: StorageProviderListEntry = {
  providerId: 'webdav-storage',
  displayName: 'WebDAV',
  nodeLocal: false,
  shouldSaveDiskSpace: false,
  minFreePercent: null,
  configSchema: {
    sections: [
      {
        id: 'conn',
        title: 'Connection',
        fields: [
          {
            type: 'select',
            key: 'authMethod',
            label: 'Auth',
            options: [
              { value: 'basic', label: 'Basic' },
              { value: 'token', label: 'Token' },
            ],
          },
          {
            type: 'password',
            key: 'password',
            label: 'Password',
            showWhen: { field: 'authMethod', notEquals: 'token' },
          },
        ],
      },
    ],
  },
}
const FS: StorageProviderListEntry = {
  providerId: 'filesystem-storage',
  displayName: 'Filesystem',
  nodeLocal: true,
  shouldSaveDiskSpace: true,
  minFreePercent: 10,
  configSchema: {
    sections: [
      {
        id: 'fs',
        title: 'Filesystem',
        fields: [{ type: 'text', key: 'basePath', label: 'Base path', required: true }],
      },
    ],
  },
}

function location(over: Partial<StorageLocation> & Pick<StorageLocation, 'id'>): StorageLocation {
  return {
    type: over.id.split(':')[0] ?? 'recordings',
    displayName: 'Place',
    providerId: 'sftp-storage',
    config: {},
    isSystem: false,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function harness(initial: readonly StorageLocation[] = []) {
  const rows = [...initial]
  const saves: Array<{ input: LocationSaveInput; clear: readonly string[] }> = []
  const removes: string[] = []
  const instances = new StorageLocationInstances({
    locations: () => rows,
    declarations: () => DECLARATIONS,
    providers: async () => [FS, SFTP, WEBDAV],
    save: async (input, clear) => {
      saves.push({ input, clear })
      const saved = { ...input, createdAt: 1, updatedAt: 2 }
      const at = rows.findIndex((r) => r.id === input.id)
      if (at >= 0) rows[at] = saved
      else rows.push(saved)
      return saved
    },
    remove: async (id) => {
      removes.push(id)
    },
    probe: async () => ({ ok: true }),
    secretKeys: (providerId) => new Set(providerId === 'filesystem-storage' ? [] : ['password']),
    testTimeoutMs: 50,
  })
  return { instances, rows, saves, removes }
}

afterEach(() => vi.useRealTimers())

describe('storage location instances', () => {
  it('serves one kind per declared location type, of the storage function cap', async () => {
    const { instances } = harness()
    const description = await instances.describe()
    expect(description.kinds?.map((k) => [k.id, k.functionCap])).toEqual([
      ['recordings', 'storage'],
      ['backups', 'storage'],
    ])
    expect(description.mintsId).toBe(true)
    // Every kind names the path browser, which the admin UI maps to a widget.
    expect(description.kinds?.every((k) => k.widgets?.[0]?.id === 'storage/path-browser')).toBe(
      true,
    )
  })

  it('create asks for the state (active or read-only, active by default); edit never does', async () => {
    const { instances } = harness([location({ id: 'backups:nas' })])
    const fieldsOf = (schema: { sections: readonly { fields: readonly { key: string }[] }[] }) =>
      schema.sections.flatMap((s) => s.fields)
    const created = fieldsOf(await instances.instanceFormSchema({ id: null }))
    expect(created.find((f) => f.key === 'mode')).toMatchObject({
      type: 'select',
      default: 'active',
      options: [{ value: 'active' }, { value: 'readonly' }],
    })
    const edited = fieldsOf(await instances.instanceFormSchema({ id: 'backups:nas' }))
    expect(edited.map((f) => f.key)).not.toContain('mode')
  })

  it('creates under a minted <kind>:<slug> id and keeps only the chosen provider fields', async () => {
    const { instances, saves } = harness([location({ id: 'backups:nas' })])
    const { id } = await instances.createInstance({
      name: 'Nas',
      kind: 'backups',
      values: {
        providerId: 'sftp-storage',
        'sftp-storage.host': 'nas.lan',
        'sftp-storage.password': 'hunter2',
        'webdav-storage.authMethod': 'token',
        minFreePercent: 15,
      },
    })
    expect(id).toBe('backups:nas-2')
    expect(saves[0]?.input).toMatchObject({
      id: 'backups:nas-2',
      type: 'backups',
      providerId: 'sftp-storage',
      config: { host: 'nas.lan', password: 'hunter2', minFreePercent: 15 },
    })
    expect(saves[0]?.input.config).not.toHaveProperty('authMethod')
  })

  it('refuses a kind nobody declared and an id of another kind', async () => {
    const { instances } = harness()
    await expect(
      instances.createInstance({
        name: 'x',
        kind: 'nope',
        values: { providerId: 'sftp-storage' },
      }),
    ).rejects.toThrow(/unknown location kind/)
    await expect(
      instances.createInstance({
        id: 'logs:x',
        name: 'x',
        kind: 'backups',
        values: { providerId: 'sftp-storage' },
      }),
    ).rejects.toThrow(/id must be/)
  })

  it('shows a stored credential as a view, never text', async () => {
    const { instances } = harness([
      location({
        id: 'backups:nas',
        config: {
          host: 'h',
          password: { $secret: 'secret://x' },
          readOnly: true,
        },
      }),
    ])
    const [row] = await instances.listInstances()
    expect(row?.formValues['host']).toBe('h')
    expect(row?.formValues['password']).toMatchObject({ set: true, v: 1 })
    expect(row?.formValues).not.toHaveProperty('readOnly')
    expect(JSON.stringify(row)).not.toContain('hunter2')
  })

  it('keeps a credential the form sends back as a view or the token, replaces and clears on request', async () => {
    const stored = location({
      id: 'backups:nas',
      config: { host: 'h', password: { $secret: 'secret://x' } },
    })
    const kept = harness([stored])
    await kept.instances.updateInstance({
      id: 'backups:nas',
      values: { host: 'h2', password: REDACTED_SECRET },
    })
    expect(kept.saves[0]?.input.config).toEqual({
      host: 'h2',
      password: { $secret: 'secret://x' },
    })
    expect(kept.saves[0]?.clear).toEqual([])

    const replaced = harness([stored])
    await replaced.instances.updateInstance({
      id: 'backups:nas',
      values: { password: 'new' },
    })
    expect(replaced.saves[0]?.input.config['password']).toBe('new')

    const cleared = harness([stored])
    await cleared.instances.updateInstance({
      id: 'backups:nas',
      values: { password: { $secretClear: true } },
    })
    expect(cleared.saves[0]?.clear).toEqual(['password'])
  })

  it('rebuilds the WHOLE location on an edit: the node and the provider are not lost', async () => {
    const { instances, saves } = harness([
      location({
        id: 'recordings:disk',
        providerId: 'filesystem-storage',
        nodeId: 'agent-1',
        config: { basePath: '/x' },
      }),
    ])
    await instances.updateInstance({
      id: 'recordings:disk',
      name: 'Disk',
      values: {},
    })
    expect(saves[0]?.input).toMatchObject({
      providerId: 'filesystem-storage',
      nodeId: 'agent-1',
      displayName: 'Disk',
      config: { basePath: '/x' },
    })
  })

  it('maps the row switch to the one typed state', async () => {
    const { instances, saves } = harness([
      location({ id: 'recordings:a', mode: 'active' }),
      location({ id: 'recordings:b', mode: 'drain' }),
      location({ id: 'recordings:c', mode: 'disabled' }),
      location({ id: 'recordings:d', mode: 'readonly' }),
    ])
    await instances.setInstanceEnabled({ id: 'recordings:a', enabled: false })
    await instances.setInstanceEnabled({ id: 'recordings:b', enabled: false })
    await instances.setInstanceEnabled({ id: 'recordings:c', enabled: false })
    expect(saves.map((s) => [s.input.id, s.input.mode])).toEqual([['recordings:a', 'readonly']])
    await instances.setInstanceEnabled({ id: 'recordings:c', enabled: true })
    await instances.setInstanceEnabled({ id: 'recordings:d', enabled: true })
    expect(saves.map((s) => [s.input.id, s.input.mode])).toEqual([
      ['recordings:a', 'readonly'],
      ['recordings:c', 'active'],
      ['recordings:d', 'active'],
    ])
    const view = await instances.getInstance({ id: 'recordings:b' })
    expect(view?.enabled).toBe(false)
  })

  it('refuses to cancel a drain through the switch', async () => {
    const { instances, saves } = harness([location({ id: 'recordings:b', mode: 'drain' })])
    await expect(
      instances.setInstanceEnabled({ id: 'recordings:b', enabled: true }),
    ).rejects.toThrow(/draining/)
    expect(saves).toEqual([])
  })

  it('round-trips minFreePercent through an update: changed when sent, kept when not', async () => {
    const { instances, saves } = harness([
      location({ id: 'recordings:a', config: { basePath: '/x', minFreePercent: 10 } }),
    ])
    await instances.updateInstance({ id: 'recordings:a', values: { minFreePercent: 25 } })
    expect(saves[0]?.input.config).toMatchObject({ basePath: '/x', minFreePercent: 25 })
    await instances.updateInstance({ id: 'recordings:a', values: {} })
    expect(saves[1]?.input.config).toMatchObject({ basePath: '/x', minFreePercent: 25 })
    await instances.updateInstance({ id: 'recordings:a', values: { minFreePercent: null } })
    expect(saves[2]?.input.config).toEqual({ basePath: '/x' })
  })

  it('deletes through the refusing path, never forced', async () => {
    const { instances, removes } = harness([location({ id: 'recordings:a' })])
    await instances.deleteInstance({ id: 'recordings:a' })
    expect(removes).toEqual(['recordings:a'])
  })

  it('answers a probe that never returns as inconclusive, within its bound', async () => {
    vi.useFakeTimers()
    const instances = new StorageLocationInstances({
      locations: () => [],
      declarations: () => DECLARATIONS,
      providers: async () => [SFTP],
      save: async () => {
        throw new Error('unused')
      },
      remove: async () => {},
      probe: () => new Promise(() => {}),
      secretKeys: () => new Set(),
      testTimeoutMs: 50,
    })
    const pending = instances.testInstance({
      id: null,
      kind: 'backups',
      values: { providerId: 'sftp-storage', 'sftp-storage.host': 'h' },
    })
    await vi.advanceTimersByTimeAsync(60)
    await expect(pending).resolves.toMatchObject({
      success: false,
      status: 'inconclusive',
    })
  })

  it('tests a stored location with the credential it holds, a refusal being rejected', async () => {
    const probe = vi.fn(async () => ({ ok: false, error: 'bad password' }))
    const stored = location({
      id: 'backups:nas',
      config: { password: { $secret: 'secret://x' } },
    })
    const instances = new StorageLocationInstances({
      locations: () => [stored],
      declarations: () => DECLARATIONS,
      providers: async () => [SFTP],
      save: async () => stored,
      remove: async () => {},
      probe,
      secretKeys: () => new Set(['password']),
    })
    const result = await instances.testInstance({
      id: 'backups:nas',
      values: {},
    })
    expect(result).toMatchObject({
      success: false,
      status: 'rejected',
      error: 'bad password',
    })
    expect(probe).toHaveBeenCalledWith('sftp-storage', {
      password: { $secret: 'secret://x' },
    })
  })

  describe('forms', () => {
    it('create: every provider has its own key space and is shown for that provider only', async () => {
      const { instances } = harness()
      const form = await instances.instanceFormSchema({
        id: null,
        kind: 'backups',
      })
      const fields = form.sections.flatMap((s) => s.fields)
      const byKey = new Map(fields.map((f) => [f.key, f]))
      expect(byKey.get('sftp-storage.host')).toMatchObject({
        showWhen: { field: 'providerId', equals: 'sftp-storage' },
      })
      expect(byKey.get('webdav-storage.authMethod')).toBeDefined()
      // The negation on the selector is rewritten: another provider's unset selector must not satisfy it.
      expect(byKey.get('webdav-storage.password')).toMatchObject({
        showWhen: { field: 'webdav-storage.authMethod', in: ['basic'] },
      })
      expect(byKey.get('sftp-storage.password')).toMatchObject({
        showWhen: { field: 'sftp-storage.authMethod', equals: 'password' },
      })
      expect(byKey.get('nodeId')).toMatchObject({
        showWhen: { field: 'providerId', in: ['filesystem-storage'] },
      })
      expect(byKey.get('mode')).toMatchObject({ default: 'active' })
    })

    it('edit: the provider schema as it is, plus the node and the protection', async () => {
      const { instances } = harness([location({ id: 'backups:nas' })])
      const form = await instances.instanceFormSchema({ id: 'backups:nas' })
      const keys = form.sections.flatMap((s) => s.fields.map((f) => f.key))
      expect(keys).toEqual(
        expect.arrayContaining(['host', 'authMethod', 'password', 'minFreePercent']),
      )
      // The state is the page's own control, never a field of the form.
      expect(keys).not.toContain('mode')
      expect(keys).not.toContain('sftp-storage.host')
    })

    it('a configSchema that is not a form yields no sections', () => {
      expect(providerSections(undefined)).toEqual([])
      expect(providerSections({ sections: 'x' })).toEqual([])
    })
  })
})
