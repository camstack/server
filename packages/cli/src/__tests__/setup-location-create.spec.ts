import { describe, expect, it } from 'vitest'
import { locationCreateApply } from '../mcp/setup-location-create.js'
import { asProtectedTier, dryRunOf, gatedHub, writes } from './configure-fixtures.js'

const fsRow = (
  id: string,
  basePath: string,
  extra: { [k: string]: unknown } = {},
): { [k: string]: unknown } => ({
  id,
  type: id.split(':')[0],
  displayName: id,
  providerId: 'filesystem-storage',
  config: { basePath },
  nodeId: 'hub',
  isSystem: false,
  enabled: true,
  mode: 'active',
  createdAt: 1,
  updatedAt: 2,
  ...extra,
})

const DECLARED = [
  { id: 'recordings', displayName: 'Recordings', cardinality: 'multi' },
  { id: 'eventMedia', displayName: 'Event media', cardinality: 'multi' },
  { id: 'models', displayName: 'Models', cardinality: 'single' },
]

const answers = (
  rows: unknown,
  extra: { [p: string]: unknown } = {},
): { [p: string]: unknown } => ({
  'storage.listLocations': rows,
  'storage.listLocationDeclarations': DECLARED,
  'integrationInstances.testInstance': { success: true, status: 'validated' },
  'integrationInstances.createInstance': { id: 'recordings:nas' },
  ...extra,
})

const ARGS = {
  type: 'recordings',
  name: 'NAS',
  path: '/mnt/nas/recordings',
  nodeId: 'hub',
}

function problems(result: unknown): string {
  return JSON.stringify(dryRunOf(result).describe)
}

describe('configure_setup_location_create', () => {
  it('dry run writes nothing; the token probes the path, then creates through the instance door', async () => {
    const { ctx, calls } = gatedHub(answers([fsRow('recordings:default', '/data/recordings')]))

    const dry = dryRunOf(await locationCreateApply(ctx, ARGS, undefined))
    expect(dry.token).toBeDefined()
    expect(writes(calls)).toHaveLength(0)

    await locationCreateApply(ctx, ARGS, dry.token)
    const w = writes(calls)
    expect(w.map((c) => c.path)).toEqual([
      'integrationInstances.testInstance',
      'integrationInstances.createInstance',
    ])
    expect(w[1]?.input).toEqual({
      addonId: 'storage-orchestrator',
      name: 'NAS',
      kind: 'recordings',
      values: {
        providerId: 'filesystem-storage',
        basePath: '/mnt/nas/recordings',
        nodeId: 'hub',
        mode: 'active',
      },
    })
  })

  it('refuses a path that equals, contains or sits inside a location of the same type on the same node', async () => {
    const { ctx } = gatedHub(answers([fsRow('recordings:default', '/data/recordings')]))

    for (const path of [
      '/data/recordings',
      '/data/recordings/',
      '/data',
      '/data/recordings/cam1',
    ]) {
      const dry = await locationCreateApply(ctx, { ...ARGS, path }, undefined)
      expect(dryRunOf(dry).token, path).toBeUndefined()
      expect(problems(dry), path).toContain('recordings:default')
    }
  })

  it('a sibling that only shares a name prefix is not a collision, and neither is another node or another type', async () => {
    const { ctx } = gatedHub(
      answers([
        fsRow('recordings:default', '/data/recordings'),
        fsRow('recordings:agent', '/mnt/x', { nodeId: 'agent1' }),
        fsRow('eventMedia:default', '/mnt/shared'),
      ]),
    )

    for (const args of [
      { ...ARGS, path: '/data/recordings-2' },
      { ...ARGS, path: '/mnt/x' },
      { ...ARGS, path: '/mnt/shared' },
    ]) {
      expect(
        dryRunOf(await locationCreateApply(ctx, args, undefined)).token,
        args.path,
      ).toBeDefined()
    }
  })

  it('refuses an undeclared type, a second location of a single-cardinality type, and a relative path', async () => {
    const { ctx } = gatedHub(answers([fsRow('models:default', '/data/models')]))

    const unknown = await locationCreateApply(ctx, { ...ARGS, type: 'nope' }, undefined)
    expect(dryRunOf(unknown).token).toBeUndefined()
    expect(problems(unknown)).toContain('recordings')

    const second = await locationCreateApply(
      ctx,
      { ...ARGS, type: 'models', path: '/x' },
      undefined,
    )
    expect(dryRunOf(second).token).toBeUndefined()
    expect(problems(second)).toMatch(/only one/)

    const relative = await locationCreateApply(ctx, { ...ARGS, path: 'recordings' }, undefined)
    expect(dryRunOf(relative).token).toBeUndefined()
  })

  it('a locations read that failed confirms nothing: no rows is not "no collision"', async () => {
    const { ctx } = gatedHub(answers(new Error('boom')))

    const dry = await locationCreateApply(ctx, ARGS, undefined)
    expect(dryRunOf(dry).token).toBeUndefined()
    expect(problems(dry)).toContain('boom')
  })

  it('a path the provider rejects is never created', async () => {
    const { ctx, calls } = gatedHub(
      answers([], {
        'integrationInstances.testInstance': {
          success: false,
          status: 'rejected',
          error: 'EACCES: permission denied',
        },
      }),
    )
    const dry = dryRunOf(await locationCreateApply(ctx, ARGS, undefined))

    await expect(locationCreateApply(ctx, ARGS, dry.token)).rejects.toThrow(/EACCES/)

    expect(writes(calls).map((c) => c.path)).not.toContain('integrationInstances.createInstance')
  })

  it('needs an admin credential', async () => {
    const { ctx, calls } = gatedHub(answers([]))
    const refused = await locationCreateApply(await asProtectedTier(ctx), ARGS, undefined)
    expect(JSON.stringify(refused)).toMatch(/admin/i)
    expect(writes(calls)).toHaveLength(0)
  })
})
