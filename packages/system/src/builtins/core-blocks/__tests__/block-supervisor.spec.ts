/**
 * The supervisor is the piece that makes a stored block a running process, so
 * the tests below are mostly about the ways a block can fail to run. The one
 * thing this feature must never do is be quiet about that: an operator who
 * enables a block and sees nothing has no way to tell "it runs and does
 * nothing" from "nothing ever started it".
 *
 * `CrashSupervisor` itself is NOT faked here — it is not in this layer at all.
 * The supervisor asks the real process host for runner states and translates
 * them; the bounding of a runaway block is `process-service`'s, and is covered
 * where it lives (`crash-supervisor.spec.ts`, `block-runner-e2e.spec.ts`).
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  COMPOSER_RUNNER_ID,
  type ComposerApplyInput,
  type ComposerApplyResult,
  type ComposerUnreadableBlock,
  type CoreBlock,
  ROOM_EXAMPLE_MOTION_SOURCES,
  ROOM_EXAMPLE_TEMPERATURE_SOURCES,
  ROOM_OCCUPANCY_WINDOW_MS,
  roomCompositionExample,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { blockAddonId } from '../block-package.js'
import {
  type BlockProcessHost,
  type BlockRunnerSnapshot,
  BlockSupervisor,
  type ComposerPort,
} from '../block-supervisor.js'
import { CoreBlockStore } from '../core-block-store.js'
import { coreBlockRecordsHarness, recordingLogger } from './fixtures.js'
import { coreBlocksRecordKinds } from '../record-kinds.js'

const { logger } = recordingLogger()

function makeBlock(over: Partial<CoreBlock> = {}): CoreBlock {
  return {
    id: 'b1',
    name: 'Block One',
    code: 'export default () => {}',
    enabled: true,
    placement: 'hub',
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'u1',
    status: 'stopped',
    lastChangedAt: 1,
    ...over,
  }
}

/** A store stub with the two methods the supervisor uses, plus a record of
 *  every status write so a test can assert what the operator would see. */
class FakeStore {
  private blocks: CoreBlock[] = []
  readonly statusWrites: Array<{ blockId: string; status: string; error?: string }> = []

  setBlocks(blocks: readonly CoreBlock[]): void {
    this.blocks = [...blocks]
  }
  /** Edit a stored block the way `CoreBlockStore.update` does — the patch is
   *  author-authored fields only, so `status` survives. Tests that re-`setBlocks`
   *  a whole block would silently reset the status and stop testing anything. */
  patch(blockId: string, patch: Partial<CoreBlock>): void {
    this.blocks = this.blocks.map((b) => (b.id === blockId ? { ...b, ...patch } : b))
  }
  unreadable: ComposerUnreadableBlock[] = []
  unreadableCompositions(): readonly ComposerUnreadableBlock[] {
    return this.unreadable
  }
  list(): readonly CoreBlock[] {
    return this.blocks
  }
  get(blockId: string): CoreBlock | null {
    return this.blocks.find((b) => b.id === blockId) ?? null
  }
  async setStatus(blockId: string, status: CoreBlock['status'], error?: string): Promise<void> {
    this.statusWrites.push({ blockId, status, ...(error !== undefined ? { error } : {}) })
    this.blocks = this.blocks.map((b) =>
      b.id === blockId
        ? {
            ...b,
            status,
            ...(error !== undefined ? { lastError: error } : { lastError: undefined }),
          }
        : b,
    )
  }
}

class FakeHost implements BlockProcessHost {
  runners: BlockRunnerSnapshot[] = []
  readonly spawned: Array<{ runnerId: string; addonId: string; addonDir: string }> = []
  readonly stopped: string[] = []
  spawnError: string | null = null

  async list(): Promise<readonly BlockRunnerSnapshot[]> {
    return this.runners
  }
  async spawn(input: { runnerId: string; addonId: string; addonDir: string }): Promise<void> {
    if (this.spawnError !== null) throw new Error(this.spawnError)
    this.spawned.push(input)
    this.runners = [...this.runners, { name: input.runnerId, state: 'starting' }]
  }
  async stop(runnerId: string): Promise<void> {
    this.stopped.push(runnerId)
    this.runners = this.runners.filter((r) => r.name !== runnerId)
  }
}

let root: string
let store: FakeStore
let host: FakeHost

interface SupervisorOverrides {
  readonly nodeId?: string
  readonly compileFails?: string
  readonly composer?: ComposerPort | null
  readonly integrationId?: string | null
  readonly storeLoaded?: boolean
}

function makeSupervisor(overrides: SupervisorOverrides = {}): BlockSupervisor {
  return new BlockSupervisor({
    nodeId: overrides.nodeId ?? 'hub',
    root,
    store,
    host,
    composer: overrides.composer ?? null,
    integrationId: () =>
      overrides.integrationId === undefined ? 'int_blocks' : overrides.integrationId,
    storeLoaded: () => overrides.storeLoaded ?? true,
    loadStore: async () => {},
    compile: async (source) =>
      overrides.compileFails !== undefined
        ? { ok: false, error: overrides.compileFails }
        : { ok: true, js: `/* compiled */ ${source.code}` },
    logger,
  })
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'core-blocks-'))
  store = new FakeStore()
  host = new FakeHost()
})

describe('converge — bringing enabled blocks up', () => {
  it('materialises and spawns an enabled block placed here', async () => {
    store.setBlocks([makeBlock()])
    await makeSupervisor().converge()

    expect(host.spawned).toHaveLength(1)
    expect(host.spawned[0]!.runnerId).toBe(blockAddonId('b1'))
    // The package the runner will read must actually be on disk — a spawn
    // against a directory that does not exist fails inside the child, far
    // from here.
    const manifest = JSON.parse(
      await fs.readFile(path.join(host.spawned[0]!.addonDir, 'package.json'), 'utf-8'),
    ) as { camstack: { addons: Array<{ entry: string }> } }
    const entry = manifest.camstack.addons[0]!.entry
    await expect(fs.access(path.resolve(host.spawned[0]!.addonDir, entry))).resolves.toBeUndefined()
    expect(store.statusWrites).toContainEqual({ blockId: 'b1', status: 'starting' })
  })

  it('materialises the block settings form into the wrapper, so its password is keychain-backed at runtime (D880)', async () => {
    store.setBlocks([
      makeBlock({
        settingsSchema: {
          sections: [
            { id: 's', title: 'S', fields: [{ type: 'password', key: 'pw', label: 'Password' }] },
          ],
        },
      }),
    ])
    await makeSupervisor().converge()
    const wrapper = await fs.readFile(path.join(root, 'b1', 'dist', 'index.js'), 'utf-8')
    expect(wrapper).toContain('"type":"password"')
  })

  it('does not respawn a block that is already running', async () => {
    store.setBlocks([makeBlock()])
    const sup = makeSupervisor()
    await sup.converge()
    host.runners = [{ name: blockAddonId('b1'), state: 'running' }]
    await sup.converge()

    expect(host.spawned).toHaveLength(1)
    expect(host.stopped).toHaveLength(0)
  })

  it('restarts a block whose code changed', async () => {
    store.setBlocks([makeBlock()])
    const sup = makeSupervisor()
    await sup.converge()
    host.runners = [{ name: blockAddonId('b1'), state: 'running' }]

    store.patch('b1', { code: 'export default () => 1', updatedAt: 2 })
    await sup.converge()

    expect(host.stopped).toEqual([blockAddonId('b1')])
    expect(host.spawned).toHaveLength(2)
    const js = await fs.readFile(path.join(root, 'b1', 'dist', 'block.js'), 'utf-8')
    expect(js).toContain('export default () => 1')
  })
})

describe('converge — taking blocks down', () => {
  it('stops the runner of a disabled block and reports it stopped', async () => {
    store.setBlocks([makeBlock()])
    const sup = makeSupervisor()
    await sup.converge()
    host.runners = [{ name: blockAddonId('b1'), state: 'running' }]

    store.patch('b1', { enabled: false })
    await sup.converge()

    expect(host.stopped).toEqual([blockAddonId('b1')])
    expect(store.statusWrites.at(-1)).toEqual({ blockId: 'b1', status: 'stopped' })
  })

  it('stops a runner whose block no longer exists', async () => {
    // A block deleted while its runner was up: nothing in the store points at
    // it, so only the runner name can identify it.
    host.runners = [{ name: blockAddonId('ghost'), state: 'running' }]
    store.setBlocks([])
    await makeSupervisor().converge()

    expect(host.stopped).toEqual([blockAddonId('ghost')])
  })

  it('leaves runners that are not blocks alone', async () => {
    host.runners = [{ name: 'pipeline-orchestrator', state: 'running' }]
    store.setBlocks([])
    await makeSupervisor().converge()

    expect(host.stopped).toEqual([])
  })
})

describe('converge — the ways a block does not run', () => {
  it('marks a block that does not compile failed, and never spawns it', async () => {
    store.setBlocks([makeBlock()])
    await makeSupervisor({ compileFails: 'Unexpected token }' }).converge()

    expect(host.spawned).toEqual([])
    expect(store.statusWrites).toEqual([
      { blockId: 'b1', status: 'failed', error: 'the block does not compile: Unexpected token }' },
    ])
  })

  it('marks a block placed on another node failed, with a message naming the node', async () => {
    // The failure this whole feature exists to avoid: an enabled block that
    // nothing anywhere is running, reported as if it were merely idle.
    store.setBlocks([makeBlock({ placement: 'agent-a' })])
    await makeSupervisor().converge()

    expect(host.spawned).toEqual([])
    const write = store.statusWrites.at(-1)
    expect(write?.status).toBe('failed')
    expect(write?.error).toContain('agent-a')
  })

  it('reports a spawn that threw, instead of leaving the block "starting" forever', async () => {
    store.setBlocks([makeBlock()])
    host.spawnError = 'ENOSPC: no space left on device'
    await makeSupervisor().converge()

    const write = store.statusWrites.at(-1)
    expect(write?.status).toBe('failed')
    expect(write?.error).toContain('ENOSPC')
  })

  it('treats "already running" as the outcome it wanted, not a failure', async () => {
    // A converge that raced a write finds the runner already up. Reporting
    // `failed` there would tell the operator a running block is broken.
    store.setBlocks([makeBlock()])
    host.spawnError = 'Runner "core-block-b1" already running'
    await makeSupervisor().converge()

    expect(store.statusWrites.at(-1)?.status).toBe('starting')
  })
})

describe('converge — reading the runner state back', () => {
  const cases: ReadonlyArray<readonly [BlockRunnerSnapshot['state'], CoreBlock['status']]> = [
    ['starting', 'starting'],
    ['running', 'running'],
    ['crashed', 'starting'],
    ['failed', 'failed'],
  ]

  for (const [runnerState, blockStatus] of cases) {
    it(`maps runner "${runnerState}" to block "${blockStatus}"`, async () => {
      store.setBlocks([makeBlock()])
      const sup = makeSupervisor()
      await sup.converge()
      host.runners = [{ name: blockAddonId('b1'), state: runnerState }]
      await sup.converge()

      expect(store.statusWrites.at(-1)?.status).toBe(blockStatus)
    })
  }

  it('explains a failed runner rather than just flagging it', async () => {
    store.setBlocks([makeBlock()])
    const sup = makeSupervisor()
    await sup.converge()
    host.runners = [{ name: blockAddonId('b1'), state: 'failed' }]
    await sup.converge()

    expect(store.statusWrites.at(-1)?.error).toMatch(/crash/i)
  })

  it('writes a status only when it changed', async () => {
    // Every write is a row rewrite AND moves `lastChangedAt`; a converge loop
    // that wrote every tick would make "last changed" meaningless.
    store.setBlocks([makeBlock()])
    const sup = makeSupervisor()
    await sup.converge()
    host.runners = [{ name: blockAddonId('b1'), state: 'running' }]
    await sup.converge()
    const afterFirstRunning = store.statusWrites.length
    await sup.converge()
    await sup.converge()

    expect(store.statusWrites.length).toBe(afterFirstRunning)
  })
})

describe('restart — the one nudge the operator gets', () => {
  it('stops the runner and brings it straight back', async () => {
    store.setBlocks([makeBlock()])
    const sup = makeSupervisor()
    await sup.converge()
    host.runners = [{ name: blockAddonId('b1'), state: 'running' }]

    await sup.restart('b1')

    expect(host.stopped).toEqual([blockAddonId('b1')])
    // Two spawns: the initial converge, and the one the restart forced. A
    // restart that only stopped would leave the block dead until the next
    // 15s tick — which reads as "the button killed my script".
    expect(host.spawned).toHaveLength(2)
    expect(host.runners.some((r) => r.name === blockAddonId('b1'))).toBe(true)
  })

  it('re-materialises the package rather than reusing the last spawn', async () => {
    // The whole point of forgetting `materialized` is that the code on disk is
    // written again. A restart that reused a stale package would run the source
    // the operator just replaced, and report `running` while doing it.
    store.setBlocks([makeBlock()])
    const sup = makeSupervisor()
    await sup.converge()
    host.runners = [{ name: blockAddonId('b1'), state: 'running' }]
    store.patch('b1', { code: 'export default () => () => {}', updatedAt: 2 })

    await sup.restart('b1')

    const dir = host.spawned.at(-1)?.addonDir
    expect(dir).toBeDefined()
    const js = await fs.readFile(path.join(dir ?? '', 'dist', 'block.js'), 'utf-8')
    expect(js).toContain('export default () => () => {}')
  })

  it('starts a block whose runner was already gone', async () => {
    // A stop that throws (or a runner that had already died) must not abort the
    // pass — the operator pressed restart to end up running, not to be told the
    // stop failed.
    store.setBlocks([makeBlock()])
    const sup = makeSupervisor()
    await sup.converge()
    host.runners = []

    await sup.restart('b1')

    expect(host.spawned).toHaveLength(2)
  })

  it('does NOT resurrect a disabled block', async () => {
    // Restart stores nothing and overrides nothing: `enabled` is the authority
    // and the reconcile pass is still what decides (D62).
    store.setBlocks([makeBlock({ enabled: false })])
    const sup = makeSupervisor()
    await sup.converge()

    await sup.restart('b1')

    expect(host.spawned).toHaveLength(0)
  })
})

class FakeComposer implements ComposerPort {
  readonly applied: ComposerApplyInput[] = []
  answer: (input: ComposerApplyInput) => ComposerApplyResult = (input) => ({
    blocks: input.blocks.map((b) => ({ blockId: b.id, status: b.enabled ? 'running' : 'stopped' })),
    acted: input.storeLoaded && input.integrationId !== null,
  })
  fail: string | null = null
  async apply(input: ComposerApplyInput): Promise<ComposerApplyResult> {
    this.applied.push(input)
    if (this.fail !== null) throw new Error(this.fail)
    return this.answer(input)
  }
}

const ROOM = roomCompositionExample({
  temperatureSources: ROOM_EXAMPLE_TEMPERATURE_SOURCES,
  motionSources: ROOM_EXAMPLE_MOTION_SOURCES,
  occupancyWindowMs: ROOM_OCCUPANCY_WINDOW_MS,
})
const composition = (over: Partial<CoreBlock> = {}): CoreBlock =>
  makeBlock({ id: 'c1', code: '', source: { kind: 'composition', composition: ROOM }, ...over })

describe('composition blocks', () => {
  it('are NEVER compiled or spawned — they go to the composer', async () => {
    const composer = new FakeComposer()
    store.setBlocks([composition()])
    await makeSupervisor({ composer }).converge()
    expect(host.spawned).toEqual([])
    expect(composer.applied[0]?.blocks.map((b) => b.id)).toEqual(['c1'])
    expect(store.get('c1')?.status).toBe('running')
  })

  it('mirror the composer verdict, reason included', async () => {
    const composer = new FakeComposer()
    composer.answer = () => ({
      blocks: [{ blockId: 'c1', status: 'failed', reason: 'source missing — x' }],
      acted: true,
    })
    store.setBlocks([composition()])
    await makeSupervisor({ composer }).converge()
    expect(store.get('c1')).toMatchObject({ status: 'failed', lastError: 'source missing — x' })
  })

  it('mirror a composer that is still STARTING as starting — not a failure, and no extra apply', async () => {
    const composer = new FakeComposer()
    composer.answer = (input) => ({
      blocks: input.blocks.map((b) => ({
        blockId: b.id,
        status: 'starting',
        reason: 'the block store has not loaded',
      })),
      acted: false,
    })
    store.setBlocks([composition()])
    await makeSupervisor({ composer }).converge()
    expect(store.get('c1')).toMatchObject({
      status: 'starting',
      lastError: 'the block store has not loaded',
    })
    expect(composer.applied).toHaveLength(1)
  })

  it('an unreachable composer does NOT overwrite a failure it cannot see (D49)', async () => {
    const composer = new FakeComposer()
    store.setBlocks([composition({ status: 'failed', lastError: 'source missing — x' })])
    composer.fail = 'ECONNREFUSED'
    await makeSupervisor({ composer }).converge()
    expect(store.get('c1')).toMatchObject({ status: 'failed', lastError: 'source missing — x' })
  })

  it('a composer runner whose breaker tripped fails every composition, by name', async () => {
    const composer = new FakeComposer()
    host.runners = [{ name: COMPOSER_RUNNER_ID, state: 'failed' }]
    store.setBlocks([composition()])
    await makeSupervisor({ composer }).converge()
    expect(store.get('c1')?.lastError).toContain('composer runner')
    expect(composer.applied).toEqual([])
  })

  it('no composer on this node fails every composition, by name', async () => {
    store.setBlocks([composition()])
    await makeSupervisor({ composer: null }).converge()
    expect(store.get('c1')).toMatchObject({ status: 'failed' })
    expect(store.get('c1')?.lastError).toContain('no composer')
  })

  it('keeps applying an EMPTY set twice after the last composition is deleted', async () => {
    const composer = new FakeComposer()
    store.setBlocks([composition()])
    const supervisor = makeSupervisor({ composer })
    await supervisor.converge()
    store.setBlocks([])
    await supervisor.converge()
    await supervisor.converge()
    await supervisor.converge()
    expect(composer.applied.map((a) => a.blocks.length)).toEqual([1, 0, 0])
  })

  it('an empty apply the composer could not act on is still owed', async () => {
    const composer = new FakeComposer()
    store.setBlocks([])
    const supervisor = makeSupervisor({ composer, storeLoaded: false })
    await supervisor.converge()
    await supervisor.converge()
    await supervisor.converge()
    expect(composer.applied.map((a) => a.storeLoaded)).toEqual([false, false, false])
  })

  it('an empty apply the composer REFUSED (its own rows unread) is still owed, even with the store loaded', async () => {
    const composer = new FakeComposer()
    const refusals = [true, true]
    composer.answer = () => ({ blocks: [], acted: refusals.shift() === undefined })
    store.setBlocks([])
    const supervisor = makeSupervisor({ composer })
    for (let i = 0; i < 6; i += 1) await supervisor.converge()
    // Two refused, then the two owed ones the composer acted on — then silence.
    expect(composer.applied).toHaveLength(4)
  })

  it('restart of a composition stops no runner and asks the composer to rebuild it', async () => {
    const composer = new FakeComposer()
    store.setBlocks([composition()])
    const supervisor = makeSupervisor({ composer })
    await supervisor.restart('c1')
    expect(host.stopped).toEqual([])
    expect(composer.applied.at(-1)?.restartBlockIds).toEqual(['c1'])
    await supervisor.converge()
    expect(composer.applied.at(-1)?.restartBlockIds).toEqual([])
  })

  it('sends storeLoaded and the integration id', async () => {
    const composer = new FakeComposer()
    store.setBlocks([composition()])
    await makeSupervisor({ composer, integrationId: 'int_9', storeLoaded: false }).converge()
    expect(composer.applied[0]).toMatchObject({ integrationId: 'int_9', storeLoaded: false })
  })

  it('a FAILED core_blocks read reaches the composer as storeLoaded=false, and the next converge RETRIES it (D49, D3)', async () => {
    const stored = composition()
    const { records } = await coreBlockRecordsHarness(logger)
    const inner = records.kind(coreBlocksRecordKinds.blocks)
    await inner.put({
      id: stored.id,
      data: { name: stored.name, enabled: true, placement: 'hub', updatedAt: 1, block: stored },
    })
    let left = 2
    const kind = {
      ...inner,
      query: async (q: Parameters<typeof inner.query>[0]): ReturnType<typeof inner.query> => {
        if (left > 0) {
          left -= 1
          throw new Error('SQLITE_BUSY')
        }
        return inner.query(q)
      },
    }
    const blocks = new CoreBlockStore({ blocks: kind, logger })
    await blocks.load() // boot: fails
    const composer = new FakeComposer()
    const supervisor = new BlockSupervisor({
      nodeId: 'hub',
      root,
      store: blocks,
      host,
      composer,
      integrationId: () => 'int_blocks',
      storeLoaded: () => blocks.isLoaded(),
      loadStore: () => blocks.load(),
      compile: async () => ({ ok: true, js: '' }),
      logger,
    })
    await supervisor.converge() // retry fails too
    expect(composer.applied).toEqual([
      {
        integrationId: 'int_blocks',
        storeLoaded: false,
        blocks: [],
        restartBlockIds: [],
        unreadableBlocks: [],
        retiredBlockIds: [],
      },
    ])
    await supervisor.converge() // retry succeeds
    expect(composer.applied[1]).toMatchObject({ storeLoaded: true, blocks: [{ id: 'c1' }] })
    await supervisor.converge()
    expect(blocks.isLoaded()).toBe(true)
  })

  it('an UNREADABLE stored composition reaches the composer by id — never simply absent (D49)', async () => {
    const stored = composition()
    const { store: blocks, records } = await coreBlockRecordsHarness(logger)
    const kind = records.kind(coreBlocksRecordKinds.blocks)
    await kind.put({
      id: stored.id,
      data: { name: stored.name, enabled: true, placement: 'hub', updatedAt: 1, block: stored },
    })
    await kind.put({
      id: 'c2',
      data: {
        name: 'Broken',
        enabled: true,
        placement: 'hub',
        updatedAt: 1,
        block: { ...stored, id: 'c2', source: { kind: 'composition', composition: { bogus: 1 } } },
      },
    })
    await blocks.load()
    const composer = new FakeComposer()
    await new BlockSupervisor({
      nodeId: 'hub',
      root,
      store: blocks,
      host,
      composer,
      integrationId: () => 'int_blocks',
      storeLoaded: () => blocks.isLoaded(),
      loadStore: () => blocks.load(),
      compile: async () => ({ ok: true, js: '' }),
      logger,
    }).converge()
    expect(composer.applied[0]).toMatchObject({
      storeLoaded: true,
      blocks: [{ id: 'c1' }],
      unreadableBlocks: [{ id: 'c2', name: 'Broken', error: expect.any(String) }],
    })
  })

  it('an unreadable composition alone is applied on EVERY converge — it is never an owed-empty set', async () => {
    const composer = new FakeComposer()
    store.setBlocks([])
    store.unreadable = [{ id: 'c2', name: 'Broken', error: 'bad' }]
    const supervisor = makeSupervisor({ composer })
    for (let i = 0; i < 4; i += 1) await supervisor.converge()
    expect(composer.applied.map((a) => a.unreadableBlocks.map((u) => u.id))).toEqual([
      ['c2'],
      ['c2'],
      ['c2'],
      ['c2'],
    ])
  })

  it('an unreachable composer is warned ONCE per run, and its return is logged once', async () => {
    const log = recordingLogger()
    const composer = new FakeComposer()
    composer.fail = 'ECONNREFUSED'
    store.setBlocks([composition()])
    const supervisor = new BlockSupervisor({
      nodeId: 'hub',
      root,
      store,
      host,
      composer,
      integrationId: () => 'int_blocks',
      storeLoaded: () => true,
      loadStore: async () => {},
      compile: async () => ({ ok: true, js: '' }),
      logger: log.logger,
    })
    await supervisor.converge()
    await supervisor.converge()
    await supervisor.converge()
    const warns = () =>
      log.lines.filter(
        (l) => l.level === 'warn' && l.message.includes('composer could not be reached'),
      )
    expect(warns()).toHaveLength(1)
    composer.fail = null
    await supervisor.converge()
    const back = log.lines.filter(
      (l) => l.level === 'info' && l.message.includes('composer answered'),
    )
    expect(back).toHaveLength(1)
    expect(back[0]?.extras?.meta).toMatchObject({ failedApplies: 3 })
  })

  it('retireComposition names the deleted block and returns a release the composer could not land', async () => {
    const composer = new FakeComposer()
    composer.answer = (input) => ({
      blocks: input.blocks.map((b) => ({ blockId: b.id, status: 'running' })),
      acted: true,
      unreleasedClaims:
        input.retiredBlockIds?.includes('c1') === true
          ? [{ deviceId: 101, capName: 'doorbell', owner: 'c1', error: 'row-unreadable' }]
          : [],
    })
    store.setBlocks([composition()])
    const supervisor = makeSupervisor({ composer })
    await supervisor.converge()

    store.setBlocks([])
    const unreleased = await supervisor.retireComposition('c1')

    expect(unreleased).toEqual([
      { deviceId: 101, capName: 'doorbell', owner: 'c1', error: 'row-unreadable' },
    ])
    const retired = composer.applied.filter((input) => input.retiredBlockIds?.includes('c1'))
    expect(retired.length).toBeGreaterThan(0)
    await supervisor.converge()
    expect(composer.applied.at(-1)?.retiredBlockIds).toContain('c1')
  })
})

describe('recipe blocks', () => {
  it('are refused by name and never compiled or spawned', async () => {
    store.setBlocks([
      makeBlock({
        id: 'r1',
        code: '',
        source: {
          kind: 'recipe',
          recipe: { triggers: [{ kind: 'manual' }], actions: [{ kind: 'wait', seconds: 1 }] },
        },
      }),
    ])
    await makeSupervisor().converge()
    expect(host.spawned).toEqual([])
    expect(store.get('r1')).toMatchObject({ status: 'failed' })
    expect(store.get('r1')?.lastError).toContain('recipe block cannot run')
  })
})
