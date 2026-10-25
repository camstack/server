/**
 * `release_plan` — the ordered train for a set of changed paths, DESCRIBED.
 *
 * Nothing here spawns a process or touches the network: it classifies paths
 * and prints the commands a human runs, with the traps that have cost real
 * time (`camstack-publish-ci`, `camstack-server-change`,
 * `docs/architecture/update-and-release.md`). Publish, deploy, tag and
 * `applyServerUpdate` are never executed by any MCP tool.
 */

export type ChangeClass =
  | 'framework'
  | 'capability'
  | 'image'
  | 'addon'
  | 'bootstrap-addon'
  | 'viewer'
  | 'docs-or-scripts'
  | 'other'

/** Addons the `@camstack/server` closure re-aligns at its own boot (hub or agent). */
export const BOOTSTRAP_ADDONS: ReadonlySet<string> = new Set([
  'addon-admin-ui',
  'addon-auth',
  'addon-decoder-nodeav',
  'addon-notifiers',
  'addon-pipeline',
  'addon-pipeline-orchestrator',
  'addon-post-analysis',
  'addon-agent-ui',
])

const FRAMEWORK_PREFIXES: readonly string[] = [
  'packages/types/',
  'packages/sdk/',
  'packages/system/',
  'packages/ui-library/',
  'server/backend/',
]

export interface ClassifiedPath {
  readonly path: string
  readonly kind: ChangeClass
  /** `packages/addon-x` for an addon change. */
  readonly addonDir?: string
}

export function classifyPath(rawPath: string): ClassifiedPath {
  const p = rawPath.trim().replace(/^\.\//, '')
  if (p.endsWith('.cap.ts')) return { path: p, kind: 'capability' }
  if (p.startsWith('packages/node-root/') || p === 'Dockerfile' || p.startsWith('docker/')) {
    return { path: p, kind: 'image' }
  }
  const addon = /^packages\/(addon-[^/]+)\//.exec(p)
  if (addon?.[1]) {
    const addonDir = `packages/${addon[1]}`
    return {
      path: p,
      kind: BOOTSTRAP_ADDONS.has(addon[1]) ? 'bootstrap-addon' : 'addon',
      addonDir,
    }
  }
  if (FRAMEWORK_PREFIXES.some((prefix) => p.startsWith(prefix))) {
    return { path: p, kind: 'framework' }
  }
  if (p.startsWith('camstack/')) return { path: p, kind: 'viewer' }
  if (p.startsWith('docs/') || p.startsWith('scripts/') || p.endsWith('.md')) {
    return { path: p, kind: 'docs-or-scripts' }
  }
  return { path: p, kind: 'other' }
}

export interface ReleaseStep {
  readonly n: number
  readonly title: string
  /** Commands for a HUMAN to run. Never executed by the tool. */
  readonly commands: readonly string[]
  readonly why?: string
}

export interface ReleasePlan {
  readonly executesNothing: true
  readonly classified: readonly ClassifiedPath[]
  readonly nothingToShip: boolean
  readonly steps: readonly ReleaseStep[]
  readonly traps: readonly string[]
}

const TRAPS: readonly string[] = [
  'Never publish from a laptop and never use publish --all: only the Publish Packages workflow, scope=affected, include_dependents=false.',
  'Push first: `git log --oneline origin/main..HEAD` must be empty, the workflow builds origin/main.',
  'Registry lag is not a failed publish: `npm view <pkg> version` serves the old version for minutes. Verify the tarball (curl -sI .../-/server-<VER>.tgz) and `npm view @camstack/server@<VER> dependencies`; never publish again because of a stale view.',
  'Verify the CONTENT of a published package (npm pack + grep a literal from the change body), not only the version.',
  'A release tag must not sit on the `[skip ci]` publish commit; tag a clean commit after `git pull`, and only after npm has the version.',
  'Agents are updated AFTER the hub; an agent updated first is undone by the reconciliation. Verify on disk, not by the CLI exit code.',
  'publish != deployed != live: after a deploy, check the pid changed AND the capabilities re-registered (Deploy != capabilities re-registered).',
  'Never dispatch the Checks workflow. It is operator-only (D704).',
  'Run `npm run verify:push` GREEN before pushing.',
]

export function releasePlan(paths: readonly string[], note?: string): ReleasePlan {
  const classified = paths.map(classifyPath).filter((c) => c.path !== '')
  const has = (...kinds: ChangeClass[]): boolean => classified.some((c) => kinds.includes(c.kind))
  const framework = has('framework', 'capability')
  const bootstrap = has('bootstrap-addon')
  const addons = [
    ...new Set(classified.filter((c) => c.kind === 'addon' && c.addonDir).map((c) => c.addonDir)),
  ]
  const viewer = has('viewer')
  const image = has('image')
  const shipsAnything = framework || bootstrap || addons.length > 0 || viewer || image

  const steps: ReleaseStep[] = []
  const add = (title: string, commands: readonly string[], why?: string): void => {
    steps.push({ n: steps.length + 1, title, commands, ...(why ? { why } : {}) })
  }

  if (shipsAnything) {
    add('Preflight', [
      'git log --oneline origin/main..HEAD   # must be empty',
      'npm run verify:push                    # GREEN before the push',
      'gh run list --workflow ci.yml --branch main --limit 3   # main must be green',
    ])
  }
  if (framework || bootstrap) {
    const forced = has('capability')
      ? ' -f force_packages=@camstack/system,@camstack/server'
      : bootstrap && !framework
        ? ' -f force_packages=@camstack/server'
        : ''
    add(
      'Publish through CI',
      [
        `gh workflow run "Publish Packages" --ref main -f bump=patch -f scope=affected -f include_dependents=false${forced}`,
        'gh run list --workflow="Publish Packages" --limit 1 && gh run watch <run-id>',
        'curl -sI https://registry.npmjs.org/@camstack/server/-/server-<VER>.tgz | head -1   # 200 = installable',
        'npm view @camstack/server@<VER> dependencies   # pins the framework versions you changed',
      ],
      has('capability')
        ? 'A capability change must also force @camstack/system (nx-affected misses it for an edit under packages/types).'
        : 'The closure carries the framework and the bootstrap addons; a bootstrap-addon change needs a server publish to reach nodes.',
    )
    add(
      'applyServerUpdate, hub first, then each agent',
      [
        '(operator, per node) applyServerUpdate with the published @camstack/server version',
        'verify: getServerPackageStatus on the hub, then on every agent',
      ],
      'The hub restarts; the CLI wait often times out across the restart, so verify with getServerPackageStatus, not the exit code.',
    )
  }
  if (addons.length > 0 || framework) {
    add(
      'Deploy the addons the closure does not carry',
      [
        ...addons.map((dir) => `camstack deploy ${dir}`),
        ...(framework
          ? [
              'camstack deploy packages/system   # a system/types helper bundled inside forked addons',
            ]
          : []),
      ],
      'camstack deploy moves an addon, never the framework; for an agent add -n <nodeId> (after the hub).',
    )
  }
  if (framework || bootstrap || addons.length > 0) {
    add('Verify it is LIVE', [
      'pid changed on the node that runs it',
      'cap_providers <cap> shows the provider re-registered',
      'toggle the feature off and on and watch the effect follow (+1 restart for a new method)',
    ])
  }
  if (image) {
    add(
      'Image change: new image and a container recreate',
      [
        'release workflow (tag vX.Y.Z on a clean commit, after npm has the version)',
        'recreate the container per node (applyServerUpdate never delivers the starter or Dockerfile)',
      ],
      'Mirror any container-contract change (env, port, volume, device) in the Unraid templates, the Proxmox script and the public Compose docs by hand (D717, D822).',
    )
  }
  if (viewer) {
    add(
      'Viewer: OTA, then the hub bundle, then the pin',
      [
        '(camstack/) write the src/app/whats-new.ts entry FIRST (en + it, < 90 chars)',
        '(camstack/) npm run update:patch          # OTA',
        'npm run build:orchestrator                 # in camstack/',
        'camstack deploy packages/addon-pipeline-orchestrator',
        'commit the submodule pin + embedded bundle in camstack-server and push',
      ],
      'Even a src-only viewer change needs the OTA and the orchestrator bundle: the pin and the hub bundle travel together.',
    )
  }
  if (!shipsAnything) {
    return {
      executesNothing: true,
      classified,
      nothingToShip: true,
      steps: [],
      traps: note ? [...TRAPS, `Context: ${note}`] : TRAPS,
    }
  }
  return {
    executesNothing: true,
    classified,
    nothingToShip: false,
    steps,
    traps: note ? [...TRAPS, `Context: ${note}`] : TRAPS,
  }
}
