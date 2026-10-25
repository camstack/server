import { spawnSync } from 'node:child_process'

export interface CodegenResult {
  readonly command: string
  readonly ok: boolean
  readonly exitCode: number | null
  readonly summary: string
  readonly stdoutTail: string
  readonly stderrTail: string
}

export function runCodegen(
  workspaceRoot: string,
  opts?: { check?: boolean; timeoutMs?: number },
): CodegenResult {
  const script = opts?.check ? 'codegen:check' : 'codegen'
  const command = `npm run ${script}`
  const result = spawnSync('npm', ['run', script], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    timeout: opts?.timeoutMs ?? 120_000,
    env: { ...process.env, FORCE_COLOR: '0' },
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const combined = `${stdout}\n${stderr}`
  return {
    command,
    ok: result.status === 0,
    exitCode: result.status,
    summary: summarizeCodegen(combined, result.status === 0),
    stdoutTail: tail(stdout, 4000),
    stderrTail: tail(stderr, 2000),
  }
}

export function methodTiersDiff(
  workspaceRoot: string,
  opts?: { update?: boolean; timeoutMs?: number },
): CodegenResult {
  const args = ['tsx', 'scripts/check-method-tiers.ts']
  if (opts?.update) args.push('--update')
  const command = `npx ${args.join(' ')}`
  const result = spawnSync('npx', args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    timeout: opts?.timeoutMs ?? 120_000,
    env: { ...process.env, FORCE_COLOR: '0' },
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  return {
    command,
    ok: result.status === 0,
    exitCode: result.status,
    summary: summarizeTiers(`${stdout}\n${stderr}`, result.status === 0, opts?.update === true),
    stdoutTail: tail(stdout, 6000),
    stderrTail: tail(stderr, 2000),
  }
}

function summarizeCodegen(text: string, ok: boolean): string {
  if (ok) return 'codegen completed successfully'
  const failures = [...text.matchAll(/(?:error|Error|FAIL|✘)[^\n]{0,120}/g)]
    .slice(0, 8)
    .map((m) => m[0])
  return failures.length > 0
    ? `codegen failed:\n${failures.join('\n')}`
    : 'codegen failed (see stdout/stderr tails)'
}

function summarizeTiers(text: string, ok: boolean, update: boolean): string {
  const widened = [...text.matchAll(/widened[^\n]*/gi)].map((m) => m[0])
  const changed = [...text.matchAll(/^[+-]\s+\w+\.\w+[^\n]*/gm)].slice(0, 20).map((m) => m[0])
  if (update && ok)
    return `baseline updated${changed.length ? `; ${changed.length} lines touched` : ''}`
  if (ok) return 'method tiers match baseline'
  const parts = ['method tiers drifted']
  if (widened.length) parts.push(`widened: ${widened.slice(0, 5).join('; ')}`)
  if (changed.length) parts.push(changed.join('\n'))
  return parts.join('\n')
}

function tail(s: string, n: number): string {
  return s.length <= n ? s : s.slice(-n)
}
