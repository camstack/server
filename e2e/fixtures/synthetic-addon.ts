/**
 * Synthetic addon package builder.
 *
 * Produces a self-contained, no-op addon directory at an arbitrary
 * version — used by the CLI-vs-npm suite to exercise the installer's
 * version-resolution policy without dragging in a real addon's
 * native-dep + framework-coupled boot path.
 *
 * The generated addon:
 *   - has a unique scoped name (caller-supplied; default
 *     `@camstack/e2e-fixture-noop`).
 *   - declares ONE camstack addon entry pointing at `dist/addon.js`.
 *   - exports a default class with `async initialize()` that returns an
 *     empty ProviderRegistration list. This satisfies the kernel's
 *     `resolveAddonClass` probe (looks for `prototype.initialize`) and
 *     lets the addon reach the `running` state with zero side effects.
 *   - leaves `assets/` empty so the icon endpoint resolves to a 404 —
 *     icon regression coverage lives in addon-lifecycle.spec.ts.
 */
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Where the addon is allowed to run. Mirrors the kernel's
 * `AddonPlacement` union (`packages/types/src/interfaces/addon.ts`):
 *   - `hub-only` — never deploys to an agent (default).
 *   - `agent-only` — only runs on remote agents (never on the hub).
 *   - `any-node` — eligible on either hub or agents.
 *
 * The per-node-update suite uses `agent-only` so the synthetic addon
 * is genuinely agent-scoped: it must NOT appear in a hub-side
 * `addons.listUpdates`.
 */
export type SyntheticAddonPlacement = 'hub-only' | 'agent-only' | 'any-node'

export interface SyntheticAddonOptions {
  /** Package name. Default: `@camstack/e2e-fixture-noop`. */
  readonly name?: string
  /** Semver. */
  readonly version: string
  /**
   * If passed, the addon is written under `dir/`. Otherwise a fresh
   * mktemp directory is created. Caller is responsible for cleanup
   * when passing `dir`.
   */
  readonly dir?: string
  /** Execution placement. Default: `hub-only`. */
  readonly placement?: SyntheticAddonPlacement
}

export interface SyntheticAddon {
  readonly dir: string
  readonly name: string
  readonly version: string
  readonly addonId: string
}

const DEFAULT_NAME = '@camstack/e2e-fixture-noop'

export function buildSyntheticAddon(options: SyntheticAddonOptions): SyntheticAddon {
  const name = options.name ?? DEFAULT_NAME
  const version = options.version
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'camstack-fixture-addon-'))
  const addonId = 'e2e-fixture-noop'
  const placement: SyntheticAddonPlacement = options.placement ?? 'hub-only'

  mkdirSync(join(dir, 'dist'), { recursive: true })
  mkdirSync(join(dir, 'assets'), { recursive: true })

  // Package manifest — minimum surface the kernel + admin UI accept.
  const pkg = {
    name,
    version,
    description: 'Synthetic no-op addon for the e2e CLI-vs-npm suite',
    keywords: ['camstack', 'camstack-addon', 'addon', 'e2e-fixture'],
    license: 'MIT',
    main: './dist/index.js',
    files: ['dist', 'assets'],
    camstack: {
      displayName: 'E2E Fixture (no-op)',
      addons: [
        {
          id: addonId,
          name: 'E2E Fixture (no-op)',
          version,
          description: `Synthetic addon at ${version} — exercises installer/loader codepaths only.`,
          entry: './dist/addon.js',
          color: '#9ca3af',
          execution: {
            placement,
            group: 'main-group',
          },
          capabilities: [],
        },
      ],
    },
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')

  // No-op addon entry: a class whose prototype has `initialize` (the
  // kernel's addon-class probe). `initialize` returns no provider
  // registrations so the addon reaches `running` with nothing wired.
  // Embedding the version as a const lets tests assert what *actually*
  // loaded (matters in scenario 2 where multiple sources race).
  const addonJs = [
    `'use strict';`,
    ``,
    `class FixtureAddon {`,
    `  async initialize() { return []; }`,
    `  async stop() {}`,
    `}`,
    `FixtureAddon.LOADED_VERSION = ${JSON.stringify(version)};`,
    ``,
    `module.exports = FixtureAddon;`,
    `module.exports.default = FixtureAddon;`,
    ``,
  ].join('\n')
  writeFileSync(join(dir, 'dist', 'addon.js'), addonJs)
  writeFileSync(
    join(dir, 'dist', 'index.js'),
    `'use strict';\nmodule.exports = { name: ${JSON.stringify(name)}, version: ${JSON.stringify(version)} };\n`,
  )

  return { dir, name, version, addonId }
}
