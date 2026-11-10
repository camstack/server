#!/usr/bin/env node
/**
 * The two test commands an agent runs, always inside the machine-wide test
 * slot (scripts/ci/test-slot.sh — the package.json scripts wrap this file):
 *
 *   npm run test:related -- <changed files…>
 *       `vitest related --run` per owning package: the specs that import the
 *       changed files, in the package that owns each file. A spec you edited
 *       is its own related file, so name it too.
 *
 *   npm run test:pkg -- <package>
 *       a package's whole suite (`npm run test -w <dir>`). Only when the brief
 *       asks for it: full suites belong to verify:push, once per batch.
 *
 * Paths are taken relative to the directory npm was started from (INIT_CWD),
 * so a call from a package directory works too.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** Source a vitest run can relate to a spec; docs, json and styles cannot. */
const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/

/**
 * The directory whose vitest config owns `file`: the nearest ancestor (inside
 * the repo) holding a `vitest.config.ts` or a `package.json`, else the root.
 *
 * @param {string} root absolute repo root
 * @param {string} file absolute file path
 * @param {(p: string) => boolean} exists
 * @returns {string} absolute owner directory
 */
export function ownerDir(root, file, exists = existsSync) {
  let dir = path.dirname(file)
  while (dir.startsWith(root) && dir !== root) {
    if (exists(path.join(dir, 'vitest.config.ts')) || exists(path.join(dir, 'package.json'))) return dir
    dir = path.dirname(dir)
  }
  return root
}

/**
 * Changed files grouped by owning directory, code files only, existing only.
 *
 * @param {string} root absolute repo root
 * @param {readonly string[]} files absolute paths
 * @param {(p: string) => boolean} exists
 * @returns {Map<string, string[]>} owner dir → absolute files
 */
export function groupByOwner(root, files, exists = existsSync) {
  /** @type {Map<string, string[]>} */
  const groups = new Map()
  for (const file of files) {
    if (!CODE_FILE.test(file) || !exists(file)) continue
    if (!file.startsWith(`${root}${path.sep}`)) continue
    const owner = ownerDir(root, file, exists)
    groups.set(owner, [...(groups.get(owner) ?? []), file])
  }
  return groups
}

/**
 * A package argument as a workspace directory: a path (`packages/addon-x`),
 * or a basename under `packages/` (`addon-x`), or `backend` for server/backend.
 *
 * @param {string} root
 * @param {string} name
 * @param {(p: string) => boolean} exists
 * @returns {string | null} repo-relative directory
 */
export function resolvePackageDir(root, name, exists = existsSync) {
  const trimmed = name.replace(/\/+$/, '')
  const candidates = [trimmed, `packages/${trimmed}`, trimmed === 'backend' ? 'server/backend' : '']
  for (const candidate of candidates) {
    if (candidate !== '' && exists(path.join(root, candidate, 'package.json'))) return candidate
  }
  return null
}

function run(command, args, cwd) {
  console.error(`test-run: (${path.relative(ROOT, cwd) || '.'}) ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  return result.status ?? 1
}

function related(files) {
  const base = process.env.INIT_CWD ?? process.cwd()
  const absolute = files.map((f) => path.resolve(base, f))
  const groups = groupByOwner(ROOT, absolute)
  if (groups.size === 0) {
    console.error('test-run: no existing code file among the arguments — nothing to relate')
    return 0
  }
  let status = 0
  for (const [dir, owned] of groups) {
    const code = run('npx', ['vitest', 'related', '--run', '--passWithNoTests', ...owned], dir)
    if (code !== 0) status = code
  }
  return status
}

function pkg(names) {
  let status = 0
  for (const name of names) {
    const dir = resolvePackageDir(ROOT, name)
    if (dir === null) {
      console.error(`test-run: no workspace package '${name}' (a path, a packages/ basename, or backend)`)
      return 2
    }
    const code = run('npm', ['run', 'test', '-w', dir], ROOT)
    if (code !== 0) status = code
  }
  return status
}

function main() {
  const [mode, ...rest] = process.argv.slice(2)
  if ((mode !== 'related' && mode !== 'pkg') || rest.length === 0) {
    console.error('usage: npm run test:related -- <files…> | npm run test:pkg -- <package…>')
    process.exit(2)
  }
  process.exit(mode === 'related' ? related(rest) : pkg(rest))
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
