#!/usr/bin/env node
/**
 * No workspace package may define a script called `publish`.
 *
 * `publish` is an npm LIFECYCLE name. `npm publish` runs it as part of
 * publishing, so a script whose body is `npm publish --access public` makes the
 * command invoke itself: one of the two uploads wins, the other is answered
 * `403 cannot publish over the previously published version`, and the outer
 * command exits 1 — WITH THE ARTIFACT ON THE REGISTRY.
 *
 * Forty-two packages carried exactly that. It is the source of this repo's
 * long-running "flaky 403" folklore and of the elaborate compensation built
 * around it: a 180-second registry poll per failure that still called live
 * packages FAILED, and, on 2026-09-14, a `@camstack/server` published against a
 * dependency the same run had reported as failed — every node then refused to
 * stage with ETARGET.
 *
 * The convenience is kept under `publish:npm`, which npm does not treat as a
 * hook. Other reserved names are checked too: a `prepublish`/`postpublish`
 * whose body publishes has the same shape.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** npm lifecycle names that `npm publish` itself triggers. */
export const PUBLISH_LIFECYCLE_NAMES = ['publish', 'prepublish', 'postpublish', 'prepublishOnly']

/** A script that publishes from inside a publish lifecycle hook — the recursion. */
export function recursivePublishScripts(pkg) {
  const scripts = pkg.scripts ?? {}
  return PUBLISH_LIFECYCLE_NAMES.filter(
    (name) => typeof scripts[name] === 'string' && /\bnpm\s+publish\b/.test(scripts[name]),
  )
}

function packageJsonPaths(root) {
  const out = []
  const pkgDir = join(root, 'packages')
  if (existsSync(pkgDir)) {
    for (const name of readdirSync(pkgDir)) {
      const p = join(pkgDir, name, 'package.json')
      if (existsSync(p)) out.push(p)
    }
  }
  const backend = join(root, 'server', 'backend', 'package.json')
  if (existsSync(backend)) out.push(backend)
  return out
}

function main() {
  const root = process.cwd()
  const offenders = []
  for (const p of packageJsonPaths(root)) {
    let pkg
    try {
      pkg = JSON.parse(readFileSync(p, 'utf8'))
    } catch {
      continue
    }
    const bad = recursivePublishScripts(pkg)
    if (bad.length > 0) offenders.push(`${pkg.name ?? p}: ${bad.join(', ')}`)
  }
  if (offenders.length > 0) {
    console.error(
      '✘ a publish LIFECYCLE script runs `npm publish` — the command will invoke itself and exit 1 with the artifact already on the registry:',
    )
    for (const o of offenders) console.error(`    ${o}`)
    console.error('  Rename it to `publish:npm` (npm does not treat that as a hook).')
    process.exit(1)
  }
  console.log('✔ no package publishes from inside a publish lifecycle hook')
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main()
}
