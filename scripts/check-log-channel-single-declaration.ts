/**
 * A built addon entry must declare each log channel EXACTLY ONCE.
 *
 * On 2026-08-29 rolldown emitted `stream-broker/log-channels.ts` both inlined
 * into `stream-broker/index.mjs` AND into a shared chunk that the same entry
 * statically imports. Loading the addon ran `declareLogChannel` twice;
 * `declareLogChannel` refused the duplicate — correctly — and the whole
 * stream-broker failed to load. The hub had no broker and no live streams
 * until it was rolled back.
 *
 * The cause was a bare `import './log-channels.js'` kept alive by a comment: a
 * side-effect import carries no binding, so a bundler may duplicate the module
 * freely. The repair was to import the channel list by VALUE.
 *
 * Nothing else would have caught it. `typecheck`, `test`, `lint` and
 * `docs:check` were all green: none of them loads the built bundle, and the
 * fault exists only there. This guard reads the ARTEFACT.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT: string = process.cwd()
const DECL = /declareLogChannel\(\{/g
const NAME = /name:\s*'([^']+)'/g

interface Offence {
  readonly entry: string
  readonly channel: string
  readonly count: number
}

function chunksOf(entryFile: string): readonly string[] {
  const src = fs.readFileSync(entryFile, 'utf-8')
  const dir = path.dirname(entryFile)
  const out: string[] = [entryFile]
  for (const m of src.matchAll(/from\s*"([^"]+\.m?js)"/g)) {
    const rel = m[1]
    if (rel === undefined || !rel.startsWith('.')) continue
    const abs = path.resolve(dir, rel)
    if (fs.existsSync(abs) && !out.includes(abs)) out.push(abs)
  }
  return out
}

function scan(): readonly Offence[] {
  const offences: Offence[] = []
  const pkgs = path.join(ROOT, 'packages')
  for (const pkg of fs.readdirSync(pkgs)) {
    const dist = path.join(pkgs, pkg, 'dist')
    if (!fs.existsSync(dist)) continue
    const stack: string[] = [dist]
    while (stack.length > 0) {
      const dir = stack.pop()
      if (dir === undefined) continue
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) {
          stack.push(p)
          continue
        }
        if (!/index\.m?js$/.test(e.name)) continue
        const counts = new Map<string, number>()
        for (const file of chunksOf(p)) {
          const src = fs.readFileSync(file, 'utf-8')
          for (const decl of src.matchAll(DECL)) {
            const tail = src.slice(decl.index ?? 0, (decl.index ?? 0) + 400)
            const nm = new RegExp(NAME).exec(tail)
            if (nm?.[1] === undefined) continue
            counts.set(nm[1], (counts.get(nm[1]) ?? 0) + 1)
          }
        }
        for (const [channel, count] of counts) {
          if (count > 1) offences.push({ entry: path.relative(ROOT, p), channel, count })
        }
      }
    }
  }
  return offences
}

const found = scan()
if (found.length > 0) {
  console.error(`✘ ${found.length} duplicated log-channel declaration(s) in built bundles:`)
  for (const o of found) {
    console.error(`    ${o.entry} declares "${o.channel}" ${o.count} times`)
  }
  console.error('  A side-effect-only import lets the bundler duplicate the module.')
  console.error('  Import the channel list by VALUE so the binding resolves to one instance.')
  process.exit(1)
}
console.log('✔ every built entry declares each log channel exactly once')
