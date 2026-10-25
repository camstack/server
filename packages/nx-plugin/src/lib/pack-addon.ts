import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Pack the addon at `cwd` via `npm pack --pack-destination` and return
 * the absolute path of the produced .tgz. The destination defaults to
 * the project root so the tarball stays alongside the project (easy to
 * inspect / clean up); callers can override for CI artifact dirs.
 *
 * `npm pack --json` returns an array with `{filename, ...}` — we parse
 * just the filename and join it with the destination.
 */
export interface PackResult {
  readonly tarballPath: string
  readonly packageName: string
  readonly version: string
}

export function packAddon(cwd: string, destDir?: string): PackResult {
  const pkgJsonPath = path.join(cwd, 'package.json')
  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(`packAddon: no package.json found at ${cwd}`)
  }
  const dest = destDir ?? cwd
  fs.mkdirSync(dest, { recursive: true })

  // `npm pack --json` is the structured output mode — way nicer to
  // parse than scraping stdout for "*.tgz". The `--silent` flag
  // suppresses logspam that would otherwise interleave with the JSON.
  const stdout = execFileSync('npm', ['pack', '--json', '--pack-destination', dest], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })

  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(
      `packAddon: failed to parse \`npm pack --json\` output: ${stdout.slice(0, 200)}`,
    )
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`packAddon: \`npm pack --json\` returned empty array`)
  }
  const entry = parsed[0] as Record<string, unknown>
  const filename = entry['filename']
  const name = entry['name']
  const version = entry['version']
  if (typeof filename !== 'string' || typeof name !== 'string' || typeof version !== 'string') {
    throw new Error(
      `packAddon: \`npm pack --json\` returned malformed entry: ${JSON.stringify(entry)}`,
    )
  }
  return {
    tarballPath: path.join(dest, filename),
    packageName: name,
    version,
  }
}
