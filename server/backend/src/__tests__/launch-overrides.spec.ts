/**
 * The per-node launch override (ADR 0970): written on the node by the
 * `server-management` cap, read at the next launch by `launch-args.js`.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { serverManagementCapability } from '@camstack/types'
import { buildLaunchOverrideMethods } from '../api/core/server-management.provider.js'
import {
  LAUNCH_OVERRIDES_FILE,
  readHeapOverrideMb,
  runLaunchCli,
  writeHeapOverrideMb,
} from '../launch-args.js'

const fresh = (): string => mkdtempSync(join(tmpdir(), 'launch-overrides-'))

describe('writeHeapOverrideMb', () => {
  it('persists a value the next launch reads back', () => {
    const dir = fresh()
    writeHeapOverrideMb(dir, 3072)
    expect(readHeapOverrideMb(dir)).toBe(3072)
    const out = runLaunchCli(['--role', 'agent'], {
      env: { CAMSTACK_DATA: dir },
      io: { readFile: (f) => (existsSync(f) ? readFileSync(f, 'utf8') : null) },
      totalMemBytes: 64 * 1024 ** 3,
    })
    expect(out.stdout).toContain('arg --max-old-space-size=3072')
    expect(out.stdout).toContain('source override')
  })

  it('null clears it, and clearing nothing is fine', () => {
    const dir = fresh()
    writeHeapOverrideMb(dir, 2048)
    writeHeapOverrideMb(dir, null)
    expect(readHeapOverrideMb(dir)).toBeNull()
    expect(existsSync(join(dir, LAUNCH_OVERRIDES_FILE))).toBe(false)
    expect(() => writeHeapOverrideMb(dir, null)).not.toThrow()
  })

  it('refuses a value the launcher would ignore, writing nothing', () => {
    const dir = fresh()
    expect(() => writeHeapOverrideMb(dir, 100)).toThrow(/512/)
    expect(() => writeHeapOverrideMb(dir, 1.5)).toThrow()
    expect(readdirSync(dir)).toEqual([])
  })

  it('leaves no temp file behind and survives a corrupt previous file', () => {
    const dir = fresh()
    writeFileSync(join(dir, LAUNCH_OVERRIDES_FILE), '{not json')
    writeHeapOverrideMb(dir, 4096)
    expect(readdirSync(dir)).toEqual([LAUNCH_OVERRIDES_FILE])
    expect(readHeapOverrideMb(dir)).toBe(4096)
  })
})

describe('server-management launch overrides', () => {
  it('the cap declares both methods as admin calls', () => {
    expect(serverManagementCapability.methods.getLaunchOverrides.auth).toBe('admin')
    expect(serverManagementCapability.methods.setLaunchOverrides.kind).toBe('mutation')
    expect(serverManagementCapability.methods.setLaunchOverrides.auth).toBe('admin')
  })

  it('the methods read and write the node data dir', async () => {
    const dir = fresh()
    const provider = buildLaunchOverrideMethods(dir)
    expect(await provider.getLaunchOverrides()).toEqual({ heapMb: null })
    const set = await provider.setLaunchOverrides({ heapMb: 5120 })
    expect(set).toEqual({ heapMb: 5120, restartRequired: true })
    expect(readHeapOverrideMb(dir)).toBe(5120)
    expect(await provider.getLaunchOverrides()).toEqual({ heapMb: 5120 })
    await provider.setLaunchOverrides({ heapMb: null })
    expect(readHeapOverrideMb(dir)).toBeNull()
  })
})
