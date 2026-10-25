/**
 * Phase 4 (D2/D5/D6) integration coverage for the unified `addon-runner`
 * process model. Four layers, each pinning one of the Phase-4 invariants:
 *
 *   1. `$process.spawnRunner` env wiring (unit). Mocks `child_process.spawn`
 *      so we can assert the env contract (runner id, addons JSON, parent
 *      node id) without paying the real subprocess cost. Runs in CI.
 *
 *   2. Runner-plan contract (plan-level, invariants (a)+(b)). Re-derives the
 *      `buildAddonGroupPlan` shape from its building-block pure functions
 *      (`resolveRunnerId`, `resolveAddonPlacement`) and asserts:
 *        (a) every addon with NO declared `execution.group` gets its OWN
 *            single-addon runner — one addon, one process, zero exceptions
 *            (D2/D9). The former `pipeline` co-location group was dissolved
 *            by Phase 5, so EVERY addon is now groupless.
 *        (b) `resolveRunnerId` still collapses any addons that DID share a
 *            group onto one runner — the mechanism survives even though no
 *            shipped manifest declares a group anymore.
 *      Plan-level rather than a multi-process boot because the boot is
 *      flaky in CI; the plan is the deterministic contract.
 *
 *   3. Runner disconnect → cap drop (integration, invariant (c)). A TCP
 *      cluster: a runner node registers caps via `$hub.registerNode`, then
 *      its broker stops → Moleculer fires `$node.disconnected` → the hub
 *      drops every cap of that node. No timers, no scans — pure liveness.
 *
 *   4. End-to-end with a real subprocess + synthetic addons. Disabled by
 *      default (long-running, needs built kernel dist). Toggle on with
 *      `RUN_ADDON_RUNNER_E2E=1`.
 *
 * Invariant (d) — the crash circuit-breaker tripping to `failed` after
 * `MAX_CRASHES_IN_WINDOW` crashes — is covered at the unit level by
 * `crash-supervisor.spec.ts` (`CrashSupervisor`), the pure decision engine
 * `process-service.ts` drives. Not re-tested here.
 */

import * as cp from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AddonDeclaration, RunnerAddonPlacement, RunnerPlan } from '@camstack/types'
import { isIsolatedBuiltin, resolveAddonPlacement, resolveRunnerId } from '@camstack/types'
import { ServiceBroker } from 'moleculer'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { HubServiceDeps } from '../../moleculer/hub-service.js'
import { createHubService } from '../../moleculer/hub-service.js'
import { HubNodeRegistry } from '../../moleculer/node-registry.js'
import { inertProcessGroups } from './inert-process-groups.js'
import { createProcessService } from '../../moleculer/process-service.js'
import {
  HEAVY_MAX_OLD_MB_DEFAULT,
  LIGHT_V8_POOL_SIZE_DEFAULT,
} from '../../moleculer/runner-heap-flags.js'
import {
  RUNNER_MALLOC_ARENA_MAX_DEFAULT,
  RUNNER_VIPS_CONCURRENCY_DEFAULT,
} from '../../moleculer/runner-native-allocator.js'
import type { RegisteredChild } from '../../transport/child-cap-protocol.js'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import { LocalChildRegistry } from '../../transport/local-child-registry.js'
import { localEndpointPath } from '../../transport/local-endpoint-path.js'

// ---------------------------------------------------------------------------
// Layer 1 — `$process.spawnRunner` unit-level wiring
// ---------------------------------------------------------------------------

interface FakeChild extends EventEmitter {
  pid: number
  stdout: EventEmitter
  stderr: EventEmitter
  kill: (sig?: string) => boolean
}

function makeFakeChild(pid: number): FakeChild {
  const ee = new EventEmitter() as FakeChild
  ee.pid = pid
  ee.stdout = new EventEmitter()
  ee.stderr = new EventEmitter()
  ee.kill = () => true
  return ee
}

describe('$process.spawnRunner unit wiring', { timeout: 15000 }, () => {
  const broker = new ServiceBroker({
    nodeID: 'hub',
    transporter: 'Fake',
    logger: false,
  })
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-runner-spec-'))
  const spawnCalls: Array<{
    command: string
    args: readonly string[]
    env: Record<string, string>
  }> = []
  let pidCounter = 90000

  // Inject a fake spawn into the service factory. Using DI rather than
  // `vi.spyOn(cp, 'spawn')` because ESM module exports are non-
  // configurable and Vitest can't redefine them at runtime.
  const fakeSpawn = (
    command: string,
    args: readonly string[],
    opts: cp.SpawnOptions,
  ): cp.ChildProcess => {
    spawnCalls.push({ command, args, env: (opts.env ?? {}) as Record<string, string> })
    return makeFakeChild(++pidCounter) as unknown as cp.ChildProcess
  }

  beforeAll(async () => {
    broker.createService(
      createProcessService('hub', tmpDir, {
        spawnFn: fakeSpawn,
        processGroups: inertProcessGroups,
      }),
    )
    await broker.start()
  })

  afterAll(async () => {
    await broker.stop()
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* */
    }
  })

  it('rejects when addons array is empty', async () => {
    await expect(
      broker.call('$process.spawnRunner', { runnerId: 'test-runner', addons: [] }),
    ).rejects.toThrow(/non-empty addons array/)
  })

  it('rejects on duplicate runner spawn', async () => {
    const addons = [{ addonId: 'a', addonDir: '/tmp/a' }]
    await broker.call('$process.spawnRunner', { runnerId: 'dup-group', addons })
    await expect(
      broker.call('$process.spawnRunner', { runnerId: 'dup-group', addons }),
    ).rejects.toThrow(/already running/)
  })

  it('spawns addon-runner.js with the right env vars', async () => {
    const addons = [
      { addonId: 'detection-pipeline', addonDir: '/opt/addons/detection-pipeline' },
      { addonId: 'decoder-nodeav', addonDir: '/opt/addons/decoder-nodeav' },
    ]
    const beforeCount = spawnCalls.length
    const result = await broker.call<
      { pid: number; nodeId: string; addonIds: readonly string[] },
      unknown
    >('$process.spawnRunner', { runnerId: 'detection', addons })

    expect(result.nodeId).toBe('hub/detection')
    expect(result.addonIds).toEqual(['detection-pipeline', 'decoder-nodeav'])
    expect(spawnCalls.length).toBeGreaterThan(beforeCount)
    const lastCall = spawnCalls[spawnCalls.length - 1]!
    // Spawn binary is now `process.execPath` (the parent's interpreter)
    // so this works inside packaged Electron where `node` isn't on PATH.
    // Same string in test contexts (vitest runs under plain node).
    expect(lastCall.command).toBe(process.execPath)
    expect(lastCall.args.at(-1)).toMatch(/addon-runner\.js$/)

    const env = lastCall.env
    expect(env.CAMSTACK_RUNNER_ID).toBe('detection')
    expect(env.CAMSTACK_PARENT_NODE_ID).toBe('hub')
    expect(env.CAMSTACK_RUNNER_ADDONS).toBeDefined()
    const parsed = JSON.parse(env.CAMSTACK_RUNNER_ADDONS!) as Array<{
      addonId: string
      addonDir: string
    }>
    expect(parsed).toEqual(addons)
  })

  it('carries the native-allocator env — the half of a runner s memory no V8 flag reaches', () => {
    // glibc reads MALLOC_ARENA_MAX ONCE, at malloc init. It has to be on the
    // env handed to `spawn`; setting it on the child afterwards does nothing.
    // The rules themselves live in `runner-native-allocator.spec.ts` — this
    // pins that the spawn path actually applies them.
    const env = spawnCalls[spawnCalls.length - 1]!.env
    if (process.platform === 'linux') {
      expect(env.MALLOC_ARENA_MAX).toBe(String(RUNNER_MALLOC_ARENA_MAX_DEFAULT))
      // Never the arena bound alone: sharp reads MALLOC_ARENA_MAX natively and
      // lifts libvips concurrency from 1 to availableParallelism() the moment it
      // is set (measured: 1 → 20 on the live 20-core hub).
      expect(env.VIPS_CONCURRENCY).toBe(String(RUNNER_VIPS_CONCURRENCY_DEFAULT))
    } else {
      // Off Linux the pair is not merely useless, it is harmful — see the
      // platform case in `runner-native-allocator.spec.ts`. A developer running
      // this suite on macOS must see the SAME refusal the darwin agent gets.
      expect(env.MALLOC_ARENA_MAX).toBeUndefined()
      expect(env.VIPS_CONCURRENCY).toBeUndefined()
    }
  })

  it('spawns a single-addon runner with a size-1 addons array', async () => {
    const addons = [{ addonId: 'provider-rtsp', addonDir: '/opt/addons/provider-rtsp' }]
    const result = await broker.call<
      { pid: number; nodeId: string; addonIds: readonly string[] },
      unknown
    >('$process.spawnRunner', { runnerId: 'provider-rtsp', addons })
    expect(result.nodeId).toBe('hub/provider-rtsp')
    expect(result.addonIds).toEqual(['provider-rtsp'])
    const lastCall = spawnCalls[spawnCalls.length - 1]!
    expect(lastCall.args.at(-1)).toMatch(/addon-runner\.js$/)
    const parsed = JSON.parse(lastCall.env.CAMSTACK_RUNNER_ADDONS!) as Array<{ addonId: string }>
    expect(parsed).toEqual(addons)
  })

  /**
   * Classification is manifest-driven (`execution.heapProfile` /
   * `execution.maxOldSpaceMb`) — write real package.json manifests.
   * `slug` keeps each fixture dir unique so the per-(dir,id) profile cache in
   * `process-service` never serves one test's manifest to another.
   */
  const mkAddonManifestDir = (
    slug: string,
    entries: ReadonlyArray<{
      readonly id: string
      readonly profile?: 'light' | 'heavy'
      readonly maxOldSpaceMb?: number
      readonly rssBudgetMb?: number
      readonly semiSpaceMb?: number
      readonly initialOldSpaceMb?: number
    }>,
  ): string => {
    const dir = path.join(tmpDir, `heapfix-${slug}`)
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        camstack: {
          addons: entries.map((e) => ({
            id: e.id,
            execution: {
              ...(e.profile !== undefined ? { heapProfile: e.profile } : {}),
              ...(e.maxOldSpaceMb !== undefined ? { maxOldSpaceMb: e.maxOldSpaceMb } : {}),
              ...(e.rssBudgetMb !== undefined ? { rssBudgetMb: e.rssBudgetMb } : {}),
              ...(e.semiSpaceMb !== undefined ? { semiSpaceMb: e.semiSpaceMb } : {}),
              ...(e.initialOldSpaceMb !== undefined
                ? { initialOldSpaceMb: e.initialOldSpaceMb }
                : {}),
            },
          })),
        },
      }),
    )
    return path.join(dir, 'dist') // addonDir points at dist; manifest is one level up
  }

  /** The `N` of `--max-old-space-size=N` in a spawn's argv, or null when the
   *  runner was spawned with no old-space ceiling at all. */
  const oldSpaceCeilingMb = (args: readonly string[]): number | null => {
    const flag = args.find((a) => a.startsWith('--max-old-space-size='))
    if (flag === undefined) return null
    return Number.parseInt(flag.slice('--max-old-space-size='.length), 10)
  }

  it('spawns NO runner without an old-space ceiling — a heavy runner gets its class default', async () => {
    // The behaviour under test is "the heap cannot grow without bound", not
    // "the constant is 1024": a heavy runner that comes back with no ceiling at
    // all is the regression, whatever number is configured.
    await broker.call('$process.spawnRunner', {
      runnerId: 'ceiling-heavy-default',
      addons: [
        {
          addonId: 'recorder',
          addonDir: mkAddonManifestDir('heavy-default', [{ id: 'recorder', profile: 'heavy' }]),
        },
      ],
    })
    const call = spawnCalls[spawnCalls.length - 1]!
    expect(oldSpaceCeilingMb(call.args)).toBe(HEAVY_MAX_OLD_MB_DEFAULT)
    // Heavy keeps V8's default young generation — the ceiling is the only change.
    expect(call.args.some((a) => a.startsWith('--max-semi-space-size='))).toBe(false)
  })

  it('takes the ceiling from the manifest when an addon declares its own class', async () => {
    await broker.call('$process.spawnRunner', {
      runnerId: 'ceiling-heavy-declared',
      addons: [
        {
          addonId: 'stream-broker',
          addonDir: mkAddonManifestDir('heavy-declared', [
            { id: 'stream-broker', profile: 'heavy', maxOldSpaceMb: 2048 },
          ]),
        },
      ],
    })
    const call = spawnCalls[spawnCalls.length - 1]!
    expect(oldSpaceCeilingMb(call.args)).toBe(2048)
  })

  it('co-location never silences the hungriest member — the runner takes the MAX declared', async () => {
    const dir = mkAddonManifestDir('heavy-group', [
      { id: 'small-heavy', profile: 'heavy', maxOldSpaceMb: 256 },
      { id: 'big-heavy', profile: 'heavy', maxOldSpaceMb: 3072 },
    ])
    await broker.call('$process.spawnRunner', {
      runnerId: 'ceiling-heavy-group',
      addons: [
        { addonId: 'small-heavy', addonDir: dir },
        { addonId: 'big-heavy', addonDir: dir },
      ],
    })
    const call = spawnCalls[spawnCalls.length - 1]!
    expect(oldSpaceCeilingMb(call.args)).toBe(3072)
  })

  /**
   * ## Young generation and initial old space are the manifest's to shape
   *
   * A heavy runner keeps V8's 64 MB young generation by default. The hub's
   * `stream-broker` (~100 MB live, ~11 k RTP packets/s) ran ~166 major GCs a
   * minute and ZERO scavenges under it: V8 sizes a mark-compact's old-space
   * headroom from the live set, and when that headroom is below the young
   * generation every scavenge promotes enough to restart marking. The remedy is
   * two flags on the spawn command line — `v8.setFlagsFromString` at runtime
   * does nothing to either space — and the numbers belong next to the addon that
   * measured them, like `maxOldSpaceMb`.
   */
  describe('manifest-declared heap shaping (semiSpaceMb / initialOldSpaceMb)', () => {
    const flagValue = (args: readonly string[], flag: string): number | null => {
      const hit = args.find((a) => a.startsWith(`${flag}=`))
      return hit === undefined ? null : Number.parseInt(hit.slice(flag.length + 1), 10)
    }

    it('a heavy addon declaring both gets both on the argv, ahead of the runner path', async () => {
      await broker.call('$process.spawnRunner', {
        runnerId: 'shape-declared',
        addons: [
          {
            addonId: 'stream-broker',
            addonDir: mkAddonManifestDir('shape-declared', [
              { id: 'stream-broker', profile: 'heavy', semiSpaceMb: 8, initialOldSpaceMb: 512 },
            ]),
          },
        ],
      })
      const call = spawnCalls[spawnCalls.length - 1]!
      expect(flagValue(call.args, '--max-semi-space-size')).toBe(8)
      expect(flagValue(call.args, '--initial-old-space-size')).toBe(512)
      // Still a heavy runner: the class ceiling rides along, the light pool bound does not.
      expect(oldSpaceCeilingMb(call.args)).toBe(HEAVY_MAX_OLD_MB_DEFAULT)
      expect(call.args.some((a) => a.startsWith('--v8-pool-size='))).toBe(false)
      expect(call.args[call.args.length - 1]).toMatch(/addon-runner\.js$/)
    })

    it('a heavy addon declaring neither gets neither — nothing new for the other runners', async () => {
      await broker.call('$process.spawnRunner', {
        runnerId: 'shape-undeclared',
        addons: [
          {
            addonId: 'recorder',
            addonDir: mkAddonManifestDir('shape-undeclared', [
              { id: 'recorder', profile: 'heavy' },
            ]),
          },
        ],
      })
      const call = spawnCalls[spawnCalls.length - 1]!
      expect(call.args.some((a) => a.startsWith('--max-semi-space-size='))).toBe(false)
      expect(call.args.some((a) => a.startsWith('--initial-old-space-size='))).toBe(false)
    })

    it('a grouped runner takes the MAX of each — a quieter co-tenant never shrinks a member s young generation', async () => {
      const dir = mkAddonManifestDir('shape-group', [
        { id: 'quiet', profile: 'heavy', semiSpaceMb: 4, initialOldSpaceMb: 64 },
        { id: 'churny', profile: 'heavy', semiSpaceMb: 16, initialOldSpaceMb: 256 },
        { id: 'silent', profile: 'heavy' },
      ])
      await broker.call('$process.spawnRunner', {
        runnerId: 'shape-group',
        addons: [
          { addonId: 'quiet', addonDir: dir },
          { addonId: 'churny', addonDir: dir },
          { addonId: 'silent', addonDir: dir },
        ],
      })
      const call = spawnCalls[spawnCalls.length - 1]!
      expect(flagValue(call.args, '--max-semi-space-size')).toBe(16)
      expect(flagValue(call.args, '--initial-old-space-size')).toBe(256)
    })

    it('the initial old space is clamped to the runner s ceiling — V8 refuses one above it', async () => {
      await broker.call('$process.spawnRunner', {
        runnerId: 'shape-clamped',
        addons: [
          {
            addonId: 'tight',
            addonDir: mkAddonManifestDir('shape-clamped', [
              { id: 'tight', profile: 'heavy', maxOldSpaceMb: 256, initialOldSpaceMb: 4096 },
            ]),
          },
        ],
      })
      const call = spawnCalls[spawnCalls.length - 1]!
      expect(oldSpaceCeilingMb(call.args)).toBe(256)
      expect(flagValue(call.args, '--initial-old-space-size')).toBe(256)
    })

    it('an out-of-range value is not a declaration: the class default stays', async () => {
      // 0 and 1024 MB semi-space are outside [1, 256]; 8 MB initial old space is below 16.
      await broker.call('$process.spawnRunner', {
        runnerId: 'shape-out-of-range',
        addons: [
          {
            addonId: 'odd',
            addonDir: mkAddonManifestDir('shape-out-of-range', [
              { id: 'odd', profile: 'light', semiSpaceMb: 1024, initialOldSpaceMb: 8 },
            ]),
          },
        ],
      })
      const call = spawnCalls[spawnCalls.length - 1]!
      expect(flagValue(call.args, '--max-semi-space-size')).toBe(2)
      expect(call.args.some((a) => a.startsWith('--initial-old-space-size='))).toBe(false)
    })

    it('a light addon may declare a larger young generation than its class default', async () => {
      await broker.call('$process.spawnRunner', {
        runnerId: 'shape-light-declared',
        addons: [
          {
            addonId: 'busy-light',
            addonDir: mkAddonManifestDir('shape-light-declared', [
              { id: 'busy-light', profile: 'light', semiSpaceMb: 4 },
            ]),
          },
        ],
      })
      const call = spawnCalls[spawnCalls.length - 1]!
      expect(flagValue(call.args, '--max-semi-space-size')).toBe(4)
      expect(call.args).toContain(`--v8-pool-size=${LIGHT_V8_POOL_SIZE_DEFAULT}`)
    })
  })

  /**
   * ## The RSS budget the watchdog alarms on reaches the child, or it is nothing
   *
   * `--max-old-space-size` bounds old space; the watchdog's `stranded` metric
   * subtracts `external` by construction. Neither can see a Buffer climb, which
   * is 96% of what OOM-killed `hub/pipeline-analytics` at 11.4GB on 2026-08-27
   * with the ceiling in force the whole time. RSS is the number the host's OOM
   * killer reads, and it only becomes checkable if the manifest's declaration
   * survives the fork.
   */
  describe('the declared RSS budget crosses the fork', () => {
    it('carries execution.rssBudgetMb from the manifest into the child env', async () => {
      await broker.call('$process.spawnRunner', {
        runnerId: 'rss-declared',
        addons: [
          {
            addonId: 'stream-broker',
            addonDir: mkAddonManifestDir('rss-declared', [
              { id: 'stream-broker', profile: 'heavy', rssBudgetMb: 2048 },
            ]),
          },
        ],
      })
      expect(spawnCalls[spawnCalls.length - 1]!.env.CAMSTACK_RUNNER_RSS_BUDGET_MB).toBe('2048')
    })

    it('co-location takes the MAX — an under-sized budget cries wolf for the whole group', async () => {
      const dir = mkAddonManifestDir('rss-group', [
        { id: 'small-heavy', profile: 'heavy', rssBudgetMb: 512 },
        { id: 'big-heavy', profile: 'heavy', rssBudgetMb: 3584 },
      ])
      await broker.call('$process.spawnRunner', {
        runnerId: 'rss-group',
        addons: [
          { addonId: 'small-heavy', addonDir: dir },
          { addonId: 'big-heavy', addonDir: dir },
        ],
      })
      expect(spawnCalls[spawnCalls.length - 1]!.env.CAMSTACK_RUNNER_RSS_BUDGET_MB).toBe('3584')
    })

    it('an undeclared budget is ABSENT, never inherited from the container', async () => {
      // The child reports itself unwatched when the var is missing. A
      // container-wide value leaking through `...process.env` would silently
      // become a budget the addon never chose — the invented default this whole
      // mechanism exists to refuse.
      const previous = process.env['CAMSTACK_RUNNER_RSS_BUDGET_MB']
      process.env['CAMSTACK_RUNNER_RSS_BUDGET_MB'] = '9999'
      try {
        await broker.call('$process.spawnRunner', {
          runnerId: 'rss-undeclared',
          addons: [
            {
              addonId: 'decoder-nodeav',
              addonDir: mkAddonManifestDir('rss-undeclared', [
                { id: 'decoder-nodeav', profile: 'heavy' },
              ]),
            },
          ],
        })
        expect(spawnCalls[spawnCalls.length - 1]!.env.CAMSTACK_RUNNER_RSS_BUDGET_MB).toBeUndefined()
      } finally {
        if (previous === undefined) delete process.env['CAMSTACK_RUNNER_RSS_BUDGET_MB']
        else process.env['CAMSTACK_RUNNER_RSS_BUDGET_MB'] = previous
      }
    })

    /**
     * ## The half of the rule the shipped manifests can actually prove
     *
     * The MAX itself is proved by the fixture case above (512 vs 3584 → 3584);
     * flipping `Math.max` to `Math.min` in `runnerRssBudgetMb` turns that test
     * red and this one does NOT — because no group that ships today has two
     * members declaring different budgets, so `min` and `max` agree on all of
     * them. Saying otherwise here would be a comment that describes a guard
     * nobody has.
     *
     * What this case does prove is the complementary half, and it is the half
     * the real manifests are exposed to: `ml` is three addons in three separate
     * packages (`addon-ai`, `addon-benchmark`, `addon-model-studio`) and only
     * `model-studio` — the member that loads model weights, so the member whose
     * role knows the number — declares anything. A reduction that required
     * every member to agree, or that took the FIRST addon's value, would leave
     * this runner unwatched depending on registration order. Unwatched is the
     * state `hub/pipeline-analytics` was in when it reached 11.4GB.
     *
     * When a second member of any shipped group declares a budget, move the MAX
     * assertion here and delete this note.
     */
    it('the shipped `ml` group is watched by its one declaring member', async () => {
      const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..', '..')
      const pkgDist = (name: string): string => path.join(repoRoot, 'packages', name, 'dist')
      await broker.call('$process.spawnRunner', {
        runnerId: 'ml',
        addons: [
          { addonId: 'ai', addonDir: pkgDist('addon-ai') },
          { addonId: 'benchmark', addonDir: pkgDist('addon-benchmark') },
          { addonId: 'model-studio', addonDir: pkgDist('addon-model-studio') },
        ],
      })
      // `ai` and `benchmark` declare nothing; `model-studio` declares 2048.
      expect(spawnCalls[spawnCalls.length - 1]!.env.CAMSTACK_RUNNER_RSS_BUDGET_MB).toBe('2048')
    })

    /**
     * The one SHIPPED manifest that shapes its heap: `stream-broker` in
     * `packages/addon-pipeline/package.json` (8 MB semi-space, 512 MB initial old
     * space — measured 232 → 21 major GCs a minute on the hub's load). Its
     * group-mate on the same manifest, `recorder`, declares neither, so the
     * runner that hosts it alone gets nothing new.
     */
    it('the shipped stream-broker manifest yields both shaping flags; a sibling heavy addon yields neither', async () => {
      const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..', '..')
      const pipelineDist = path.join(repoRoot, 'packages', 'addon-pipeline', 'dist')
      await broker.call('$process.spawnRunner', {
        runnerId: 'stream-broker',
        addons: [{ addonId: 'stream-broker', addonDir: pipelineDist }],
      })
      const brokerCall = spawnCalls[spawnCalls.length - 1]!
      expect(brokerCall.args).toContain('--max-semi-space-size=8')
      expect(brokerCall.args).toContain('--initial-old-space-size=512')
      expect(oldSpaceCeilingMb(brokerCall.args)).toBe(HEAVY_MAX_OLD_MB_DEFAULT)

      await broker.call('$process.spawnRunner', {
        runnerId: 'recorder',
        addons: [{ addonId: 'recorder', addonDir: pipelineDist }],
      })
      const recorderCall = spawnCalls[spawnCalls.length - 1]!
      expect(recorderCall.args.some((a) => a.startsWith('--max-semi-space-size='))).toBe(false)
      expect(recorderCall.args.some((a) => a.startsWith('--initial-old-space-size='))).toBe(false)
    })
  })

  it('prepends the light-runner V8 heap flag; a heavy runner keeps V8 young-gen defaults (Block D)', async () => {
    // Classification is manifest-driven (execution.heapProfile) — write real package.json manifests.
    const mkAddonDir = (id: string, profile: 'light' | 'heavy' | null): string => {
      const dir = path.join(tmpDir, `blockd-${id}`)
      fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
      const execution = profile === null ? {} : { heapProfile: profile }
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ camstack: { addons: [{ id, execution }] } }),
      )
      return path.join(dir, 'dist') // addonDir points at dist; manifest is one level up
    }

    // No declared profile → light (default): the young-gen cap is prepended before the runner path.
    await broker.call('$process.spawnRunner', {
      runnerId: 'blockd-light',
      addons: [{ addonId: 'provider-rtsp', addonDir: mkAddonDir('provider-rtsp', null) }],
    })
    const lightCall = spawnCalls[spawnCalls.length - 1]!
    expect(lightCall.args).toContain('--max-semi-space-size=2')
    expect(lightCall.args.indexOf('--max-semi-space-size=2')).toBeLessThan(
      lightCall.args.length - 1,
    )
    // The child must KNOW its class: the heavy-runner heap watch + stranded-page
    // reclaimer (heap-watch.ts) starts inside addon-runner, gated on this env.
    expect(lightCall.env.CAMSTACK_RUNNER_HEAP_PROFILE).toBe('light')

    // Manifest declares heapProfile: 'heavy' → V8's DEFAULT young generation (no semi-space flag),
    // but never an unbounded old space: the ceiling from HEAVY_MAX_OLD_MB_DEFAULT rides along.
    await broker.call('$process.spawnRunner', {
      runnerId: 'blockd-heavy',
      addons: [{ addonId: 'decoder-nodeav', addonDir: mkAddonDir('decoder-nodeav', 'heavy') }],
    })
    const heavyCall = spawnCalls[spawnCalls.length - 1]!
    expect(heavyCall.args.some((a) => a.startsWith('--max-semi-space-size='))).toBe(false)
    expect(heavyCall.args).toEqual([
      `--max-old-space-size=${HEAVY_MAX_OLD_MB_DEFAULT}`,
      expect.stringMatching(/addon-runner\.js$/),
    ])
    // A heavy child starts the heap watch + reclaimer on itself (uncapped
    // media-path runners have NO old-space ceiling to create GC pressure, so
    // stranded pages are returned by the reclaim pass instead — heap-watch.ts).
    expect(heavyCall.env.CAMSTACK_RUNNER_HEAP_PROFILE).toBe('heavy')
  })

  /**
   * A container cgroup counts THREADS, not processes, and this cluster forks a
   * runner per addon. Measured on the live hub 2026-09-18 (20 cores,
   * `pids.max=2048`, `pids.current` 991 after 22 fork refusals in 45 minutes
   * earlier that day): 29 LIGHT runners held 274 threads between them — Node
   * gives every one of them a V8 platform pool of 4 regardless of how little
   * background GC a control-plane addon generates.
   *
   * Two, not zero: `--v8-pool-size=0` does NOT disable the pool, it tells V8 to
   * size it from the detected parallelism. Measured locally the same day — 11
   * threads at the default, 9 at `--v8-pool-size=2`, and **18** at
   * `--v8-pool-size=0`. A "disable" that spends seven MORE threads per runner is
   * exactly the guess this test exists to keep out.
   */
  it('a light runner bounds its V8 platform pool; a heavy runner keeps the default', async () => {
    const mkAddonDir = (id: string, profile: 'light' | 'heavy' | null): string => {
      const dir = path.join(tmpDir, `v8pool-${id}`)
      fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
      const execution = profile === null ? {} : { heapProfile: profile }
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ camstack: { addons: [{ id, execution }] } }),
      )
      return path.join(dir, 'dist')
    }

    await broker.call('$process.spawnRunner', {
      runnerId: 'v8pool-light',
      addons: [{ addonId: 'provider-rtsp', addonDir: mkAddonDir('provider-rtsp', null) }],
    })
    expect(spawnCalls[spawnCalls.length - 1]!.args).toContain(
      `--v8-pool-size=${LIGHT_V8_POOL_SIZE_DEFAULT}`,
    )

    // A heavy runner does real parallel marking on a real heap. Its argv is
    // asserted whole so the flag cannot drift onto it unnoticed.
    await broker.call('$process.spawnRunner', {
      runnerId: 'v8pool-heavy',
      addons: [{ addonId: 'decoder-nodeav', addonDir: mkAddonDir('decoder-nodeav', 'heavy') }],
    })
    expect(
      spawnCalls[spawnCalls.length - 1]!.args.some((a) => a.startsWith('--v8-pool-size')),
    ).toBe(false)
  })

  it('appears in $process.list with synthetic runner:* addonId', async () => {
    await broker.call('$process.spawnRunner', {
      runnerId: 'list-test',
      addons: [{ addonId: 'foo', addonDir: '/tmp/foo' }],
    })
    const listRaw = await broker.call('$process.list')
    const list = listRaw as ReadonlyArray<{
      readonly name: string
      readonly addonId: string
      readonly nodeId: string
      readonly addonIds: readonly string[]
    }>
    const found = list.find((p) => p.name === 'list-test')
    expect(found).toBeDefined()
    expect(found?.addonId).toBe('runner:list-test')
    expect(found?.nodeId).toBe('hub/list-test')
    expect(found?.addonIds).toEqual(['foo'])
  })
})

// ---------------------------------------------------------------------------
// Layer 1b — UDS-only invariant (Phase F1): the forked runner has NO broker
// ---------------------------------------------------------------------------
//
// F1+F2 removed the per-addon Moleculer ServiceBroker from the forked
// `addon-runner`. The child talks to its parent ONLY over the UDS
// `LocalChildClient`. A full subprocess boot is flaky in CI (Layer 4 covers
// it behind a flag), so this pins the invariant at the source level: the
// runner module must not construct a `ServiceBroker` nor import one from
// moleculer. A regression (re-introducing the broker) trips this immediately.

describe('addon-runner is UDS-only — no ServiceBroker (F1)', () => {
  it('the runner source neither imports nor constructs a ServiceBroker', () => {
    const runnerSrc = path.resolve(__dirname, '../../moleculer/addon-runner.ts')
    const src = fs.readFileSync(runnerSrc, 'utf-8')
    // Strip line + block comments so prose mentioning "ServiceBroker" (the
    // header explaining what was removed) doesn't trip the guard.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(
        (l) =>
          !l.trimStart().startsWith('*') &&
          !l.trimStart().startsWith('//') &&
          !l.trimStart().startsWith('/**'),
      )
      .join('\n')
    expect(code).not.toMatch(/new\s+ServiceBroker/)
    expect(code).not.toMatch(/from\s+["']moleculer["']/)
    // Connects over UDS instead.
    expect(code).toMatch(/LocalChildClient/)
    expect(code).toMatch(/CAMSTACK_PARENT_UDS_PATH/)
  })
})

// ---------------------------------------------------------------------------
// Layer 2 — runner-plan contract (invariants (a) + (b))
// ---------------------------------------------------------------------------
//
// `AddonRegistryService.buildAddonGroupPlan` is the single authority for the
// hub↔runner topology. Its rule, distilled:
//   - drop `@camstack/system` builtins (stay in-process on the hub) UNLESS the
//     entry declares `execution.isolate` (the snapshot wrapper);
//   - drop `placement: 'agent-only'` addons (run on a remote agent);
//   - key every surviving addon by `resolveRunnerId(decl, addonId)` — the
//     declared `execution.group` or, absent one, the addon id itself.
// This re-derivation mirrors that body exactly so the plan SHAPE is pinned
// without booting a heavyweight `AddonRegistryService` (8+ constructor deps).

interface PlanAddonEntry {
  readonly addonId: string
  readonly addonDir: string
  readonly packageName: string
  readonly declaration: Pick<AddonDeclaration, 'execution'>
}

/**
 * Faithful re-derivation of `AddonRegistryService.buildAddonGroupPlan` —
 * the authority lives in `server/backend/src/core/addon/addon-registry.service.ts`
 * (method `buildAddonGroupPlan`). The three filter conditions below
 * (`@camstack/system` builtins minus the `execution.isolate` opt-out,
 * `agent-only` placement, `resolveRunnerId` keying) mirror that method's body
 * exactly.
 * If that method grows new filter conditions, update this function too.
 */
function deriveRunnerPlan(entries: readonly PlanAddonEntry[]): RunnerPlan {
  const plan = new Map<string, RunnerAddonPlacement[]>()
  for (const planEntry of entries) {
    if (planEntry.packageName === '@camstack/system' && !isIsolatedBuiltin(planEntry.declaration)) {
      continue
    }
    if (resolveAddonPlacement(planEntry.declaration) === 'agent-only') continue
    const runnerId = resolveRunnerId(planEntry.declaration, planEntry.addonId)
    const bucket = plan.get(runnerId) ?? []
    bucket.push({ addonId: planEntry.addonId, addonDir: planEntry.addonDir })
    plan.set(runnerId, bucket)
  }
  return plan
}

function entry(
  addonId: string,
  group: string | undefined,
  opts: {
    packageName?: string
    placement?: 'hub-only' | 'any-node' | 'agent-only'
    isolate?: boolean
  } = {},
): PlanAddonEntry {
  return {
    addonId,
    addonDir: `/opt/addons/${addonId}`,
    packageName: opts.packageName ?? `@camstack/addon-${addonId}`,
    declaration: {
      execution: {
        group,
        placement: opts.placement ?? 'hub-only',
        ...(opts.isolate === true ? { isolate: true } : {}),
      },
    },
  }
}

describe('runner-plan contract (D2 — one addon, one process)', () => {
  it('(a) an addon with NO declared group gets its own single-addon runner', () => {
    const plan = deriveRunnerPlan([
      entry('provider-onvif', undefined),
      entry('advanced-notifier', undefined),
      entry('analytics-suite', undefined),
    ])
    // Three groupless addons → three distinct runners, each keyed by the
    // addon id and holding exactly that one addon.
    expect([...plan.keys()].toSorted()).toEqual([
      'advanced-notifier',
      'analytics-suite',
      'provider-onvif',
    ])
    for (const [runnerId, addons] of plan) {
      expect(addons).toHaveLength(1)
      expect(addons[0]!.addonId).toBe(runnerId)
    }
  })

  it('(a/D9) the former pipeline media addons now each get their own runner', () => {
    // Phase 5 (D9) dissolved the `pipeline` co-location group: once frames
    // travel as shm `FrameHandle`s and audio over tRPC, the 7 media addons
    // no longer need to share a process. They now declare NO `execution.group`
    // — so each resolves to its own single-addon runner.
    const formerPipelineMembers = [
      'pipeline-runner',
      'detection-pipeline',
      'motion-wasm',
      'decoder-nodeav',
      'audio-codec-nodeav',
      'audio-analyzer',
      'stream-broker',
      'pipeline-orchestrator',
    ]
    const plan = deriveRunnerPlan(formerPipelineMembers.map((id) => entry(id, undefined)))
    // One runner per addon, keyed by addon id — no `pipeline` runner.
    expect([...plan.keys()].toSorted()).toEqual([...formerPipelineMembers].toSorted())
    for (const [runnerId, addons] of plan) {
      expect(addons).toHaveLength(1)
      expect(addons[0]!.addonId).toBe(runnerId)
    }
    expect(plan.has('pipeline')).toBe(false)
  })

  it('(b) `resolveRunnerId` still collapses a shared group — the mechanism survives', () => {
    // No shipped manifest declares `execution.group` anymore (D9), but the
    // collapse mechanism is generic. Given synthetic addons that DO share a
    // group, `resolveRunnerId` still keys them onto one runner.
    const plan = deriveRunnerPlan([
      entry('addon-a', 'shared'),
      entry('addon-b', 'shared'),
      entry('addon-c', undefined),
    ])
    expect([...plan.keys()].toSorted()).toEqual(['addon-c', 'shared'])
    expect(
      plan
        .get('shared')!
        .map((a) => a.addonId)
        .toSorted(),
    ).toEqual(['addon-a', 'addon-b'])
    expect(plan.get('addon-c')!.map((a) => a.addonId)).toEqual(['addon-c'])
  })

  it('excludes @camstack/system builtins — they stay in-process on the hub', () => {
    const plan = deriveRunnerPlan([
      entry('sqlite-storage', undefined, { packageName: '@camstack/system' }),
      entry('settings-store', undefined, { packageName: '@camstack/system' }),
      entry('provider-onvif', undefined),
    ])
    // Only the non-core addon gets a runner; core builtins are absent.
    expect([...plan.keys()]).toEqual(['provider-onvif'])
  })

  it('INCLUDES a @camstack/system builtin that declares execution.isolate', () => {
    const plan = deriveRunnerPlan([
      entry('storage-orchestrator', undefined, { packageName: '@camstack/system' }),
      entry('sqlite-settings', undefined, { packageName: '@camstack/system', isolate: true }),
      entry('snapshot', undefined, { packageName: '@camstack/system', isolate: true }),
      entry('provider-onvif', undefined),
    ])
    // Isolated builtins get their OWN runner keyed by addon id (D2). The
    // infrastructure builtin beside them still stays in-process.
    expect([...plan.keys()].toSorted()).toEqual(['provider-onvif', 'snapshot', 'sqlite-settings'])
    expect(plan.get('snapshot')).toEqual([
      { addonId: 'snapshot', addonDir: '/opt/addons/snapshot' },
    ])
    expect(plan.get('sqlite-settings')).toEqual([
      { addonId: 'sqlite-settings', addonDir: '/opt/addons/sqlite-settings' },
    ])
  })

  it('an isolated builtin declaring agent-only placement is STILL dropped from the hub plan', () => {
    const plan = deriveRunnerPlan([
      entry('edge-builtin', undefined, {
        packageName: '@camstack/system',
        isolate: true,
        placement: 'agent-only',
      }),
      entry('provider-onvif', undefined),
    ])
    expect([...plan.keys()]).toEqual(['provider-onvif'])
  })

  it('excludes agent-only addons — they run on a remote agent, not a hub runner', () => {
    const plan = deriveRunnerPlan([
      entry('edge-detector', undefined, { placement: 'agent-only' }),
      entry('provider-onvif', undefined),
    ])
    expect([...plan.keys()]).toEqual(['provider-onvif'])
  })
})

// ---------------------------------------------------------------------------
// Layer 3 — runner disconnect → cap drop (invariant (c))
// ---------------------------------------------------------------------------
//
// A runner crash manifests as Moleculer's `$node.disconnected`. The hub's
// `HubNodeRegistry` is wired to that liveness signal: a disconnect drops
// every cap that node held. This exercises the real wiring over a TCP
// cluster — no timers, no registry scans, pure Moleculer liveness.

function getAvailableNodeIds(broker: ServiceBroker): readonly string[] {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double: reach Moleculer's internal registry
  const registry = (broker as unknown as Record<string, unknown>).registry as
    | { getNodeList: (opts: Record<string, boolean>) => readonly { id: string }[] }
    | undefined
  return (registry?.getNodeList?.({ onlyAvailable: true }) ?? []).map((n) => n.id)
}

async function waitFor(condition: () => boolean, timeout = 8000, interval = 100): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error(`waitFor timed out after ${timeout}ms`)
    await new Promise((r) => setTimeout(r, interval))
  }
}

/** A port the OS confirms is free, so two brokers can be pointed at each
 *  other without a discovery broadcast. */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, () => {
      const addr = srv.address()
      if (addr !== null && typeof addr === 'object') {
        const { port } = addr
        srv.close(() => resolve(port))
      } else reject(new Error('no address'))
    })
  })
}

describe('runner disconnect drops its caps (D2 — $node.disconnected)', { timeout: 30000 }, () => {
  const brokers: ServiceBroker[] = []

  afterEach(async () => {
    for (const b of [...brokers].toReversed()) {
      try {
        await b.stop()
      } catch {
        /* already stopped */
      }
    }
    brokers.length = 0
  })

  it('a runner crash → $node.disconnected → the hub drops the runner caps', async () => {
    // HubNodeRegistry is the single cap authority. Wire it to the hub
    // service's registration handshake and to `$node.disconnected`.
    const nodeRegistry = new HubNodeRegistry()
    const hubDeps: HubServiceDeps = {
      getAddonConfig: (addonId) => ({ addonId }),
      getSettings: () => ({}),
      getRecentEvents: () => [],
      onLog: () => {},
      onRegisterNode: (params) => {
        nodeRegistry.registerNode(params)
      },
      onUnregisterNode: (nodeId) => {
        nodeRegistry.removeNode(nodeId)
      },
    }

    // UDP discovery, not TCP, was the flake: this test passed about one run in
    // three because the two brokers had to FIND each other by broadcast — which
    // on a developer machine competes with the network, and inside a second
    // checkout of this repo competed with an identical pair of brokers. A
    // namespace plus an explicit peer URL removes the discovery step entirely
    // and changes nothing about what is under test, which is
    // `$node.disconnected` liveness. Same shape `distributed-event-bus.cluster.spec.ts`
    // already uses.
    const hubPort = await findFreePort()
    const ns = `runner-disc-${String(hubPort)}`
    const hubUrl = `127.0.0.1:${String(hubPort)}/hub`

    const hub = new ServiceBroker({
      nodeID: 'hub',
      namespace: ns,
      transporter: { type: 'TCP', options: { port: hubPort, udpDiscovery: false } },
      logger: false,
    })
    brokers.push(hub)
    hub.createService(createHubService(hubDeps))

    // D2: the hub drops a node's caps on `$node.disconnected` — exactly
    // the production wiring (`moleculer.service.ts` mirrors the liveness
    // event onto `HubNodeRegistry.removeNode`).
    hub.localBus.on('$node.disconnected', ({ node }: { node: { id: string } }) => {
      nodeRegistry.removeNode(node.id)
    })

    await hub.start()

    // The runner subprocess is modelled as a sibling TCP broker whose
    // nodeID follows the `hub/<runnerId>` convention.
    const runner = new ServiceBroker({
      nodeID: 'hub/provider-reolink',
      namespace: ns,
      transporter: { type: 'TCP', options: { urls: hubUrl, udpDiscovery: false } },
      logger: false,
    })
    brokers.push(runner)
    await runner.start()
    await waitFor(() => getAvailableNodeIds(hub).includes('hub/provider-reolink'))
    // TCP service discovery is async — wait for the runner to learn about
    // the hub's `$hub` service before issuing the registration handshake.
    await runner.waitForServices(['$hub'], 8000)

    // The runner completes its boot handshake — registers its caps.
    await runner.call('$hub.registerNode', {
      nodeId: 'hub/provider-reolink',
      addons: [{ addonId: 'provider-reolink', capabilities: ['switch', 'ptz'] }],
    })
    expect(nodeRegistry.listEntries()).toEqual([
      { nodeId: 'hub/provider-reolink', addonId: 'provider-reolink', capName: 'switch' },
      { nodeId: 'hub/provider-reolink', addonId: 'provider-reolink', capName: 'ptz' },
    ])

    // Simulate the runner crash: stop its broker. Moleculer fires
    // `$node.disconnected` on the hub — no timer, no scan.
    await runner.stop()
    brokers.splice(brokers.indexOf(runner), 1)

    await waitFor(() => !getAvailableNodeIds(hub).includes('hub/provider-reolink'))
    await waitFor(() => nodeRegistry.listEntries().length === 0)

    // The hub has dropped every cap the dead runner held.
    expect(nodeRegistry.listEntries()).toEqual([])
    expect(nodeRegistry.getNodeManifest('hub/provider-reolink')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Layer 4 — end-to-end with real subprocess + synthetic addons
// ---------------------------------------------------------------------------
//
// Disabled by default; flip `RUN_ADDON_RUNNER_E2E=1` to exercise the real
// `dist/addon-runner.js` against a 2-addon synthetic package.

const E2E_ENABLED = process.env.RUN_ADDON_RUNNER_E2E === '1'

describe.skipIf(!E2E_ENABLED)('addon-runner end-to-end (UDS-only)', { timeout: 30000 }, () => {
  it('spawns a broker-less addon-runner that registers its caps over UDS', async () => {
    // Resolve the built addon-runner.js — fail fast if the kernel
    // hasn't been built yet, since the spawn would crash with a
    // confusing error message otherwise.
    const runnerPath = path.resolve(__dirname, '../../../dist/addon-runner.js')
    if (!fs.existsSync(runnerPath)) {
      throw new Error(
        `addon-runner.js not built — run "npm run build -w packages/kernel" first (looked at ${runnerPath})`,
      )
    }

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-runner-e2e-'))
    const addonId = 'fake-uds'
    {
      const dir = path.join(tmpRoot, addonId)
      fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
      const pkg = {
        name: `@test/${addonId}`,
        version: '0.0.0',
        main: './dist/index.js',
        camstack: {
          addons: [
            {
              id: addonId,
              name: addonId,
              version: '0.0.0',
              entry: './dist/index.js',
              capabilities: [],
              execution: { placement: 'any-node' },
            },
          ],
        },
      }
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
      // Minimal addon registering one singleton cap so the UDS registration
      // carries a non-empty descriptor set the parent can observe.
      const entrySrc = `
const id = '${addonId}';
class FakeAddon {
  manifest = { id, name: id, version: '0.0.0', capabilities: ['fake-cap'] };
  async initialize(ctx) {
    this._ctx = ctx;
    return { providers: [{ capability: { name: 'fake-cap', methods: { ping: { kind: 'query' } } }, provider: { ping: async () => 'pong' } }] };
  }
  postBrokerStart() {}
  async shutdown() {}
}
module.exports = FakeAddon;
module.exports.default = FakeAddon;
`
      fs.writeFileSync(path.join(dir, 'dist', 'index.js'), entrySrc)
    }

    const runnerId = 'e2e-uds'
    const parentNodeId = 'hub-e2e'

    // Parent UDS registry — the child connects here and registers its caps.
    const registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(parentNodeId),
      // No siblings + no resolver: an unowned call from the child rejects, but
      // this test only verifies registration + readiness, not outbound caps.
    })
    let registered: RegisteredChild | undefined
    registry.onChildRegistered((child) => {
      registered = child
    })
    // Children request the readiness snapshot on connect — answer with empty.
    registry.onReadinessSnapshotRequest(() => [])
    await registry.start()

    const child = cp.spawn('node', [runnerPath], {
      env: {
        ...process.env,
        CAMSTACK_RUNNER_ID: runnerId,
        CAMSTACK_RUNNER_ADDONS: JSON.stringify([
          { addonId, addonDir: path.join(tmpRoot, addonId) },
        ]),
        CAMSTACK_PARENT_NODE_ID: parentNodeId,
        CAMSTACK_PARENT_UDS_PATH: localEndpointPath(parentNodeId),
        CAMSTACK_DATA_DIR: path.join(tmpRoot, 'data'),
        CAMSTACK_LOG_LEVEL: 'error',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    child.stdout?.on('data', (b: Buffer) => {
      stdout += b.toString()
    })
    child.stderr?.on('data', (b: Buffer) => {
      process.stderr.write(`[addon-runner-e2e:stderr] ${b.toString()}`)
    })

    try {
      // Wait for the READY signal from the spawned addon-runner.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('addon-runner did not become ready in 20s')),
          20000,
        )
        const interval = setInterval(() => {
          if (stdout.includes(`READY:${parentNodeId}/${runnerId}`)) {
            clearInterval(interval)
            clearTimeout(timer)
            resolve()
          }
        }, 100)
      })

      // The child connected over UDS and registered its cap descriptor set.
      await waitFor(
        () => registered !== undefined && registered.caps.some((c) => c.capName === 'fake-cap'),
      )
      expect(registered?.childId).toBe(runnerId)
      expect(registered?.caps.map((c) => c.capName)).toContain('fake-cap')
    } finally {
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* */
          }
          resolve()
        }, 5000)
        child.on('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
      await registry.close()
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true })
      } catch {
        /* */
      }
    }
  })
})
