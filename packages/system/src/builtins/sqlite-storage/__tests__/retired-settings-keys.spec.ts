import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  planNestedRetiredKeyPurge,
  planRetiredKeyPurge,
  purgeRetiredSettingsKeys,
  purgeRetiredSettingsRows,
  RETIRED_SETTINGS_KEYS,
  type RetiredKeySpec,
  type RetiredKeyStore,
  type RetiredRowSpec,
  type RetiredRowStore,
  retiredKeyStoreOf,
  settingsStoreIsAuthoritativeHere,
} from '../retired-settings-keys.js'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'

const makeTestLogger = () => ({ info: vi.fn(), warn: vi.fn() })

const DETECTION_SPEC: RetiredKeySpec = {
  namespace: 'test-addon',
  collection: 'addon-settings',
  row: 'root',
  keys: ['deadExact'],
  perNodeKeys: ['deadPerNode'],
  reason: 'test',
}

/** A map-shaped row: `{ [deviceId]: PersistedDeviceMeta }`. */
const DEVICE_META_SPEC: RetiredKeySpec = {
  namespace: 'test-device-manager',
  collection: 'addon-settings',
  row: 'deviceMeta',
  keys: [],
  perNodeKeys: [],
  mapValueKeys: ['deviceLinks'],
  reason: 'test',
}

function makeStore(
  initial: Record<string, Record<string, unknown>>,
  counts: Record<string, number> = {},
): RetiredKeyStore & RetiredRowStore & { readonly rows: Record<string, Record<string, unknown>> } {
  const rows = { ...initial }
  const rowKey = (spec: { namespace?: string; collection: string; row: string }): string =>
    `${spec.namespace}/${spec.collection}/${spec.row}`
  return {
    rows,
    async read(spec) {
      return rows[rowKey(spec)] ?? null
    },
    async write(spec, value) {
      rows[rowKey(spec)] = value
    },
    async hasRow(spec: RetiredRowSpec) {
      return rows[rowKey(spec)] !== undefined
    },
    async deleteRow(spec: RetiredRowSpec) {
      delete rows[rowKey(spec)]
    },
    async countRows(collection: string) {
      return counts[collection] ?? 0
    },
  }
}

describe('planRetiredKeyPurge', () => {
  it('names the exact retired keys present, and nothing else', () => {
    const found = planRetiredKeyPurge(
      { deadExact: 1, keepMe: 2, notDeadExact: 3, deadExactExtra: 4 },
      DETECTION_SPEC,
    )
    expect(found).toEqual(['deadExact'])
  })

  it('matches a per-node key both bare and `@node`-suffixed', () => {
    const found = planRetiredKeyPurge(
      {
        deadPerNode: 'a',
        'deadPerNode@hub': 'b',
        'deadPerNode@agent-a': 'c',
        deadPerNodeOther: 'keep',
        'somethingdeadPerNode@hub': 'keep',
      },
      DETECTION_SPEC,
    )
    expect([...found].sort()).toEqual(['deadPerNode', 'deadPerNode@agent-a', 'deadPerNode@hub'])
  })

  it('is empty on a clean blob (idempotence premise)', () => {
    expect(planRetiredKeyPurge({ keepMe: 1 }, DETECTION_SPEC)).toEqual([])
  })

  it('does NOT substring-match a live key that CONTAINS a retired key', () => {
    // `videoPipelineSteps` is the live sibling of the retired `pipelineSteps`;
    // it only escapes a naive `includes` by capitalisation, so this pins the
    // rule with fixtures that contain the retired key verbatim too.
    const spec: RetiredKeySpec = { ...DETECTION_SPEC, keys: ['pipelineSteps'], perNodeKeys: [] }
    expect(
      planRetiredKeyPurge(
        {
          videoPipelineSteps: 'live',
          'legacy.pipelineSteps': 'live',
          pipelineStepsV2: 'live',
        },
        spec,
      ),
    ).toEqual([])
  })
})

describe('purgeRetiredSettingsKeys', () => {
  it('rewrites the row without the retired keys and logs once, with key/row/addon', async () => {
    const store = makeStore({
      'test-addon/addon-settings/root': {
        deadExact: 1,
        'deadPerNode@hub': 2,
        keepMe: 'live',
      },
    })
    const log = makeTestLogger()
    const result = await purgeRetiredSettingsKeys(store, log, [DETECTION_SPEC])

    expect(store.rows['test-addon/addon-settings/root']).toEqual({ keepMe: 'live' })
    expect(result).toEqual([
      {
        addon: 'test-addon',
        collection: 'addon-settings',
        row: 'root',
        keys: ['deadExact', 'deadPerNode@hub'],
        nested: [],
      },
    ])
    expect(log.info).toHaveBeenCalledTimes(1)
    const [message, payload] = log.info.mock.calls[0] ?? []
    expect(String(message)).toContain('retired settings keys')
    expect(payload).toMatchObject({
      meta: {
        addon: 'test-addon',
        collection: 'addon-settings',
        row: 'root',
        keys: ['deadExact', 'deadPerNode@hub'],
      },
    })
  })

  it('is silent and writes nothing when the row is already clean', async () => {
    const store = makeStore({ 'test-addon/addon-settings/root': { keepMe: 'live' } })
    const writeSpy = vi.spyOn(store, 'write')
    const log = makeTestLogger()

    const result = await purgeRetiredSettingsKeys(store, log, [DETECTION_SPEC])

    expect(result).toEqual([])
    expect(writeSpy).not.toHaveBeenCalled()
    expect(log.info).not.toHaveBeenCalled()
  })

  it('is silent when the row does not exist at all', async () => {
    const store = makeStore({})
    const writeSpy = vi.spyOn(store, 'write')
    const log = makeTestLogger()

    expect(await purgeRetiredSettingsKeys(store, log, [DETECTION_SPEC])).toEqual([])
    expect(writeSpy).not.toHaveBeenCalled()
    expect(log.info).not.toHaveBeenCalled()
  })

  it('converges: a second pass over the same store is a no-op', async () => {
    const store = makeStore({
      'test-addon/addon-settings/root': { deadExact: 1, keepMe: 'live' },
    })
    const log = makeTestLogger()
    await purgeRetiredSettingsKeys(store, log, [DETECTION_SPEC])
    const second = await purgeRetiredSettingsKeys(store, log, [DETECTION_SPEC])
    expect(second).toEqual([])
    expect(log.info).toHaveBeenCalledTimes(1)
  })

  it('a failing read never writes — a read fault must not destroy the row', async () => {
    const store: RetiredKeyStore = {
      read: async () => {
        throw new Error('transport down')
      },
      write: vi.fn(),
    }
    const log = makeTestLogger()
    expect(await purgeRetiredSettingsKeys(store, log, [DETECTION_SPEC])).toEqual([])
    expect(store.write).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledTimes(1)
  })
})

describe('RETIRED_SETTINGS_KEYS registry', () => {
  it('retires the detection-pipeline engine cascade and the global step seed', () => {
    const spec = RETIRED_SETTINGS_KEYS.find((s) => s.namespace === 'detection-pipeline')
    expect(spec).toBeDefined()
    if (!spec) return
    expect(spec.collection).toBe('addon-settings')
    expect(spec.row).toBe('root')
    expect([...spec.keys].sort()).toEqual(['pipelineEngine', 'pipelineSteps'])
    expect([...spec.perNodeKeys].sort()).toEqual([
      'engineBackend',
      'engineDevice',
      'engineRuntime',
      'probedBestEngine',
    ])
  })

  it('never retires a key the live per-camera path still writes', () => {
    const live = [
      'videoPipelineSteps',
      'pipelineTemplates',
      'stepToggles',
      'cameraSettings',
      // The recorder's OWN placement blob. The 2026-08-28 census listed it as
      // an orphan; it is not — `placement-store.ts` reads and writes it through
      // a DurableState on every writer run, and `retired-root-keys.ts` says so
      // in as many words. Pinned here so a future retirement pass cannot take
      // the fleet's storage assignments with it.
      'recordingPlacement',
    ]
    for (const spec of RETIRED_SETTINGS_KEYS) {
      for (const key of live) {
        expect(planRetiredKeyPurge({ [key]: 'live' }, spec)).toEqual([])
      }
    }
  })

  it('retires the decoder `backend` per-node, and the probe residue bare-only', () => {
    // `perNodeKeys` matches `<key>@<nodeId>` too; `keys` does not. Which list a
    // name goes in is a data-loss decision, so it is asserted, not assumed.
    const orchestrator = RETIRED_SETTINGS_KEYS.find((s) => s.namespace === 'pipeline-orchestrator')
    expect(orchestrator?.perNodeKeys).toEqual(['backend'])

    for (const namespace of ['audio-analyzer', 'decoder-nodeav']) {
      const spec = RETIRED_SETTINGS_KEYS.find((s) => s.namespace === namespace)
      expect(spec).toBeDefined()
      expect(spec?.perNodeKeys).toEqual([])
    }

    const audio = RETIRED_SETTINGS_KEYS.find((s) => s.namespace === 'audio-analyzer')
    expect(audio).toBeDefined()
    if (!audio) return
    expect(planRetiredKeyPurge({ 'probedBestAudioBackend@hub': 'x' }, audio)).toEqual([])
    expect(planRetiredKeyPurge({ probedBestAudioBackend: 'x' }, audio)).toEqual([
      'probedBestAudioBackend',
    ])
  })

  it('declares no duplicate (namespace, collection, row) target', () => {
    const seen = RETIRED_SETTINGS_KEYS.map((s) => `${s.namespace}/${s.collection}/${s.row}`)
    expect(new Set(seen).size).toBe(seen.length)
  })
})

describe('against a real SqliteSettingsBackend', () => {
  let dir = ''
  let backend: SqliteSettingsBackend

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-keys-'))
    backend = new SqliteSettingsBackend(path.join(dir, 'camstack.db'))
    await backend.initialize()
  })

  afterEach(async () => {
    await backend.shutdown()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('purges the live-shaped detection-pipeline row and leaves the live keys', async () => {
    // The exact row shape read off the production hub on 2026-08-07.
    await backend.set({
      namespace: 'detection-pipeline',
      collection: 'addon-settings',
      key: 'root',
      value: {
        'probedBestEngine@hub': 'openvino/auto',
        'engineBackend@hub': 'auto',
        'engineDevice@hub': 'auto',
        'probedBestEngine@agent-a': 'openvino/auto',
        'engineBackend@agent-a': 'auto',
        'engineDevice@agent-a': 'auto',
        pipelineSteps: '[{"addonId":"object-detection","modelId":"yolo26m-256"}]',
        pipelineEngine: null,
        pipelineTemplates: '[]',
        videoPipelineSteps: { motion: true },
      },
    })
    const log = { info: vi.fn(), warn: vi.fn() }

    const first = await purgeRetiredSettingsKeys(retiredKeyStoreOf(backend), log)
    expect(first).toHaveLength(1)
    expect(first[0]?.keys).toHaveLength(8)

    const after = await backend.get({
      namespace: 'detection-pipeline',
      collection: 'addon-settings',
      key: 'root',
    })
    expect(after).toEqual({ pipelineTemplates: '[]', videoPipelineSteps: { motion: true } })

    // Converges: a restart re-runs the purge and finds nothing.
    log.info.mockClear()
    expect(await purgeRetiredSettingsKeys(retiredKeyStoreOf(backend), log)).toEqual([])
    expect(log.info).not.toHaveBeenCalled()
  })

  it('purges the orchestrator role residue AND every `backend@<node>` copy', async () => {
    // The five pre-singleton role lists plus the decoder selector, in the shape
    // the census read off the hub on 2026-08-28. `clusterRoles`, `fpsMinThreshold`
    // and `nativeLeaseActivityMs` are the LIVE keys that must survive.
    await backend.set({
      namespace: 'pipeline-orchestrator',
      collection: 'addon-settings',
      key: 'root',
      value: {
        enabledNodes: ['hub', 'agent-a'],
        enabledDecoderNodes: ['hub'],
        enabledAudioNodes: ['hub'],
        remoteSourcingNodes: [],
        nativeLeaseTtlMs: 1200,
        'backend@hub': 'nodeav',
        'backend@agent-a': 'ffmpeg',
        backend: 'nodeav',
        clusterRoles: { ingestNode: 'hub' },
        nativeLeaseActivityMs: 45_000,
        fpsMinThreshold: 2,
      },
    })
    const log = { info: vi.fn(), warn: vi.fn() }

    const purged = await purgeRetiredSettingsKeys(retiredKeyStoreOf(backend), log)
    expect(purged).toHaveLength(1)
    expect([...(purged[0]?.keys ?? [])].toSorted()).toEqual([
      'backend',
      'backend@agent-a',
      'backend@hub',
      'enabledAudioNodes',
      'enabledDecoderNodes',
      'enabledNodes',
      'nativeLeaseTtlMs',
      'remoteSourcingNodes',
    ])
    // The delete is LOGGED — this removes operator data.
    expect(log.info).toHaveBeenCalledTimes(1)

    expect(
      await backend.get({
        namespace: 'pipeline-orchestrator',
        collection: 'addon-settings',
        key: 'root',
      }),
    ).toEqual({
      clusterRoles: { ingestNode: 'hub' },
      nativeLeaseActivityMs: 45_000,
      fpsMinThreshold: 2,
    })
  })

  it('takes the BARE probe residue and leaves every node its own scoped probe', async () => {
    // The whole reason `probedBestAudioBackend` is under `keys` and not
    // `perNodeKeys`: the bare key is unreachable residue, but each
    // `@<nodeId>` copy is that node's live probe result. Retiring it per-node
    // would wipe every node's probe on the next hub boot.
    await backend.set({
      namespace: 'audio-analyzer',
      collection: 'addon-settings',
      key: 'root',
      value: {
        probedBestAudioBackend: 'stale-bare-probe',
        'probedBestAudioBackend@hub': 'apple-soundanalysis',
        'probedBestAudioBackend@agent-a': 'yamnet-onnx',
        selectedAudioModel: 'yamnet-onnx',
        audioBackend: 'auto',
      },
    })
    const log = { info: vi.fn(), warn: vi.fn() }

    await purgeRetiredSettingsKeys(retiredKeyStoreOf(backend), log)

    expect(
      await backend.get({
        namespace: 'audio-analyzer',
        collection: 'addon-settings',
        key: 'root',
      }),
    ).toEqual({
      'probedBestAudioBackend@hub': 'apple-soundanalysis',
      'probedBestAudioBackend@agent-a': 'yamnet-onnx',
      audioBackend: 'auto',
    })
  })

  it('is silent on a store that never held the dead keys', async () => {
    const log = { info: vi.fn(), warn: vi.fn() }
    expect(await purgeRetiredSettingsKeys(retiredKeyStoreOf(backend), log)).toEqual([])
    expect(log.info).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
  })
})

describe('settingsStoreIsAuthoritativeHere', () => {
  // The addon-settings store is hub-central: `settings-store` is a singleton cap
  // that resolves to the hub, so every node's `ctx.settings` reads and writes the
  // HUB's rows. An agent's own sqlite file holds only node-local collections
  // (`platform-probe`, `metrics-native`, `hub-forwarder`) — verified 2026-08-07,
  // neither agent even has a `detection-pipeline:addon-settings` table. So the
  // purge has exactly one place to run.

  it('runs on the hub', () => {
    expect(settingsStoreIsAuthoritativeHere({ CAMSTACK_ROLE: 'hub' })).toBe(true)
  })

  it('runs when the role is unset — the launcher default is hub', () => {
    expect(settingsStoreIsAuthoritativeHere({})).toBe(true)
    expect(settingsStoreIsAuthoritativeHere({ CAMSTACK_ROLE: '' })).toBe(true)
  })

  it('does NOT run on an agent, in any casing or padding', () => {
    expect(settingsStoreIsAuthoritativeHere({ CAMSTACK_ROLE: 'agent' })).toBe(false)
    expect(settingsStoreIsAuthoritativeHere({ CAMSTACK_ROLE: 'AGENT' })).toBe(false)
    expect(settingsStoreIsAuthoritativeHere({ CAMSTACK_ROLE: '  agent  ' })).toBe(false)
  })

  it('does NOT run on an unrecognised role — skipping is the safe direction', () => {
    // `resolveNodeRole` throws on garbage and the launcher would already have
    // died. If somehow reached, a purge that does nothing is recoverable; a
    // purge that runs where it must not is not.
    expect(settingsStoreIsAuthoritativeHere({ CAMSTACK_ROLE: 'satellite' })).toBe(false)
  })
})

describe('purgeRetiredSettingsKeys — off the authoritative node', () => {
  it('does not read, does not write, and says NOTHING on an agent', async () => {
    const store: RetiredKeyStore = { read: vi.fn(), write: vi.fn() }
    const log = { info: vi.fn(), warn: vi.fn() }

    const result = await purgeRetiredSettingsKeys(store, log, RETIRED_SETTINGS_KEYS, {
      CAMSTACK_ROLE: 'agent',
    })

    expect(result).toEqual([])
    expect(store.read).not.toHaveBeenCalled()
    expect(store.write).not.toHaveBeenCalled()
    // No "skipped" line: this fires on every agent boot forever and would be
    // pure noise about work that has no reason to happen here.
    expect(log.info).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('still purges on the hub with a dirty row', async () => {
    const store = makeStore({
      'test-addon/addon-settings/root': { deadExact: 1, keepMe: 'live' },
    })
    const log = { info: vi.fn(), warn: vi.fn() }

    const result = await purgeRetiredSettingsKeys(store, log, [DETECTION_SPEC], {
      CAMSTACK_ROLE: 'hub',
    })

    expect(result).toHaveLength(1)
    expect(store.rows['test-addon/addon-settings/root']).toEqual({ keepMe: 'live' })
  })
})

describe('planNestedRetiredKeyPurge — a key of the map VALUE, not of the row', () => {
  it('names `<deviceId>.deviceLinks` for every device that carries one', () => {
    const found = planNestedRetiredKeyPurge(
      {
        '1023': { id: 1023, stableId: 'nc-alarm-panel' },
        '1026': { id: 1026, deviceLinks: [{ id: 'battery-percentage' }] },
        '319': { id: 319, deviceLinks: [] },
      },
      DEVICE_META_SPEC,
    )
    expect([...found].sort()).toEqual(['1026.deviceLinks', '319.deviceLinks'])
  })

  it('finds nothing on a flat spec — nested purging is opt-in per row', () => {
    expect(planNestedRetiredKeyPurge({ a: { deviceLinks: [] } }, DETECTION_SPEC)).toEqual([])
  })

  it('skips a value that is not an object rather than rewriting it', () => {
    expect(planNestedRetiredKeyPurge({ a: 7, b: null, c: 'x' }, DEVICE_META_SPEC)).toEqual([])
  })
})

describe('purgeRetiredSettingsKeys — nested rows', () => {
  it('deletes only the retired key, leaving every other field of the device intact', async () => {
    const store = makeStore({
      'test-device-manager/addon-settings/deviceMeta': {
        '1026': {
          id: 1026,
          stableId: 'ha:x:dev:1',
          name: 'Doorbell',
          deviceLinks: [{ id: 'battery-percentage' }],
        },
        '1023': { id: 1023, stableId: 'nc-alarm-panel', name: 'Alarm' },
      },
    })
    const log = { info: vi.fn(), warn: vi.fn() }

    const result = await purgeRetiredSettingsKeys(store, log, [DEVICE_META_SPEC], {
      CAMSTACK_ROLE: 'hub',
    })

    expect(result[0]?.nested).toEqual(['1026.deviceLinks'])
    expect(store.rows['test-device-manager/addon-settings/deviceMeta']).toEqual({
      '1026': { id: 1026, stableId: 'ha:x:dev:1', name: 'Doorbell' },
      '1023': { id: 1023, stableId: 'nc-alarm-panel', name: 'Alarm' },
    })
    expect(log.info).toHaveBeenCalledOnce()
  })

  it('a clean row writes nothing and says nothing — this is the steady state', async () => {
    const store = makeStore({
      'test-device-manager/addon-settings/deviceMeta': {
        '1023': { id: 1023, name: 'Alarm' },
      },
    })
    const writeSpy = vi.spyOn(store, 'write')
    const log = { info: vi.fn(), warn: vi.fn() }

    const result = await purgeRetiredSettingsKeys(store, log, [DEVICE_META_SPEC], {
      CAMSTACK_ROLE: 'hub',
    })

    expect(result).toEqual([])
    expect(writeSpy).not.toHaveBeenCalled()
    expect(log.info).not.toHaveBeenCalled()
  })

  it('the SHIPPED key registry no longer targets the device-manager blob', () => {
    // It used to retire `deviceLinks` from inside `deviceMeta` — and it aimed
    // at `device-manager:addon-settings`, a table the device-manager has never
    // written: as a HUB BUILTIN its `ctx.settings` is `ConfigManager`'s view
    // (`getAllAddon` / `setAllAddon`), one row per key in the UNSCOPED
    // `addon-settings`. Measured on the 2026-08-19 evidence copy: the scoped
    // table is empty and `addon-settings` holds all six device-manager keys, so
    // that spec was a no-op on every hub that ever ran it. The blob it aimed at
    // is now retired WHOLE — see `RETIRED_SETTINGS_ROWS`.
    expect(RETIRED_SETTINGS_KEYS.some((s) => s.namespace === 'device-manager')).toBe(false)
  })
})

// ── row retirement ──────────────────────────────────────────────────────────

const DEVICE_META_ROW: RetiredRowSpec = {
  collection: 'addon-settings',
  row: 'device-manager.deviceMeta',
  owner: 'device-manager',
  evidence: { collection: 'device-manager:devices' },
  reason: 'test',
}

describe('purgeRetiredSettingsRows', () => {
  it('deletes the row once its successor collection is populated', async () => {
    const store = makeStore(
      { 'undefined/addon-settings/device-manager.deviceMeta': { '101': { id: 101 } } },
      { 'device-manager:devices': 974 },
    )
    const log = makeTestLogger()

    const result = await purgeRetiredSettingsRows(store, log, [DEVICE_META_ROW])

    expect(result).toEqual([
      {
        owner: 'device-manager',
        collection: 'addon-settings',
        row: 'device-manager.deviceMeta',
      },
    ])
    expect(store.rows['undefined/addon-settings/device-manager.deviceMeta']).toBeUndefined()
    expect(log.info).toHaveBeenCalledTimes(1)
  })

  it('REFUSES while the successor is empty — the migration has not run here', async () => {
    // This is the only thing standing between a hub that boots the new code
    // before the offline migration and losing its entire fleet.
    const store = makeStore(
      { 'undefined/addon-settings/device-manager.deviceMeta': { '101': { id: 101 } } },
      { 'device-manager:devices': 0 },
    )
    const log = makeTestLogger()

    expect(await purgeRetiredSettingsRows(store, log, [DEVICE_META_ROW])).toEqual([])
    expect(store.rows['undefined/addon-settings/device-manager.deviceMeta']).toBeDefined()
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('treats an unreadable successor exactly like an empty one', async () => {
    const store: RetiredRowStore = {
      hasRow: async () => true,
      deleteRow: vi.fn(),
      countRows: async () => {
        throw new Error('transport down')
      },
    }
    const log = makeTestLogger()

    expect(await purgeRetiredSettingsRows(store, log, [DEVICE_META_ROW])).toEqual([])
    expect(store.deleteRow).not.toHaveBeenCalled()
  })

  it('is silent and idempotent once the row is gone', async () => {
    const store = makeStore({}, { 'device-manager:devices': 974 })
    const log = makeTestLogger()

    expect(await purgeRetiredSettingsRows(store, log, [DEVICE_META_ROW])).toEqual([])
    expect(log.info).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('does nothing and says nothing off the authoritative node', async () => {
    const store = makeStore(
      { 'undefined/addon-settings/device-manager.deviceMeta': { '101': { id: 101 } } },
      { 'device-manager:devices': 974 },
    )
    const log = makeTestLogger()

    const result = await purgeRetiredSettingsRows(store, log, [DEVICE_META_ROW], {
      CAMSTACK_ROLE: 'agent',
    })

    expect(result).toEqual([])
    expect(store.rows['undefined/addon-settings/device-manager.deviceMeta']).toBeDefined()
    expect(log.info).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
  })
})
