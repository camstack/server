/**
 * `release_status` — where the train stands, read-only: git (local vs
 * origin/main, changes since the last publish tag), the CI and publish runs
 * (`gh run list`), the npm registry versions of the train packages against the
 * local package.json, and — when an admin credential exists — the node
 * versions the hub reports. Every command goes through the allow-listed
 * {@link ReleaseRunner}; a failed read is reported as such, never as "fine".
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ReleaseRunner } from './commands.js'

interface TrainPackage {
  readonly name: string
  readonly dir: string
}

export const TRAIN_PACKAGES: readonly TrainPackage[] = [
  { name: '@camstack/server', dir: 'server/backend' },
  { name: '@camstack/types', dir: 'packages/types' },
  { name: '@camstack/system', dir: 'packages/system' },
  { name: '@camstack/sdk', dir: 'packages/sdk' },
  { name: '@camstack/ui-library', dir: 'packages/ui-library' },
]

export interface Probe<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: string
}

async function probe<T>(read: () => Promise<T>): Promise<Probe<T>> {
  try {
    return { ok: true, value: await read() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function out(
  run: ReleaseRunner,
  cwd: string,
  cmd: string,
  args: readonly string[],
): Promise<string> {
  const res = await run(cmd, args, cwd)
  if (res.exitCode !== 0) {
    throw new Error(
      `${cmd} ${args[0] ?? ''} exited ${res.exitCode}: ${res.stderr.trim().slice(0, 300)}`,
    )
  }
  return res.stdout.trim()
}

function localVersion(root: string, dir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8'),
    )
    const version: unknown =
      parsed !== null && typeof parsed === 'object' ? Reflect.get(parsed, 'version') : undefined
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

function parseRuns(json: string): unknown {
  const parsed: unknown = JSON.parse(json)
  return Array.isArray(parsed) ? parsed.slice(0, 5) : parsed
}

function summariseByPackage(files: readonly string[]): {
  readonly files: number
  readonly byPackage: Readonly<Record<string, number>>
} {
  const byPackage: Record<string, number> = {}
  for (const file of files) {
    const parts = file.split('/')
    const key = parts.slice(0, 2).join('/')
    byPackage[key] = (byPackage[key] ?? 0) + 1
  }
  return { files: files.length, byPackage }
}

const RUN_FIELDS = 'databaseId,status,conclusion,headSha,createdAt,displayTitle,event'

export interface ReleaseStatus {
  readonly readOnly: true
  readonly git: Probe<{
    readonly head: string
    readonly originMain: string
    readonly ahead: number
    readonly behind: number
    readonly lastPublishTag: string | null
    readonly changedSincePublish: {
      readonly files: number
      readonly byPackage: Readonly<Record<string, number>>
    }
  }>
  readonly ci: Probe<unknown>
  readonly publish: Probe<unknown>
  readonly npm: readonly {
    readonly name: string
    readonly local: string | null
    readonly registry: Probe<string>
    readonly verdict: string
  }[]
  readonly hub: Probe<unknown>
  readonly note: string
}

export interface ReleaseStatusDeps {
  readonly run: ReleaseRunner
  /** Node versions from the hub, when a credential exists; throws otherwise. */
  readonly hubVersions: () => Promise<unknown>
}

function verdictFor(local: string | null, registry: Probe<string>): string {
  if (!registry.ok || registry.value === undefined) return 'registry not read'
  if (local === null) return 'local version unknown'
  if (local === registry.value) return 'in step with the registry'
  return `local ${local} vs registry ${registry.value}: the publish bumps in CI, so a difference is normal until you pull the bump commit; a stale registry also lags minutes after a publish`
}

export async function releaseStatus(root: string, deps: ReleaseStatusDeps): Promise<ReleaseStatus> {
  const { run } = deps
  const git = await probe(async () => {
    const head = await out(run, root, 'git', ['rev-parse', 'HEAD'])
    const originMain = await out(run, root, 'git', ['rev-parse', 'origin/main'])
    const counts = (
      await out(run, root, 'git', ['rev-list', '--left-right', '--count', 'origin/main...HEAD'])
    ).split(/\s+/)
    const lastPublishTag = await probe(() =>
      out(run, root, 'git', [
        'describe',
        '--tags',
        '--abbrev=0',
        '--match',
        'publish-*',
        'origin/main',
      ]),
    )
    const changed =
      lastPublishTag.ok && lastPublishTag.value
        ? (
            await out(run, root, 'git', [
              'diff',
              '--name-only',
              lastPublishTag.value,
              'origin/main',
              '--',
              'packages',
              'server',
            ])
          )
            .split('\n')
            .filter((l) => l !== '')
        : []
    return {
      head,
      originMain,
      behind: Number(counts[0] ?? 0),
      ahead: Number(counts[1] ?? 0),
      lastPublishTag: lastPublishTag.value ?? null,
      changedSincePublish: summariseByPackage(changed),
    }
  })
  const [ci, publish, hub, npm] = await Promise.all([
    probe(async () =>
      parseRuns(
        await out(run, root, 'gh', [
          'run',
          'list',
          '--workflow',
          'ci.yml',
          '--branch',
          'main',
          '--limit',
          '3',
          '--json',
          RUN_FIELDS,
        ]),
      ),
    ),
    probe(async () =>
      parseRuns(
        await out(run, root, 'gh', [
          'run',
          'list',
          '--workflow',
          'Publish Packages',
          '--limit',
          '3',
          '--json',
          RUN_FIELDS,
        ]),
      ),
    ),
    probe(() => deps.hubVersions()),
    Promise.all(
      TRAIN_PACKAGES.map(async (pkg) => {
        const registry = await probe(() => out(run, root, 'npm', ['view', pkg.name, 'version']))
        const local = localVersion(root, pkg.dir)
        return { name: pkg.name, local, registry, verdict: verdictFor(local, registry) }
      }),
    ),
  ])
  return {
    readOnly: true,
    git,
    ci,
    publish,
    npm,
    hub,
    note: 'Read-only. Nothing was published, dispatched or deployed. Use release_plan for the ordered commands a human runs.',
  }
}
