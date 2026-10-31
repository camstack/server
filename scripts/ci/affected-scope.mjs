#!/usr/bin/env node
// What a change set touches, for the gates that are scoped to it: the
// TypeScript 7 typecheck, the build, and the D28 addon footprint guard. ONE
// implementation for CI (`static` job) and `npm run verify:push`, so the local
// gate and the CI gate cannot grade different sets.
//
// Usage: node scripts/ci/affected-scope.mjs <file with one changed path per line, or comma list>
//        node scripts/ci/affected-scope.mjs --csv "<comma list>"
//
// Prints shell-evaluable lines:
//   TC_DIRS='ALL' | 'cli ui-library …' | ''   package dirs for typecheck-tsgo.ts ('' = nothing affected)
//   AFFECTED_CSV='@camstack/cli,…'            affected nx projects (build, test)
//   FOOTPRINT_ALL=1|0                          every addon dist may have changed (types/src moved)
//   FOOTPRINT_ADDONS='addon-a,addon-b'         the addons whose own sources changed
//   SCRIPTS_CHANGED=1|0                        scripts/ moved (repo-scripts tests)
//
// ALL when `types` or `system` is affected: every project consumes them, so the
// full sweep is the honest answer (a framework change can break any package).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const arg = process.argv[2]
if (!arg) {
  console.error('usage: affected-scope.mjs <file> | --csv "<a,b>"')
  process.exit(2)
}
const raw = arg === '--csv' ? (process.argv[3] ?? '') : fs.readFileSync(arg, 'utf8')
const files = raw.split(/[\n,]/).filter(Boolean)

const SLICE = 60000 // argv limit; affected is monotone per file, so slices union exactly
const slices = []
let cur = ''
for (const f of files) {
  if (cur && cur.length + f.length + 1 > SLICE) {
    slices.push(cur)
    cur = ''
  }
  cur = cur ? `${cur},${f}` : f
}
if (cur) slices.push(cur)
const affected = new Set()
for (const sl of slices) {
  const out = JSON.parse(
    execFileSync('npx', ['nx', 'show', 'projects', '--affected', `--files=${sl}`, '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    }),
  )
  for (const p of out) affected.add(p)
}

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}
const dirs = [...fs.readdirSync('packages').map((d) => path.join('packages', d)), path.join('server', 'backend')]
const byName = new Map()
for (const dir of dirs) {
  const pkg = readJson(path.join(dir, 'package.json'))
  if (!pkg) continue
  const name = readJson(path.join(dir, 'project.json'))?.name ?? pkg.name
  byName.set(name, path.basename(dir))
  byName.set(pkg.name, path.basename(dir))
}
const tcDirs = []
for (const p of affected) if (byName.has(p)) tcDirs.push(byName.get(p))

const footprintAll = files.some((f) => f.startsWith('packages/types/src/'))
const footprintAddons = [
  ...new Set(files.map((f) => /^packages\/(addon-[^/]+)\//.exec(f)?.[1]).filter(Boolean)),
].sort()
const scriptsChanged = files.some((f) => f.startsWith('scripts/'))

const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const all = tcDirs.includes('types') || tcDirs.includes('system')
console.log(`TC_DIRS=${sh(tcDirs.length === 0 ? '' : all ? 'ALL' : tcDirs.join(' '))}`)
console.log(`AFFECTED_CSV=${sh([...affected].join(','))}`)
console.log(`FOOTPRINT_ALL=${footprintAll ? 1 : 0}`)
console.log(`FOOTPRINT_ADDONS=${sh(footprintAddons.join(','))}`)
console.log(`SCRIPTS_CHANGED=${scriptsChanged ? 1 : 0}`)
