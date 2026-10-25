/**
 * Every addon icon a manifest declares must exist in its package AND ship in
 * its tarball.
 *
 * The admin UI asks `/api/addon-assets/<addonId>/<icon>` only for an addon
 * whose manifest declares `icon` (see `addon-admin-ui/src/lib/addon-icons.ts`).
 * That makes the declaration a promise: a path that is missing on disk, or
 * left out of `files` so `npm pack` drops it, is a 404 in every operator's
 * console and a broken image where the icon belongs.
 *
 * An addon-level `icon` must be an asset path (`.svg`/`.png`/`.jpg`/`.webp`);
 * a bare glyph name ("gauge") belongs to a page or widget entry, not here —
 * the UI would never draw it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface ManifestPackage {
  readonly files?: readonly string[]
  readonly camstack?: {
    readonly addons?: readonly { readonly id?: string; readonly icon?: unknown }[]
    readonly bundle?: { readonly icon?: unknown }
  }
}

const ASSET_EXTENSIONS = /\.(svg|png|jpe?g|webp)$/i

/** Is `relPath` included by an npm `files` allow-list? (absent list = everything). */
export function shippedByFiles(files: readonly string[] | undefined, relPath: string): boolean {
  if (!Array.isArray(files)) return true
  const clean = relPath.replace(/^\.\//, '')
  return files.some((entry) => {
    const e = String(entry).replace(/^\.\//, '').replace(/\/+$/, '')
    return clean === e || clean.startsWith(`${e}/`)
  })
}

/**
 * Problems with one package's declared icons.
 * `exists(relPath)` answers whether the file is on disk in the package.
 */
export function iconProblems(pkg: ManifestPackage, exists: (relPath: string) => boolean): string[] {
  const camstack = pkg.camstack ?? {}
  const declared: [string, unknown][] = []
  for (const addon of Array.isArray(camstack.addons) ? camstack.addons : []) {
    if (addon?.icon !== undefined) declared.push([addon.id ?? '?', addon.icon])
  }
  if (camstack.bundle?.icon !== undefined) declared.push(['(bundle)', camstack.bundle.icon])

  const problems: string[] = []
  for (const [id, icon] of declared) {
    if (typeof icon !== 'string' || !ASSET_EXTENSIONS.test(icon) || icon.includes('..')) {
      problems.push(`${id}: icon ${JSON.stringify(icon)} is not an asset path in the package`)
      continue
    }
    if (!exists(icon)) problems.push(`${id}: ${icon} does not exist`)
    else if (!shippedByFiles(pkg.files, icon))
      problems.push(`${id}: ${icon} is not covered by "files" — npm pack drops it`)
  }
  return problems
}

function main(): void {
  const root = process.cwd()
  const pkgsDir = join(root, 'packages')
  const offenders: string[] = []
  for (const name of readdirSync(pkgsDir)) {
    const dir = join(pkgsDir, name)
    const pjson = join(dir, 'package.json')
    if (!existsSync(pjson)) continue
    let pkg: ManifestPackage
    try {
      pkg = JSON.parse(readFileSync(pjson, 'utf8')) as ManifestPackage
    } catch {
      continue
    }
    for (const p of iconProblems(pkg, (rel) => existsSync(join(dir, rel)))) {
      offenders.push(`packages/${name}: ${p}`)
    }
  }
  if (offenders.length > 0) {
    console.error(
      '✘ a manifest declares an addon icon the hub cannot serve (a 404 in the admin UI):',
    )
    for (const o of offenders) console.error(`    ${o}`)
    console.error(
      '  Add the file under the package, list its folder in "files", or drop the `icon`.',
    )
    process.exit(1)
  }
  console.log('✔ every declared addon icon exists and ships in its package')
}

const isDirectRun =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) main()
