/**
 * D986: node rows of `addon-settings` carry `nodeId`, and forgetting a node deletes its rows and
 * nothing else. Real SQLite through the real dispatch, both writers (the kernel store and the
 * backend's `setAllAddon`).
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ISettingsStoreProvider } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteSettingsBackend } from '../../builtins/sqlite-storage/sqlite-settings-backend.js'
import { createDataStoreDispatch } from '../../builtins/storage-orchestrator/data-store-dispatch.js'
import { clearNodeSettings, createAddonSettingsStore } from '../addon-settings-store.js'
import { createDeviceSettingsStore } from '../device-settings-store.js'

let dir = ''
let backend: SqliteSettingsBackend
let door: ISettingsStoreProvider

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'addon-settings-node-rows-'))
  backend = new SqliteSettingsBackend(path.join(dir, 'camstack.db'))
  await backend.initialize()
  door = createDataStoreDispatch(() => [backend])
})
afterEach(async () => {
  await backend.shutdown()
  await fs.rm(dir, { recursive: true, force: true })
})

async function rowData(id: string): Promise<Record<string, unknown> | undefined> {
  const row = await door.get({ collection: 'addon-settings', key: id })
  return typeof row === 'object' && row !== null && !Array.isArray(row)
    ? Object.fromEntries(Object.entries(row))
    : undefined
}

describe('node rows of addon-settings', () => {
  it('a node row carries nodeId, a cluster row does not, and ids are unchanged', async () => {
    const store = createAddonSettingsStore(door, 'detector')
    await store.merge({ backend: 'cpu', 'backend@agent-1': 'npu' })
    await store.mergeNode('agent-2', { threads: 4 })
    expect(await rowData('detector.backend')).toEqual({
      addonId: 'detector',
      key: 'backend',
      value: 'cpu',
    })
    expect(await rowData('detector.backend@agent-1')).toEqual({
      addonId: 'detector',
      key: 'backend@agent-1',
      value: 'npu',
      nodeId: 'agent-1',
    })
    expect(await rowData('detector.threads@agent-2')).toMatchObject({ nodeId: 'agent-2' })
  })

  it('the backend legacy writer stamps nodeId too', async () => {
    backend.setAllAddon('legacy', { a: 1, 'b@agent-1': 2 })
    expect(await rowData('legacy.b@agent-1')).toMatchObject({ nodeId: 'agent-1', value: 2 })
    expect(await rowData('legacy.a')).not.toHaveProperty('nodeId')
  })

  it('reads by scope: unscoped rows, and one node without another node leaking in', async () => {
    const store = createAddonSettingsStore(door, 'detector')
    await store.merge({ shared: 's', 'x@agent-1': 1, 'x@agent-2': 2, 'y@agent-1': 3 })
    const cluster = await store.readUnscoped()
    expect(cluster).toEqual({ kind: 'present', value: { shared: 's' } })
    expect(await store.readNode('agent-1')).toEqual({ kind: 'present', value: { x: 1, y: 3 } })
    expect(await store.readNode('agent-2')).toEqual({ kind: 'present', value: { x: 2 } })
    expect(await store.readNode('agent-9')).toEqual({ kind: 'absent' })
  })

  it('forgetting a node deletes its rows of every addon and nothing else', async () => {
    const detector = createAddonSettingsStore(door, 'detector')
    const recorder = createAddonSettingsStore(door, 'recorder')
    await detector.merge({ shared: 'cluster-value' })
    await detector.mergeNode('agent-1', { backend: 'npu' })
    await detector.mergeNode('agent-2', { backend: 'gpu' })
    await recorder.mergeNode('agent-1', { path: '/data' })
    await createDeviceSettingsStore(door, 'detector').merge(77, { 'note@agent-1': 'device row' })

    const deleted = await clearNodeSettings(door, 'agent-1')

    expect(deleted).toBe(2)
    expect(await detector.readNode('agent-1')).toEqual({ kind: 'absent' })
    expect(await recorder.readNode('agent-1')).toEqual({ kind: 'absent' })
    expect(await detector.readNode('agent-2')).toEqual({
      kind: 'present',
      value: { backend: 'gpu' },
    })
    expect(await detector.readUnscoped()).toEqual({
      kind: 'present',
      value: { shared: 'cluster-value' },
    })
    expect(await createDeviceSettingsStore(door, 'detector').read(77)).toEqual({
      kind: 'present',
      value: { 'note@agent-1': 'device row' },
    })
  })

  it('refuses an empty node id: it would name every node', async () => {
    await expect(clearNodeSettings(door, '')).rejects.toThrow(/empty node id/)
  })
})
