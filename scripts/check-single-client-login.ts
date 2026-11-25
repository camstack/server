#!/usr/bin/env tsx
/**
 * A client tool reaches a hub through ONE credential: the `camstack login`
 * session (D1101). Every other way is retired, and anything that depended on
 * one was migrated, not exempted.
 *
 * Refused, in client tooling (`scripts/`, `tests/e2e/`, the CLI, develop,
 * mcp-develop and nx-plugin sources, `.sh` files included):
 *   - an environment token: `CAMSTACK_TOKEN`, `CAMSTACK_HUB_TOKEN*`, a
 *     `*_TOKEN_FILE` variable naming a hub credential;
 *   - a `--token` / `--token-file` option;
 *   - a `login` call (`auth.login`, `system.login`, `admin.login`) from `scripts/`:
 *     a script never logs in with a password, it reads the session.
 *
 * NOT refused: the agent JOIN token. It is a node's identity at first pairing,
 * not a client login, so `agent.ts`, the `camstack agent` usage text in `main.ts`,
 * `dev-cluster.sh` and `dev-agent-only.sh` keep `--token` / `CAMSTACK_HUB_TOKEN`
 * on lines marked `agent-join:line` / between `agent-join:begin` and `agent-join:end`.
 *
 * A file that exists to REFUSE a removed flag names it (`REMOVED_ALLOWED`).
 * Comment-only lines are skipped. Textual; specs are not scanned.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const ROOTS = [
  'scripts',
  'tests/e2e',
  'packages/cli/src',
  'packages/develop/src',
  'packages/mcp-develop/src',
  'packages/nx-plugin/src',
]
const SKIP_DIRS = new Set(['dist', 'node_modules', '__tests__', '__mocks__', 'generated'])
const SOURCE_RE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|sh)$/
const NON_RUNTIME_RE = /\.(?:spec|test)\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/

/**
 * Node identity, not a client login. Only these files may carry the agent join
 * token, and only on lines marked `agent-join:line` or between `agent-join:begin`
 * and `agent-join:end`: a client command in the same file that regains
 * `--token` or `CAMSTACK_TOKEN` outside a marker still fails.
 */
const AGENT_JOIN_FILES: ReadonlySet<string> = new Set([
  'packages/cli/src/commands/agent.ts',
  'packages/cli/src/main.ts',
  'scripts/dev-cluster.sh',
  'scripts/dev-agent-only.sh',
])

/** Files whose job is to refuse a removed flag, so they name it. */
const REMOVED_ALLOWED: ReadonlySet<string> = new Set([
  'packages/cli/src/commands/removed-token-flags.ts',
  'packages/cli/src/commands/login-legacy-flags.ts',
  'scripts/check-single-client-login.ts',
  'scripts/check-no-token-file-lookup.ts',
])

/**
 * Files that are real client commands but refuse a removed flag in one place:
 * the flag may be named only on `removed-flag:line` or between `removed-flag:begin`
 * and `removed-flag:end`. A token flag anywhere else in the file still fails.
 */
const REMOVED_REGION_FILES: ReadonlySet<string> = new Set([
  'scripts/hub/hub.mjs',
  'scripts/deploy-addon.sh',
])

const ENV_TOKEN = /\bCAMSTACK_TOKEN\b|\bCAMSTACK_HUB_TOKEN\w*|\bCAMSTACK_\w*TOKEN_FILE\b/
const TOKEN_OPTION = /['"`\s](--token(?:-file)?)(?=[\s='"`)\]]|$)/
const LOGIN_CALL = /\b(?:auth|system|admin)\.login\b|['"`](?:auth|system|admin)\.login['"`]/

export type Rule = 'env-token' | 'token-option' | 'login-call'

export interface SingleLoginFinding {
  readonly file: string
  readonly line: number
  readonly rule: Rule
  readonly text: string
}

function walk(dir: string, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (SOURCE_RE.test(name) && !NON_RUNTIME_RE.test(name)) out.push(full)
  }
}

function isCommentLine(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*') || t.startsWith('#')
}

/** Every non-comment line of `source` (at repo-relative path `file`) that breaks the rule. */
export function findSingleLoginViolations(
  file: string,
  source: string,
): readonly SingleLoginFinding[] {
  const found: SingleLoginFinding[] = []
  const agentFile = AGENT_JOIN_FILES.has(file)
  let inAgentRegion = false
  const refusalFile = REMOVED_REGION_FILES.has(file)
  let inRefusal = false
  const inScripts = file.startsWith('scripts/')
  source.split('\n').forEach((text, i) => {
    if (agentFile && text.includes('agent-join:begin')) inAgentRegion = true
    if (agentFile && text.includes('agent-join:end')) inAgentRegion = false
    if (refusalFile && text.includes('removed-flag:begin')) inRefusal = true
    if (refusalFile && text.includes('removed-flag:end')) inRefusal = false
    const agent = agentFile && (inAgentRegion || text.includes('agent-join:line'))
    const removed =
      REMOVED_ALLOWED.has(file) ||
      (refusalFile && (inRefusal || text.includes('removed-flag:line')))
    if (isCommentLine(text)) return
    const add = (rule: Rule): void => {
      found.push({ file, line: i + 1, rule, text: text.trim() })
    }
    if (!agent && !removed && ENV_TOKEN.test(text)) add('env-token')
    if (!agent && !removed && TOKEN_OPTION.test(text)) add('token-option')
    if (inScripts && !removed && LOGIN_CALL.test(text)) add('login-call')
  })
  return found
}

function main(): number {
  const files: string[] = []
  for (const r of ROOTS) walk(path.join(ROOT, r), files)
  const findings: SingleLoginFinding[] = []
  for (const f of files) {
    const rel = path.relative(ROOT, f)
    findings.push(...findSingleLoginViolations(rel, readFileSync(f, 'utf8')))
  }
  if (findings.length === 0) {
    console.log(
      `check-single-client-login: ${files.length} files, the login session is the only credential`,
    )
    return 0
  }
  console.error(
    `check-single-client-login: ${findings.length} line(s) reach a hub another way than the \`camstack login\` session (D1101):`,
  )
  for (const f of findings) console.error(`  ${f.file}:${f.line} [${f.rule}]  ${f.text}`)
  console.error(
    '\nRun `camstack login <host>` once; a script calls resolveHubAuth() from scripts/hub/credentials.mjs, a package uses resolveFreshCredentials.',
  )
  return 1
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(main())
}
