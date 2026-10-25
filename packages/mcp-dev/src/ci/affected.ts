import { spawnSync } from 'node:child_process'
import * as path from 'node:path'

export interface CheckCommand {
  readonly id: string
  readonly command: string
  readonly reason: string
}

const DENY = ['gh workflow run checks.yml', 'workflow run checks', 'npm publish', 'docker ', 'ssh ']

export function isDeniedCommand(command: string): boolean {
  const lower = command.toLowerCase()
  return DENY.some((d) => lower.includes(d.trim().toLowerCase()))
}

export function affectedChecks(
  workspaceRoot: string,
  opts?: { paths?: readonly string[]; gitDiff?: boolean },
): { paths: string[]; checks: CheckCommand[] } {
  let paths = opts?.paths?.map((p) => p.replace(/\\/g, '/')) ?? []
  if (paths.length === 0 || opts?.gitDiff) {
    paths = gitChangedPaths(workspaceRoot)
  }

  const checks: CheckCommand[] = []
  const add = (id: string, command: string, reason: string) => {
    if (checks.some((c) => c.id === id)) return
    if (isDeniedCommand(command)) return
    checks.push({ id, command, reason })
  }

  const packages = new Set<string>()
  let capsChanged = false
  let docsChanged = false
  let viewerChanged = false
  let uiLibChanged = false

  for (const p of paths) {
    const m = /^packages\/([^/]+)\//.exec(p)
    if (m) packages.add(m[1]!)
    if (p.includes('/capabilities/') && p.endsWith('.cap.ts')) capsChanged = true
    if (p.startsWith('docs/') || p.endsWith('AGENTS.md')) docsChanged = true
    if (p.startsWith('camstack/')) viewerChanged = true
    if (p.startsWith('packages/ui-library/')) uiLibChanged = true
    if (p.startsWith('scripts/check-')) {
      add(`guard:${p}`, `npx tsx ${p}`, 'Changed guard script')
    }
  }

  for (const pkg of packages) {
    add(`test:${pkg}`, `npm test -w packages/${pkg}`, `Tests for changed package ${pkg}`)
    add(
      `typecheck:${pkg}`,
      `npm run typecheck -w packages/${pkg}`,
      `Typecheck for changed package ${pkg}`,
    )
  }

  if (capsChanged) {
    add('codegen:check', 'npm run codegen:check', '*.cap.ts changed')
    add(
      'method-tiers',
      'npx tsx scripts/check-method-tiers.ts',
      'Capability methods may have shifted auth tiers',
    )
    add(
      'union-complete',
      'npx tsx scripts/check-capability-union-complete.ts',
      'Cap barrel / AnyCapability union',
    )
  }

  if (docsChanged || capsChanged) {
    add('docs:check', 'npm run docs:check', 'Docs or caps changed')
  }

  if (uiLibChanged) {
    add(
      'ui-catalogue',
      'npx tsx scripts/gen-ui-components.ts --check',
      'ui-library changed — catalogue drift',
    )
  }

  if (viewerChanged) {
    add('viewer:ts-check', 'npm run ts-check -w camstack', 'Viewer sources changed')
    add('viewer:test', 'npm run test:v2 -w camstack', 'Viewer sources changed')
  }

  if (checks.length === 0) {
    add('typecheck', 'npm run typecheck', 'No specific mapping — default typecheck')
  }

  return { paths, checks }
}

function gitChangedPaths(workspaceRoot: string): string[] {
  const result = spawnSync('git', ['diff', '--name-only', 'HEAD'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
  })
  const staged = spawnSync('git', ['diff', '--name-only', '--cached'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
  })
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
  })
  const all = `${result.stdout ?? ''}\n${staged.stdout ?? ''}\n${untracked.stdout ?? ''}`
  return [
    ...new Set(
      all
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((p) => p.replace(/\\/g, '/')),
    ),
  ]
}

export function runChecks(
  workspaceRoot: string,
  plan: readonly CheckCommand[],
  opts?: { timeoutMs?: number },
): {
  results: {
    id: string
    command: string
    ok: boolean
    exitCode: number | null
    outputTail: string
  }[]
  denied: string[]
} {
  const denied: string[] = []
  const results: {
    id: string
    command: string
    ok: boolean
    exitCode: number | null
    outputTail: string
  }[] = []

  for (const step of plan) {
    if (isDeniedCommand(step.command)) {
      denied.push(step.command)
      continue
    }
    // Parse simple "npm …" / "npx …" commands
    const parts = step.command.split(/\s+/)
    const bin = parts[0]!
    const args = parts.slice(1)
    const proc = spawnSync(bin, args, {
      cwd: workspaceRoot,
      encoding: 'utf8',
      timeout: opts?.timeoutMs ?? 180_000,
      shell: false,
      env: { ...process.env, FORCE_COLOR: '0' },
    })
    const output = `${proc.stdout ?? ''}\n${proc.stderr ?? ''}`
    results.push({
      id: step.id,
      command: step.command,
      ok: proc.status === 0,
      exitCode: proc.status,
      outputTail: output.length > 3000 ? output.slice(-3000) : output,
    })
  }

  return { results, denied }
}

export function packageFromPath(filePath: string): string | null {
  const m = /^packages\/([^/]+)\//.exec(filePath.replace(/\\/g, '/'))
  return m?.[1] ?? null
}

void path
