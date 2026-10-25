/**
 * `camstack develop …` — developer tooling for addon authors.
 *
 * Thin CLI over `@camstack/develop` (same ops as `@camstack/mcp-develop`).
 * Zero hub mutations; no SQLite opens.
 */
import { parseArgs } from 'node:util'
import {
  extendAddon,
  findExample,
  findWorkspaceRoot,
  getCapability,
  listAddonPackages,
  listCapabilities,
  listExamples,
  listSkills,
  readSkill,
  requireWorkspaceRoot,
  scaffoldAddon,
  scaffoldCapStub,
  validateAddon,
  whoProvides,
} from '@camstack/develop'

const HELP = `Usage: camstack develop <subcommand> [options]

Catalogue:
  list-addons [--json]              List workspace packages with camstack.addons[]
  list-caps [--json]                List *.cap.ts capability names
  who-provides <cap> [--json]       Which addons declare a capability
  find-example <query> [--json]     Ranked core-package examples
  examples [--json]                 Full curated example catalogue

Scaffold / extend:
  scaffold addon <name> [options]   New packages/addon-<name>/
    --display-name <str>
    --description <str>
    --kind empty|provider|notifier|osd|post-analysis
    --directory <dir>               Default: packages
    --dry-run
  scaffold cap <name> [options]     Stub packages/types/.../<name>.cap.ts
    --scope system|device
    --mode singleton|collection
    --dry-run
  extend <addon> --entry <id>       New manifest entry in an existing package
    --display-name <str>
    --description <str>
    --dry-run

Validate:
  validate [addon|--all] [--json]   Manifest + vite entries (+ known caps)

Skills:
  skills [--json]                   Paths to the portable skill pack
  skill <id>                        Print one skill markdown file

Also: nx g @camstack/nx-plugin:addon <name> (Nx path to the same idea).
`

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

function wantJson(args: readonly string[]): boolean {
  return args.includes('--json')
}

function withoutJson(args: readonly string[]): string[] {
  return args.filter((a) => a !== '--json')
}

export function developHelp(): string {
  return HELP
}

export async function runDevelop(args: readonly string[]): Promise<void> {
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log(HELP)
    return
  }

  const sub = args[0] ?? ''
  const rest = args.slice(1)

  switch (sub) {
    case 'list-addons':
      return cmdListAddons(rest)
    case 'list-caps':
      return cmdListCaps(rest)
    case 'who-provides':
      return cmdWhoProvides(rest)
    case 'find-example':
      return cmdFindExample(rest)
    case 'examples':
      return cmdExamples(rest)
    case 'scaffold':
      return cmdScaffold(rest)
    case 'extend':
      return cmdExtend(rest)
    case 'validate':
      return cmdValidate(rest)
    case 'skills':
      return cmdSkills(rest)
    case 'skill':
      return cmdSkill(rest)
    default:
      throw new Error(`Unknown develop subcommand: ${sub}\n\n${HELP}`)
  }
}

function cmdListAddons(args: readonly string[]): void {
  const root = requireWorkspaceRoot()
  const pkgs = listAddonPackages(root)
  if (wantJson(args)) {
    printJson(pkgs)
    return
  }
  for (const pkg of pkgs) {
    const ids = pkg.addons.map((a) => a.id).join(', ')
    console.log(`${pkg.packageName}\t${pkg.relativeDir}\t[${ids}]`)
  }
  console.log(`\n${pkgs.length} package(s)`)
}

function cmdListCaps(args: readonly string[]): void {
  const root = requireWorkspaceRoot()
  const caps = listCapabilities(root)
  if (wantJson(args)) {
    printJson(caps)
    return
  }
  for (const cap of caps) {
    const meta = [cap.scope, cap.mode].filter(Boolean).join('/')
    console.log(`${cap.name}\t${meta}\t${cap.relativeFile}`)
  }
  console.log(`\n${caps.length} capability(ies)`)
}

function cmdWhoProvides(args: readonly string[]): void {
  const json = wantJson(args)
  const cleaned = withoutJson(args)
  const cap = cleaned[0]
  if (!cap) throw new Error('Usage: camstack develop who-provides <cap>')
  const root = requireWorkspaceRoot()
  const hits = whoProvides(root, cap)
  if (json) {
    printJson(hits)
    return
  }
  if (hits.length === 0) {
    console.log(`No addon declares capability \`${cap}\`.`)
    return
  }
  for (const hit of hits) {
    console.log(`${hit.package.packageName}\t${hit.addon.id}\t${hit.package.relativeDir}`)
  }
}

function cmdFindExample(args: readonly string[]): void {
  const json = wantJson(args)
  const cleaned = withoutJson(args)
  const query = cleaned.join(' ').trim()
  if (!query) throw new Error('Usage: camstack develop find-example <query>')
  const root = findWorkspaceRoot() ?? process.cwd()
  const hits = findExample(root, query)
  if (json) {
    printJson(hits)
    return
  }
  if (hits.length === 0) {
    console.log('No examples matched.')
    return
  }
  for (const hit of hits.slice(0, 10)) {
    console.log(
      `[${hit.score}] ${hit.example.id}\t${hit.example.packageDir}\n` +
        `     ${hit.example.demonstrates}\n` +
        `     (${hit.rationale})`,
    )
  }
}

function cmdExamples(args: readonly string[]): void {
  const examples = listExamples()
  if (wantJson(args)) {
    printJson(examples)
    return
  }
  for (const ex of examples) {
    console.log(`${ex.id}\t${ex.kind}\t${ex.packageDir}\n  ${ex.demonstrates}`)
  }
}

function cmdScaffold(args: readonly string[]): void {
  const kind = args[0]
  if (kind === 'addon') return cmdScaffoldAddon(args.slice(1))
  if (kind === 'cap' || kind === 'capability') return cmdScaffoldCap(args.slice(1))
  throw new Error('Usage: camstack develop scaffold addon|cap <name> [options]')
}

function cmdScaffoldAddon(args: readonly string[]): void {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      'display-name': { type: 'string' },
      description: { type: 'string' },
      kind: { type: 'string' },
      directory: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  const name = positionals[0]
  if (!name) throw new Error('Usage: camstack develop scaffold addon <name>')

  const kindRaw = typeof values.kind === 'string' ? values.kind : 'empty'
  const allowed = new Set(['empty', 'provider', 'notifier', 'osd', 'post-analysis'])
  if (!allowed.has(kindRaw)) {
    throw new Error(`--kind must be one of: ${[...allowed].join(', ')}`)
  }

  const root = requireWorkspaceRoot()
  const result = scaffoldAddon({
    workspaceRoot: root,
    name,
    ...(typeof values['display-name'] === 'string' ? { displayName: values['display-name'] } : {}),
    ...(typeof values.description === 'string' ? { description: values.description } : {}),
    kind: kindRaw as 'empty' | 'provider' | 'notifier' | 'osd' | 'post-analysis',
    ...(typeof values.directory === 'string' ? { directory: values.directory } : {}),
    dryRun: values['dry-run'] === true,
  })

  console.log(
    values['dry-run'] === true
      ? `[dry-run] would create ${result.relativeDir}`
      : `Created ${result.relativeDir}`,
  )
  for (const f of result.filesWritten) console.log(`  + ${f}`)
  console.log('\nNext:')
  for (const step of result.nextSteps) console.log(`  - ${step}`)
}

function cmdScaffoldCap(args: readonly string[]): void {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      scope: { type: 'string' },
      mode: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  const name = positionals[0]
  if (!name) throw new Error('Usage: camstack develop scaffold cap <name>')

  const scope = typeof values.scope === 'string' ? values.scope : 'system'
  const mode = typeof values.mode === 'string' ? values.mode : 'singleton'
  if (scope !== 'system' && scope !== 'device') {
    throw new Error('--scope must be system or device')
  }
  if (mode !== 'singleton' && mode !== 'collection') {
    throw new Error('--mode must be singleton or collection')
  }

  const root = requireWorkspaceRoot()
  const result = scaffoldCapStub({
    workspaceRoot: root,
    name,
    scope,
    mode,
    dryRun: values['dry-run'] === true,
  })
  console.log(
    values['dry-run'] === true
      ? `[dry-run] would write ${result.relativePath}`
      : `Wrote ${result.relativePath} (${result.exportName})`,
  )
  console.log('\nNext:')
  for (const step of result.nextSteps) console.log(`  - ${step}`)
}

function cmdExtend(args: readonly string[]): void {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      entry: { type: 'string' },
      'display-name': { type: 'string' },
      description: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  const addon = positionals[0]
  const entry = typeof values.entry === 'string' ? values.entry : undefined
  if (!addon || !entry) {
    throw new Error('Usage: camstack develop extend <addon> --entry <id>')
  }

  const root = requireWorkspaceRoot()
  const result = extendAddon({
    workspaceRoot: root,
    addon,
    entryId: entry,
    ...(typeof values['display-name'] === 'string' ? { displayName: values['display-name'] } : {}),
    ...(typeof values.description === 'string' ? { description: values.description } : {}),
    dryRun: values['dry-run'] === true,
  })
  console.log(
    values['dry-run'] === true
      ? `[dry-run] would extend ${result.packageDir} with ${result.entryId}`
      : `Extended ${result.packageDir} with entry ${result.entryId}`,
  )
  for (const f of result.filesWritten) console.log(`  ~ ${f}`)
  console.log('\nNext:')
  for (const step of result.nextSteps) console.log(`  - ${step}`)
}

function cmdValidate(args: readonly string[]): void {
  const json = wantJson(args)
  const cleaned = withoutJson(args)
  const query = cleaned[0]
  const root = requireWorkspaceRoot()
  const result = validateAddon(root, query)
  if (json) {
    printJson(result)
  } else {
    if (result.findings.length === 0) {
      console.log('✔ no findings')
    } else {
      for (const f of result.findings) {
        const mark = f.level === 'error' ? '✘' : f.level === 'warn' ? '!' : '·'
        console.log(`${mark} [${f.code}] ${f.message}`)
      }
    }
    console.log(result.ok ? '\n✔ validate ok' : '\n✘ validate failed')
  }
  if (!result.ok) process.exitCode = 1
}

function cmdSkills(args: readonly string[]): void {
  const skills = listSkills()
  if (wantJson(args)) {
    printJson(skills)
    return
  }
  console.log('Portable skill pack (@camstack/develop/skills):\n')
  for (const s of skills) {
    console.log(`${s.id}\t${s.title}\n  ${s.absolutePath}`)
  }
}

function cmdSkill(args: readonly string[]): void {
  const id = args[0]
  if (!id) throw new Error('Usage: camstack develop skill <id>')
  const skill = readSkill(id)
  if (!skill) {
    const known = listSkills()
      .map((s) => s.id)
      .join(', ')
    throw new Error(`Unknown skill: ${id}. Known: ${known}`)
  }
  console.log(skill.content)
}

/** Exported for tests — resolve a cap without printing. */
export function peekCapability(name: string): string | null {
  const root = findWorkspaceRoot()
  if (!root) return null
  return getCapability(root, name)?.name ?? null
}
