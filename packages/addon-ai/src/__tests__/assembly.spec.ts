import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { assembleAi } from '../assembly.js'
import { aiRecordKinds } from '../record-kinds.js'
import { makeAiRecords } from './support/fake-records.js'
import { ProfileStore, SEED_PROFILE_ID } from '../profile-store.js'
import { LlamaSupervisor } from '../runtime/llama-supervisor.js'
import { makeTestLogger } from './support/logger.js'

let modelsDir: string
beforeEach(async () => {
  modelsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ai-assembly-'))
})
afterEach(async () => {
  await fsp.rm(modelsDir, { recursive: true, force: true })
})

function makeSupervisor(): LlamaSupervisor {
  return new LlamaSupervisor({ logger: makeTestLogger(), pickPort: async () => 18080 })
}

function baseDeps(isHub: boolean) {
  return {
    nodeId: isHub ? 'hub' : 'agent-1',
    isHub,
    logger: makeTestLogger(),
    modelsDir,
    supervisor: makeSupervisor(),
    ensureBinary: async () => '/bin/llama-server',
    execute: async () => ({ kind: 'timeout' as const }),
  }
}

describe('assembleAi', () => {
  it('an agent registers ONLY llm-runtime', async () => {
    const assembly = await assembleAi(baseDeps(false))
    expect(assembly.registrations.map((r) => r.capability.name)).toEqual(['llm-runtime'])
    expect(assembly.llmProvider).toBeUndefined()
  })

  it('the hub registers both llm-runtime and llm, and seeds the template', async () => {
    const world = await makeAiRecords()
    const assembly = await assembleAi({ ...baseDeps(true), records: world.records })
    expect(assembly.registrations.map((r) => r.capability.name).sort()).toEqual([
      'llm',
      'llm-runtime',
      'node-removal-hook',
    ])
    expect(assembly.llmProvider).toBeDefined()
    const rows = await ProfileStore.of(world.records).list()
    expect(rows.map((r) => r.id)).toContain(SEED_PROFILE_ID)
  })

  it('the hub refuses to assemble without ctx.records', async () => {
    await expect(assembleAi(baseDeps(true))).rejects.toThrow(/needs ctx.records/)
  })

  it('an agent assembles without records (it keeps no AI state)', async () => {
    const assembly = await assembleAi(baseDeps(false))
    expect(assembly.store).toBeUndefined()
    expect(assembly.usage).toBeUndefined()
  })

  it('the usage kind ages out on the engine TTL, not on an addon sweep', () => {
    expect(aiRecordKinds.usage.declaration.retention).toEqual({
      ttlMs: 90 * 24 * 60 * 60 * 1000,
      from: 'at',
    })
    expect(aiRecordKinds.usage.declaration.at).toBe('required')
  })
})

describe('assembleAi — Apple Foundation Models', () => {
  it('every node exposes the Apple backend it was handed through llm-runtime', async () => {
    const assembly = await assembleAi({
      ...baseDeps(false),
      apple: {
        availability: () => ({ state: 'unsupported-platform', platform: 'linux' }),
        complete: async () => ({ ok: false, code: 'unavailable', message: 'linux' }),
      },
    })
    expect(await assembly.runtimeProvider.appleAvailability({})).toEqual({
      state: 'unsupported-platform',
      platform: 'linux',
    })
  })

  it('a node assembled without one says unknown, not unavailable', async () => {
    const assembly = await assembleAi(baseDeps(false))
    expect(await assembly.runtimeProvider.appleAvailability({})).toMatchObject({ state: 'unknown' })
  })
})
