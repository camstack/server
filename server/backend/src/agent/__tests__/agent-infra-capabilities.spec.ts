/**
 * An agent boots NO local data engine.
 *
 * `AGENT_INFRA` was `INFRA_CAPABILITIES` unfiltered, and that list carries
 * `{ name: 'data-store-provider', required: true }`. `sqlite-settings` is the
 * only addon that declares it and it lives in the `@camstack/system` closure
 * the agent scans — so opening a local database was not configuration, it was
 * a PRECONDITION OF BOOT. Persistence is the hub's; the agent's data door
 * forwards there (`hub-settings-forward.ts`).
 *
 * What these pin:
 *
 *  1. **The engine is gone by default**, and nothing else is: this list is
 *     ORDERED and Phase 1 walks it in order, so a filter that reshuffled it
 *     would boot `storage` before its provider.
 *  2. **The rollback is an env var, not a revert.** This repo has already paid
 *     three boot holes on this path (1.2.149 skip-infra, 1.2.151 crash-loop,
 *     1.2.152 `resolveConfig` hang). A change to agent boot that can only be
 *     undone by shipping a build is a change that stays broken for a release
 *     cycle. `CAMSTACK_AGENT_LOCAL_DATA_STORE=1` restores the old list
 *     EXACTLY — same entries, same order, same `required` flags.
 *  3. **The hub is untouched.** `INFRA_CAPABILITIES` itself never changes; the
 *     hub reads it directly.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { INFRA_CAPABILITIES } from '@camstack/system'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveAgentInfraCapabilities } from '../agent-infra-capabilities.js'
import { assertRequiredInfraResolved } from '../infra-boot-guard.js'
import { planInfraBoot, planToResolutions } from '../infra-boot-plan.js'

const names = (list: readonly { readonly name: string }[]): readonly string[] =>
  list.map((c) => c.name)

describe('resolveAgentInfraCapabilities', () => {
  it('drops data-store-provider — an agent opens no database of its own', () => {
    const resolved = resolveAgentInfraCapabilities({})
    expect(names(resolved)).not.toContain('data-store-provider')
  })

  it('keeps every OTHER infra capability, in the order Phase 1 walks them', () => {
    const resolved = resolveAgentInfraCapabilities({})
    const expected = names(INFRA_CAPABILITIES).filter(
      (n) => n !== 'data-store-provider' && n !== 'keychain',
    )
    expect(names(resolved)).toEqual(expected)
  })

  it('never boots the keychain on an agent — with or without the rollback flag', () => {
    // An agent keychain wrote its wrapped data key into the HUB's store and its
    // master key onto the AGENT's disk: the hub then locked `key-missing`.
    expect(names(resolveAgentInfraCapabilities({}))).not.toContain('keychain')
    expect(
      names(resolveAgentInfraCapabilities({ CAMSTACK_AGENT_LOCAL_DATA_STORE: '1' })),
    ).not.toContain('keychain')
    // …and the hub still boots it.
    expect(names(INFRA_CAPABILITIES)).toContain('keychain')
  })

  it('keeps the settings-store door REQUIRED — the door still has to exist', () => {
    const resolved = resolveAgentInfraCapabilities({})
    expect(resolved.find((c) => c.name === 'settings-store')).toEqual({
      name: 'settings-store',
      required: true,
    })
    expect(resolved.find((c) => c.name === 'storage')?.required).toBe(true)
    expect(resolved.find((c) => c.name === 'storage-provider')?.required).toBe(true)
  })

  it('ROLLBACK: CAMSTACK_AGENT_LOCAL_DATA_STORE=1 restores the engine — every entry but the keychain', () => {
    const resolved = resolveAgentInfraCapabilities({ CAMSTACK_AGENT_LOCAL_DATA_STORE: '1' })
    expect(resolved).toEqual(INFRA_CAPABILITIES.filter((c) => c.name !== 'keychain'))
  })

  it('accepts the usual truthy spellings of the rollback flag, and nothing else', () => {
    for (const raw of ['1', 'true', 'TRUE', ' yes ']) {
      expect(
        names(resolveAgentInfraCapabilities({ CAMSTACK_AGENT_LOCAL_DATA_STORE: raw })),
      ).toContain('data-store-provider')
    }
    for (const raw of ['', '0', 'false', 'no', 'maybe']) {
      expect(
        names(resolveAgentInfraCapabilities({ CAMSTACK_AGENT_LOCAL_DATA_STORE: raw })),
      ).not.toContain('data-store-provider')
    }
  })

  it('never mutates INFRA_CAPABILITIES — the hub reads the same array', () => {
    const before = names(INFRA_CAPABILITIES)
    resolveAgentInfraCapabilities({})
    resolveAgentInfraCapabilities({ CAMSTACK_AGENT_LOCAL_DATA_STORE: '1' })
    expect(names(INFRA_CAPABILITIES)).toEqual(before)
    expect(before).toContain('data-store-provider')
  })
})

/**
 * The gate the operator actually cares about: **a booting agent creates no
 * database file.**
 *
 * The only code that can create one is `sqlite-settings`' `initialize()`
 * (`SqliteSettingsBackend` opens `<dataDir>/addons-data/sqlite-settings/
 * camstack.db`), and the only thing that calls it on an agent is Phase 1
 * walking the plan. So the gate is exercised where it lives: the same
 * `planInfraBoot` the agent runs, over the same installed set, with every
 * `initialize: true` step doing what `sqlite-settings` would do — touch a file.
 */
describe('agent Phase 1 — no engine, no file', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
  })

  /** What an agent's scan finds on `agent-a` today. */
  const INSTALLED = [
    { id: 'filesystem-storage', capabilities: ['storage-provider'] },
    { id: 'sqlite-settings', capabilities: ['data-store-provider'] },
    { id: 'storage-orchestrator', capabilities: ['storage', 'settings-store'] },
    { id: 'keychain', capabilities: ['keychain', 'keychain-admin'] },
    { id: 'hub-forwarder', capabilities: ['log-destination'] },
    { id: 'native-metrics', capabilities: ['metrics-provider'] },
    { id: 'platform-probe', capabilities: ['platform-probe'] },
  ] as const

  /** Run the plan the way Phase 1 does: one file per addon that INITIALIZES. */
  async function bootInto(dir: string, env: NodeJS.ProcessEnv): Promise<readonly string[]> {
    const plan = planInfraBoot([...INSTALLED], resolveAgentInfraCapabilities(env))
    assertRequiredInfraResolved(planToResolutions(plan), dir)
    for (const step of plan) {
      if (!step.initialize || step.addonId === null) continue
      await fs.writeFile(path.join(dir, `${step.addonId}.opened`), '')
    }
    return (await fs.readdir(dir)).sort()
  }

  it('opens no sqlite-settings store — and still satisfies every REQUIRED capability', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-phase1-'))
    dirs.push(dir)

    const opened = await bootInto(dir, {})

    expect(opened).not.toContain('sqlite-settings.opened')
    expect(opened).not.toContain('keychain.opened')
    // Everything else an agent needs still boots, in one pass each.
    expect(opened).toEqual([
      'filesystem-storage.opened',
      'hub-forwarder.opened',
      'native-metrics.opened',
      'platform-probe.opened',
      'storage-orchestrator.opened',
    ])
  })

  it('ROLLBACK: the env var brings the engine — and the file — straight back', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-phase1-rollback-'))
    dirs.push(dir)

    const opened = await bootInto(dir, { CAMSTACK_AGENT_LOCAL_DATA_STORE: '1' })

    expect(opened).toContain('sqlite-settings.opened')
    expect(opened).not.toContain('keychain.opened')
  })
})
