/**
 * `npm run i18n:set -- <dotted.key> "<en>" "<it>"`
 * `npm run i18n:get -- <dotted.key>`
 * `npm run i18n:keys -- <prefix>`
 *
 * `--pkg <dir>` selects the package (or its i18n folder). Default: admin-ui
 * (`packages/addon-admin-ui/src/i18n`). `--force` replaces an existing key.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CatalogCliError,
  getString,
  listKeys,
  readPair,
  resolveCatalogDir,
  setKey,
  writePair,
} from './catalog.ts'

export type CatalogCommand = 'set' | 'get' | 'keys'

export interface ParsedCatalogArgs {
  readonly command: CatalogCommand
  readonly key: string
  readonly enText: string | undefined
  readonly itText: string | undefined
  readonly force: boolean
  readonly pkg: string | undefined
}

const COMMANDS: readonly CatalogCommand[] = ['set', 'get', 'keys']

function isCommand(value: string): value is CatalogCommand {
  return COMMANDS.some((command) => command === value)
}

export function parseCatalogArgs(argv: readonly string[]): ParsedCatalogArgs {
  const positionals: string[] = []
  let force = false
  let pkg: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--force') {
      force = true
      continue
    }
    if (arg === '--pkg') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--'))
        throw new CatalogCliError('missing --pkg value')
      pkg = value
      i += 1
      continue
    }
    if (arg.startsWith('--')) throw new CatalogCliError(`unknown flag ${arg}`)
    positionals.push(arg)
  }
  const command = positionals[0]
  if (command === undefined || !isCommand(command)) {
    throw new CatalogCliError(
      'usage: i18n <set|get|keys> <dotted.key> [en] [it] [--pkg dir] [--force]',
    )
  }
  const key = positionals[1]
  if (key === undefined) throw new CatalogCliError(`missing key for ${command}`)
  if (command === 'set') {
    const enText = positionals[2]
    const itText = positionals[3]
    if (enText === undefined || itText === undefined) {
      throw new CatalogCliError('usage: i18n set <dotted.key> "<en>" "<it>" [--force] [--pkg dir]')
    }
    if (positionals.length > 4) throw new CatalogCliError('too many arguments')
    return { command, key, enText, itText, force, pkg }
  }
  if (positionals.length > 2) throw new CatalogCliError('too many arguments')
  if (force) throw new CatalogCliError('--force applies only to set')
  return { command, key, enText: undefined, itText: undefined, force: false, pkg }
}

function repoRoot(): string {
  return path.resolve(import.meta.dirname, '..', '..')
}

function requireText(value: string | undefined, label: string): string {
  if (value === undefined) throw new CatalogCliError(`missing ${label}`)
  return value
}

export function runCatalog(argv: readonly string[], root: string): string {
  const args = parseCatalogArgs(argv)
  const dir = resolveCatalogDir(root, args.pkg)
  const pair = readPair(dir)
  if (args.command === 'keys') {
    const keys = listKeys(pair.en, args.key)
    if (keys.length === 0) throw new CatalogCliError(`no keys under ${args.key}`)
    return `${keys.join('\n')}\n`
  }
  if (args.command === 'get') {
    const en = getString(pair.en, args.key)
    const it = getString(pair.it, args.key)
    if (en === undefined || it === undefined) throw new CatalogCliError(`missing key ${args.key}`)
    return `en: ${JSON.stringify(en)}\nit: ${JSON.stringify(it)}\n`
  }
  const enFile = path.join(dir, 'en.json')
  const previousEn = fs.readFileSync(enFile, 'utf8')
  const next = setKey(
    pair,
    args.key,
    requireText(args.enText, 'en text'),
    requireText(args.itText, 'it text'),
    args.force,
  )
  writePair(dir, next, previousEn)
  return `set ${args.key}\n`
}

function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return import.meta.url === pathToFileURL(entry).href
}

if (isDirectRun()) {
  try {
    process.stdout.write(runCatalog(process.argv.slice(2), repoRoot()))
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }
}
