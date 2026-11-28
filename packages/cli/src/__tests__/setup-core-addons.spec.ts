import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { bundledManifest } from '../onboarding/manifest.js'
import { callJson, connectPublic, fakeHub, type HubAnswers } from './onboarding-fixtures.js'

const Answer = z.object({
  status: z.literal('ok'),
  remoteAccess: z.boolean().nullable(),
  groups: z.array(
    z.object({
      id: z.string(),
      need: z.string(),
      status: z.string(),
      reason: z.string().optional(),
      addons: z.array(z.object({ id: z.string(), state: z.string() })),
      nextAction: z
        .object({
          text: z.string(),
          tool: z.string().optional(),
          args: z.record(z.string(), z.unknown()).optional(),
          ui: z.object({ route: z.string() }).optional(),
        })
        .nullable(),
    }),
  ),
  nextAction: z
    .object({
      group: z.string(),
      text: z.string(),
      tool: z.string().optional(),
    })
    .nullable(),
})
type Answer = z.infer<typeof Answer>

const SEEDED = bundledManifest()
  .coreAddons.filter((g) => g.need === 'seeded')
  .flatMap((g) => g.addons)

const listed = (ids: readonly string[]): unknown =>
  ids.map((id) => ({
    manifest: {
      id,
      packageName: `@dominevo/addon-${id}`,
      packageVersion: '1.0.0',
    },
  }))

function hub(
  extraAddons: readonly string[],
  instances: Readonly<Record<string, unknown>> = {},
  more: HubAnswers = {},
): HubAnswers {
  return {
    'addons.list': listed([...SEEDED.map((a) => a.id), ...extraAddons]),
    'integrationInstances.listInstances': (input: unknown) => {
      const addonId = z.object({ addonId: z.string() }).parse(input).addonId
      return instances[addonId] ?? []
    },
    'networkAccess.getStatus': { connected: false, endpoint: null },
    ...more,
  }
}

async function ask(
  answers: HubAnswers,
  args: Record<string, unknown> = {},
  failing: readonly string[] = [],
): Promise<Answer> {
  const { ctx } = fakeHub(answers, { failing })
  return Answer.parse(await callJson(await connectPublic(ctx), 'setup_core_addons', args))
}

const group = (answer: Answer, id: string): Answer['groups'][number] => {
  const hit = answer.groups.find((g) => g.id === id)
  if (hit === undefined) throw new Error(`no group ${id}`)
  return hit
}

describe('setup_core_addons', () => {
  it('a fresh hub: seeded groups are fine, the camera integration is the next action, with its package', async () => {
    const answer = await ask(hub([]))

    expect(group(answer, 'video-pipeline').status).toBe('configured')
    const cameras = group(answer, 'camera-integration')
    expect(cameras.status).toBe('missing')
    expect(answer.nextAction).toMatchObject({
      group: 'camera-integration',
      tool: 'configure_addon_install',
    })
    expect(JSON.stringify(cameras.nextAction)).toContain('@dominevo/addon-provider-onvif')
  })

  it('installed without an instance is "installed": the next action is the admin page, never a tool that would carry a secret', async () => {
    const answer = await ask(hub(['provider-onvif', 'cloudflare-turn']), {
      remoteAccess: true,
    })

    const turn = group(answer, 'turn')
    expect(turn.status).toBe('installed')
    expect(turn.nextAction?.tool).toBeUndefined()
    expect(turn.nextAction?.ui?.route).toBe('/system/integrations')
  })

  it('an enabled instance makes the group configured; one in error makes it failed', async () => {
    const answer = await ask(
      hub(['provider-onvif', 'cloudflare-turn', 'cloudflare-tunnel'], {
        'provider-onvif': [{ id: 'i1', enabled: true, status: { state: 'ok' } }],
        'cloudflare-turn': [
          {
            id: 'i2',
            enabled: true,
            status: { state: 'error', detail: 'Token expired' },
          },
        ],
      }),
      { remoteAccess: true },
    )

    expect(group(answer, 'camera-integration').status).toBe('configured')
    const turn = group(answer, 'turn')
    expect(turn.status).toBe('failed')
    expect(turn.reason).toContain('Token expired')
    expect(answer.nextAction?.group).toBe('turn')
  })

  it('TURN and the tunnel wait on the question when nobody said whether the hub is used away from home', async () => {
    const answer = await ask(hub(['provider-onvif'], { 'provider-onvif': [{ id: 'i1' }] }))

    expect(answer.remoteAccess).toBeNull()
    expect(group(answer, 'turn').status).toBe('suggested')
    expect(answer.nextAction?.group).toBe('turn')
    expect(answer.nextAction?.text).toMatch(/away from home/)
    expect(answer.nextAction?.tool).toBe('setup_core_addons')
  })

  it('remoteAccess false: the relay is not needed and nothing is pending', async () => {
    const answer = await ask(hub(['provider-onvif'], { 'provider-onvif': [{ id: 'i1' }] }), {
      remoteAccess: false,
    })

    expect(group(answer, 'turn').status).toBe('not-needed')
    expect(group(answer, 'remote-access').status).toBe('suggested')
    expect(answer.nextAction).toBeNull()
  })

  it('remoteAccess true with nothing installed: TURN is missing', async () => {
    const answer = await ask(hub(['provider-onvif'], { 'provider-onvif': [{ id: 'i1' }] }), {
      remoteAccess: true,
    })

    expect(group(answer, 'turn').status).toBe('missing')
    expect(answer.nextAction).toMatchObject({
      group: 'turn',
      tool: 'configure_addon_install',
    })
  })

  it('a connected remote access counts as configured whatever provides it', async () => {
    const answer = await ask(
      hub(
        ['provider-onvif'],
        {},
        {
          'networkAccess.getStatus': {
            connected: true,
            endpoint: { stable: true },
          },
        },
      ),
      { remoteAccess: true },
    )

    expect(group(answer, 'remote-access').status).toBe('configured')
  })

  it('an addon list that did not answer is unknown with its reason, never missing', async () => {
    const answer = await ask(hub([]), {}, ['addons.list'])

    for (const g of answer.groups) {
      expect(g.status).toBe('unknown')
      expect(g.reason).toContain('addons.list')
    }
    expect(answer.nextAction).toBeNull()
  })

  it('an instance list that did not answer leaves an installed addon unknown, not unconfigured', async () => {
    const answer = await ask(hub(['provider-onvif']), {}, ['integrationInstances.listInstances'])

    const cameras = group(answer, 'camera-integration')
    expect(cameras.status).toBe('unknown')
    expect(cameras.addons.find((a) => a.id === 'provider-onvif')?.state).toBe('unknown')
  })

  it('never asks the hub for TURN credentials', async () => {
    const { ctx, calls } = fakeHub(hub(['cloudflare-turn']))
    await callJson(await connectPublic(ctx), 'setup_core_addons', {
      remoteAccess: true,
    })

    expect(calls.map((c) => c.path).filter((p) => p.startsWith('turnProvider.'))).toEqual([])
  })
})
