/**
 * `camstack update` — self-upgrade.
 *
 * Detection chain:
 *   • npx invocation (path contains `_npx/`) → no-op with friendly hint.
 *   • Otherwise → `npm install -g camstack@<latest>`.
 *
 * The npm command inherits stdio so the operator sees real-time output
 * (download progress + post-install scripts). We pipe through the same
 * shell PATH that launched us, so nvm / volta / asdf setups work
 * naturally without us guessing where the global prefix lives.
 */
import { parseArgs } from 'node:util'
import { spawn } from 'node:child_process'
import * as clack from '@clack/prompts'
import { fetchLatestVersion } from '../update-notifier.js'

/**
 * Detect whether we're running via npx (transient one-shot install).
 * For npx, "update" makes no sense — every invocation already pulls
 * the freshest version cached in `~/.npm/_npx`.
 */
function isRunningViaNpx(): boolean {
  const entry = process.argv[1] ?? ''
  return entry.includes('/_npx/') || entry.includes('\\_npx\\')
}

function runNpmInstall(spec: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // We use `spawn` (not execSync) so npm's progress output streams
    // through to the operator. `npm` is on PATH by definition — if it
    // wasn't, the CLI itself couldn't have been installed.
    const proc = spawn('npm', ['install', '-g', spec], { stdio: 'inherit' })
    proc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`npm install -g ${spec} exited with code ${code}`))
    })
    proc.on('error', reject)
  })
}

export async function runUpdate(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      version: { type: 'string', short: 'V' },
      yes: { type: 'boolean', short: 'y' },
    },
    strict: true,
    allowPositionals: false,
  })
  const pinnedVersion = typeof values.version === 'string' ? values.version : undefined
  const skipConfirm = values.yes === true

  if (isRunningViaNpx()) {
    console.log('You are running via npx — versions are fetched per-invocation.')
    console.log('Just call `npx camstack@latest <cmd>` for the freshest release.')
    console.log('To install globally: `npm install -g camstack@latest`')
    return
  }

  clack.intro('camstack update')

  // Resolve the target version. Pinned wins; otherwise hit the registry.
  let target: string
  if (pinnedVersion) {
    target = pinnedVersion
  } else {
    const spinner = clack.spinner()
    spinner.start('Checking npm registry')
    const latest = await fetchLatestVersion('camstack')
    if (!latest) {
      spinner.stop('Could not reach the npm registry.')
      throw new Error('Network error — try again or pass --version <x.y.z>')
    }
    spinner.stop(`Latest published: ${latest}`)
    target = latest
  }

  // Compare with the currently installed version (read from this bundle's
  // package.json — same source as `camstack --version`).
  const { createRequire } = await import('node:module')
  const { fileURLToPath } = await import('node:url')
  const { dirname, resolve } = await import('node:path')
  const require = createRequire(import.meta.url)
  const here = dirname(fileURLToPath(import.meta.url))
  let current = '0.0.0'
  try {
    const pkg = require(resolve(here, '..', 'package.json')) as { version: string }
    current = pkg.version
  } catch {
    /* fallback to 0.0.0 — forces update path */
  }

  if (current === target && !pinnedVersion) {
    clack.outro(`Already at ${current} — no update needed.`)
    return
  }

  clack.log.info(`Current: ${current}  →  Target: ${target}`)

  // Confirmation gate (skippable with --yes for scripts).
  if (!skipConfirm) {
    const ok = await clack.confirm({
      message: `Install camstack@${target} globally with npm?`,
      initialValue: true,
    })
    if (clack.isCancel(ok) || ok === false) {
      clack.cancel('Cancelled.')
      return
    }
  }

  console.log('')
  try {
    await runNpmInstall(`camstack@${target}`)
  } catch (err) {
    clack.log.error(err instanceof Error ? err.message : String(err))
    clack.log.warn(
      'If you see EACCES, your global npm prefix may need sudo or a different prefix. See https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally',
    )
    throw err
  }
  clack.outro(`✓ Installed camstack@${target}. Verify with: camstack --version`)
}
