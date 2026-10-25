/**
 * `applyServerUpdate` observability contract.
 *
 * WHY THIS FILE EXISTS. On 2026-09-01 the hub sat on `@camstack/server@1.2.201`
 * while both agents reached 1.2.205. The operator ran the update from the
 * cluster page and again from the node card; 12 hours of hub logs contained
 * not one line about staging, npm, a closure or a swap. The engine has SIX
 * branches that return `{accepted:false}` and log NOTHING, so "it refused" and
 * "it was never called" are the same observation — and the difference between
 * them is the whole diagnosis.
 *
 * The rule this pins (CLAUDE.md → Logging): a branch that DROPS work silently
 * logs it, and every line about a node carries `tags: { nodeId }`.
 *
 * Every case below asserts the OUTCOME (`accepted`) *and* the line, because a
 * refusal that is correct but silent is the defect being fixed here.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HUB_ROOT_SPEC } from '../root-package-spec.js'
import { writePendingRootSwap } from '../root-single-copy.js'
import {
  RootUpdateService,
  type NpmExecFn,
  type RootUpdateEnvNames,
  type RootUpdateLogger,
} from '../root-update-service.js'

const NOW = 1_700_000_000_000
const NODE_ID = 'hub'

const ENV_NAMES: RootUpdateEnvNames = {
  bootMode: 'CAMSTACK_SERVER_BOOT_MODE',
  activeVersion: 'CAMSTACK_SERVER_ACTIVE_VERSION',
  seedDir: 'CAMSTACK_SEED_SERVER_DIR',
}

interface RecordedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly tags?: Record<string, unknown>
  readonly meta?: Record<string, unknown>
}

interface RecordingLogger extends RootUpdateLogger {
  readonly lines: readonly RecordedLine[]
}

function makeRecordingLogger(): RecordingLogger {
  const lines: RecordedLine[] = []
  const push =
    (level: RecordedLine['level']) =>
    (
      message: string,
      context?: {
        readonly tags?: Record<string, unknown>
        readonly meta?: Record<string, unknown>
      },
    ): void => {
      lines.push({
        level,
        message,
        ...(context?.tags !== undefined ? { tags: context.tags } : {}),
        ...(context?.meta !== undefined ? { meta: context.meta } : {}),
      })
    }
  return {
    lines,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  }
}

let tmp: string
let dataDir: string
let runningPkgPath: string
let logger: RecordingLogger

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'root-update-obs-'))
  dataDir = path.join(tmp, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  runningPkgPath = path.join(tmp, 'running-package.json')
  fs.writeFileSync(
    runningPkgPath,
    JSON.stringify({ name: '@camstack/server', version: '1.1.50' }),
    'utf-8',
  )
  logger = makeRecordingLogger()
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function makeService(
  env: NodeJS.ProcessEnv,
  execNpm: NpmExecFn = async () => ({ stdout: '' }),
): RootUpdateService {
  return new RootUpdateService({
    spec: HUB_ROOT_SPEC,
    envNames: ENV_NAMES,
    nodeId: NODE_ID,
    logger,
    restartServer: () => undefined,
    dataDir,
    runningPackageJsonPath: runningPkgPath,
    workspaceProbeDir: tmp,
    execNpm,
    env,
    now: () => NOW,
  })
}

/** Lines whose message mentions the root-package update flow. */
function updateLines(): readonly RecordedLine[] {
  return logger.lines.filter((l) => l.message.includes('root package update'))
}

function refusalLine(): RecordedLine | undefined {
  return updateLines().find((l) => l.message.includes('refused'))
}

describe('applyServerUpdate leaves a trace on EVERY path', () => {
  it('logs the request itself, tagged with the nodeId, before deciding anything', async () => {
    const service = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'workspace' })

    await service.applyServerUpdate({ version: '1.1.51' })

    const requested = updateLines().find((l) => l.message.includes('requested'))
    expect(requested).toBeDefined()
    expect(requested?.tags).toMatchObject({ nodeId: NODE_ID })
    expect(requested?.meta).toMatchObject({ requestedVersion: '1.1.51' })
  })

  it('logs the refusal when the node boots from a workspace checkout', async () => {
    const service = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'workspace' })

    const result = await service.applyServerUpdate({ version: '1.1.51' })

    expect(result.accepted).toBe(false)
    expect(refusalLine()?.tags).toMatchObject({ nodeId: NODE_ID })
    expect(refusalLine()?.meta).toMatchObject({ reason: 'workspace-boot-mode' })
  })

  it('logs the refusal when the target version is already running', async () => {
    const service = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'data-root' })

    const result = await service.applyServerUpdate({ version: '1.1.50' })

    expect(result.accepted).toBe(false)
    expect(refusalLine()?.tags).toMatchObject({ nodeId: NODE_ID })
    expect(refusalLine()?.meta).toMatchObject({
      reason: 'already-running',
      targetVersion: '1.1.50',
    })
  })

  it('logs the refusal when a version is already staged awaiting restart', async () => {
    writePendingRootSwap(path.join(dataDir, 'server-root'), {
      schemaVersion: 1,
      version: '1.1.52',
      stagingPath: path.join(dataDir, 'server-root', '.staging-1.1.52'),
      requestedAtMs: NOW,
    })
    const service = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'data-root' })

    const result = await service.applyServerUpdate({ version: '1.1.51' })

    expect(result.accepted).toBe(false)
    expect(refusalLine()?.tags).toMatchObject({ nodeId: NODE_ID })
    expect(refusalLine()?.meta).toMatchObject({ reason: 'already-staged' })
  })

  it('logs the refusal when the latest version cannot be resolved', async () => {
    const service = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'data-root' }, async () => {
      throw new Error('ENOTFOUND registry.npmjs.org')
    })

    const result = await service.applyServerUpdate({})

    expect(result.accepted).toBe(false)
    expect(refusalLine()?.tags).toMatchObject({ nodeId: NODE_ID })
    expect(refusalLine()?.meta).toMatchObject({ reason: 'latest-unresolved' })
  })

  it('logs the refusal when a dev-channel version has no uploaded tarballs', async () => {
    const service = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'data-root' })

    const result = await service.applyServerUpdate({ version: '1.1.51-dev.123' })

    expect(result.accepted).toBe(false)
    expect(refusalLine()?.tags).toMatchObject({ nodeId: NODE_ID })
    expect(refusalLine()?.meta).toMatchObject({ reason: 'dev-uploads-missing' })
  })

  it('tags the staging-failure line with the nodeId', async () => {
    const service = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'data-root' }, async (args) => {
      if (args[0] === 'install') throw new Error('npm ERR! 404')
      return { stdout: '' }
    })

    const result = await service.applyServerUpdate({ version: '1.1.51' })

    expect(result.accepted).toBe(false)
    const failed = updateLines().find((l) => l.message.includes('staging failed'))
    expect(failed?.tags).toMatchObject({ nodeId: NODE_ID })
  })
})

describe('restartServer refusals are logged too', () => {
  it('logs the refusal when a version is staged awaiting restart', () => {
    writePendingRootSwap(path.join(dataDir, 'server-root'), {
      schemaVersion: 1,
      version: '1.1.52',
      stagingPath: path.join(dataDir, 'server-root', '.staging-1.1.52'),
      requestedAtMs: NOW,
    })
    const service = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'data-root' })

    const result = service.restartNode()

    expect(result.accepted).toBe(false)
    const refused = logger.lines.find((l) => l.message.includes('node restart refused'))
    expect(refused?.tags).toMatchObject({ nodeId: NODE_ID })
    expect(refused?.meta).toMatchObject({ reason: 'already-staged' })
  })
})
