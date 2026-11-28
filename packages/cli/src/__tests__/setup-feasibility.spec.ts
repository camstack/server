import { describe, expect, it } from 'vitest'
import { MutationGate } from '@dominevo/develop'
import { z } from 'zod'
import { runHostCheck } from '../commands/host-check.js'
import type { McpContext } from '../mcp/context.js'
import { bundledOnly } from '../onboarding/manifest.js'
import { memoryStateStore, type OnboardingStateStore } from '../onboarding/state-file.js'
import {
  N100,
  UNMEASURED_CPU,
  callJson,
  connectPublic,
  fakeHost,
  linuxHost,
} from './onboarding-fixtures.js'

const Answer = z.object({
  status: z.literal('ok'),
  report: z.object({
    verdict: z.string(),
    provisional: z.boolean(),
    hardware: z.object({ measured: z.boolean(), hardwareClass: z.string() }),
  }),
  hardwareReport: z.object({ url: z.string(), title: z.string() }).nullable(),
  remembered: z.boolean(),
  next: z.string(),
})

function context(cpuModel: string, store: OnboardingStateStore): McpContext {
  return {
    cliVersion: '9.9.9',
    hub: async () => {
      throw new Error('feasibility must not reach for a hub')
    },
    gate: new MutationGate({ allowMutations: true, audit: () => {} }),
    fetch: async () => {
      throw new Error('feasibility must not fetch when the manifest is injected')
    },
    manifest: bundledOnly,
    host: fakeHost(linuxHost(cpuModel, true)),
    onboardingState: store,
  }
}

const ASK = {
  cameras: 6,
  mainStream: '4k',
  codec: 'h265',
  recording: 'continuous',
  retentionDays: 14,
}

describe('setup_feasibility', () => {
  it('answers a provisional verdict with no hub and remembers it for setup_wizard', async () => {
    const store = memoryStateStore()
    const client = await connectPublic(context(N100, store))

    const answer = Answer.parse(await callJson(client, 'setup_feasibility', ASK))

    expect(answer.report.provisional).toBe(true)
    expect(answer.report.hardware.measured).toBe(true)
    expect(answer.hardwareReport).toBeNull()
    expect(answer.remembered).toBe(true)
    expect(store.read().feasibility).toMatchObject({
      verdict: answer.report.verdict,
      cameras: 6,
      measured: true,
    })
  })

  it('hardware outside the measured tables gets the prefilled report link', async () => {
    const client = await connectPublic(context(UNMEASURED_CPU, memoryStateStore()))

    const answer = Answer.parse(await callJson(client, 'setup_feasibility', ASK))

    expect(answer.report.hardware.measured).toBe(false)
    expect(answer.report.verdict).toBe('hub-plus-agents')
    const url = new URL(answer.hardwareReport?.url ?? '')
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/dominevo/server/issues/new')
    expect(url.searchParams.get('template')).toBe('hardware_report.yml')
    expect(url.searchParams.get('host-check')).toContain('i5-8500')
  })

  it('says so when the verdict could not be saved', async () => {
    const readOnly: OnboardingStateStore = {
      read: () => ({ feasibility: null }),
      write: () => false,
    }
    const client = await connectPublic(context(N100, readOnly))

    const answer = Answer.parse(await callJson(client, 'setup_feasibility', ASK))

    expect(answer.remembered).toBe(false)
  })
})

describe('dominevo host-check sizing flags', () => {
  async function run(args: readonly string[], cpuModel: string): Promise<string> {
    const out: string[] = []
    await runHostCheck(args, {
      host: fakeHost(linuxHost(cpuModel, true)),
      manifest: bundledOnly,
      write: (text) => out.push(text),
    })
    return out.join('')
  }

  it('without --cameras prints the plain report, no verdict', async () => {
    const text = await run([], N100)
    expect(text).not.toContain('Verdict')
  })

  it('with --cameras adds the verdict, and the share link only for unmeasured hardware', async () => {
    const measured = await run(['--cameras', '6'], N100)
    expect(measured).toContain('Verdict')
    expect(measured).not.toContain('issues/new')

    const unmeasured = await run(['--cameras', '6'], UNMEASURED_CPU)
    expect(unmeasured).toContain('https://github.com/dominevo/server/issues/new')
  })

  it('--json carries the feasibility report next to the host check', async () => {
    const parsed = z
      .object({ imageTag: z.string().nullable(), feasibility: z.object({ verdict: z.string() }) })
      .parse(JSON.parse(await run(['--cameras', '6', '--json'], N100)))
    expect(parsed.feasibility.verdict.length).toBeGreaterThan(0)
  })

  it('refuses a value outside the published set', async () => {
    await expect(run(['--cameras', '6', '--codec', 'vp9'], N100)).rejects.toThrow(/--codec/)
  })
})
