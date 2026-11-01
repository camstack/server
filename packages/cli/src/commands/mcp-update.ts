/**
 * `camstack mcp update <version>|--latest` and `camstack mcp rollback` (D988).
 *
 * Only the installer's managed layout is switched (see `install-layout.ts`):
 * the new version is staged in `cli/<version>`, proven with
 * `mcp doctor --json`, and only then does `current` move — one atomic symlink
 * rename, `previous` kept for `rollback`. A failing doctor leaves `current`
 * exactly as it was. `~/.camstack` (the sign-in sessions) is never touched.
 * Any other layout gets instructions, never a write.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { detectInstallLayout, type InstallLayout } from '../install-layout.js'
import type { CommandResult } from '../mcp/ops-update-cli.js'

export const OPENCODE_RESTART_NOTE =
  'MCP clients such as OpenCode keep the old process running: restart the MCP in your client to use the new version.'

const LockSchema = z.object({
  packages: z.record(z.string(), z.object({ integrity: z.string().optional() })),
})

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export interface McpUpdateDeps {
  readonly entryPath: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  readonly run: (file: string, args: readonly string[]) => Promise<CommandResult>
  readonly latestVersion: () => Promise<string | null>
  readonly print: (line: string) => void
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

/** Point `link` at `target` atomically: a temp symlink renamed over it. */
function swapLink(link: string, target: string): void {
  const tmp = `${link}.tmp-${process.pid}`
  fs.rmSync(tmp, { force: true })
  fs.symlinkSync(target, tmp, 'dir')
  fs.renameSync(tmp, link)
}

function readLink(link: string): string | null {
  try {
    return fs.readlinkSync(link)
  } catch {
    return null
  }
}

function instructionsFor(layout: Exclude<InstallLayout, { kind: 'managed' }>): string {
  return layout.install.instructions
}

function runtimeTool(root: string, name: string): string {
  const own = path.join(root, 'runtime', 'bin', name)
  return exists(own) ? own : name
}

function runDoctor(root: string, dir: string, deps: McpUpdateDeps): Promise<CommandResult> {
  const entry = path.join(dir, 'node_modules', 'camstack', 'dist', 'cli.js')
  return deps.run(runtimeTool(root, 'node'), [entry, 'mcp', 'doctor', '--json'])
}

function lockIntegrity(staged: string): string | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(staged, 'package-lock.json'), 'utf8'))
    const parsed = LockSchema.safeParse(raw)
    return parsed.success
      ? (parsed.data.packages['node_modules/camstack']?.integrity ?? null)
      : null
  } catch {
    return null
  }
}

/**
 * The staged tarball must be the one the registry advertises: the integrity npm
 * recorded for what it downloaded equals `dist.integrity` asked again from the
 * registry; where `npm audit signatures` exists, an invalid signature refuses too.
 * Returns the refusal, or null when the package checks out.
 */
async function verifyIntegrity(
  root: string,
  staged: string,
  version: string,
  deps: McpUpdateDeps,
): Promise<string | null> {
  const npm = runtimeTool(root, 'npm')
  const advertised = await deps.run(npm, ['view', `camstack@${version}`, 'dist.integrity'])
  const downloaded = lockIntegrity(staged)
  if (!advertised.ok || advertised.output.trim() === '') {
    return `Could not read the registry's integrity for camstack@${version}.`
  }
  if (downloaded === null || downloaded !== advertised.output.trim()) {
    return `The downloaded camstack@${version} does not match the registry's integrity.`
  }
  const signatures = await deps.run(npm, ['audit', 'signatures', '--prefix', staged])
  if (!signatures.ok && /invalid.*signature/i.test(signatures.output)) {
    return `npm reports an invalid registry signature for camstack@${version}.`
  }
  return null
}

export async function runMcpUpdate(args: readonly string[], deps: McpUpdateDeps): Promise<number> {
  const layout = detectInstallLayout(deps.entryPath, deps.env, deps.home)
  if (layout.kind !== 'managed') {
    deps.print(instructionsFor(layout))
    deps.print(OPENCODE_RESTART_NOTE)
    return 0
  }
  const wantsLatest = args.includes('--latest')
  const requested = args.find((a) => !a.startsWith('-'))
  if (!wantsLatest && requested === undefined) {
    deps.print('Usage: camstack mcp update <version> | --latest')
    return 1
  }
  const version = wantsLatest ? await deps.latestVersion() : requested
  if (version === null) {
    deps.print(
      'Could not read the latest version from npm; name one: camstack mcp update <version>.',
    )
    return 1
  }
  if (version === undefined || !VERSION_PATTERN.test(version)) {
    deps.print(`"${version ?? ''}" is not a version like 1.2.3.`)
    return 1
  }
  const { root } = layout
  const staged = path.join(root, 'cli', version)
  const current = path.join(root, 'current')
  const alreadyStaged = exists(staged)
  if (!alreadyStaged) {
    fs.mkdirSync(staged, { recursive: true })
    const install = await deps.run(runtimeTool(root, 'npm'), [
      'install',
      '--prefix',
      staged,
      `camstack@${version}`,
      '--no-audit',
      '--no-fund',
      // A published package's install scripts never run on the operator's machine.
      '--ignore-scripts',
    ])
    if (!install.ok) {
      fs.rmSync(staged, { recursive: true, force: true })
      deps.print(
        `Staging camstack@${version} failed; the active version is unchanged.\n${install.output}`,
      )
      return 1
    }
  }
  const discard = (): void => {
    if (!alreadyStaged) fs.rmSync(staged, { recursive: true, force: true })
  }
  const integrity = await verifyIntegrity(root, staged, version, deps)
  if (integrity !== null) {
    discard()
    deps.print(`${integrity} The active version is unchanged.`)
    return 1
  }
  const doctor = await runDoctor(root, staged, deps)
  if (!doctor.ok) {
    discard()
    deps.print(
      `\`mcp doctor\` failed on camstack@${version}; the active version is unchanged.\n${doctor.output}`,
    )
    return 1
  }
  const before = readLink(current)
  if (before !== null) swapLink(path.join(root, 'previous'), before)
  swapLink(current, staged)
  deps.print(`camstack ${version} is now active (previous kept: \`camstack mcp rollback\`).`)
  deps.print(OPENCODE_RESTART_NOTE)
  return 0
}

export async function runMcpRollback(deps: McpUpdateDeps): Promise<number> {
  const layout = detectInstallLayout(deps.entryPath, deps.env, deps.home)
  if (layout.kind !== 'managed') {
    deps.print(instructionsFor(layout))
    return 0
  }
  const { root } = layout
  const previous = readLink(path.join(root, 'previous'))
  if (previous === null) {
    deps.print('There is no previous version to roll back to.')
    return 1
  }
  const resolved = path.resolve(root, previous)
  const cliDir = path.join(root, 'cli') + path.sep
  if (!resolved.startsWith(cliDir)) {
    deps.print(`\`previous\` points outside ${cliDir}; refusing to switch to it.`)
    return 1
  }
  const doctor = await runDoctor(root, resolved, deps)
  if (!doctor.ok) {
    deps.print(
      `\`mcp doctor\` failed on ${path.basename(resolved)}; the active version is unchanged.\n${doctor.output}`,
    )
    return 1
  }
  const current = path.join(root, 'current')
  const was = readLink(current)
  swapLink(current, resolved)
  if (was !== null) swapLink(path.join(root, 'previous'), was)
  deps.print(`Rolled back to ${path.basename(previous)}.`)
  deps.print(OPENCODE_RESTART_NOTE)
  return 0
}
