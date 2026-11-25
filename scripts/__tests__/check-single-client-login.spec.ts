import { describe, expect, it } from 'vitest'
import { findSingleLoginViolations } from '../check-single-client-login.js'

const rules = (file: string, source: string): readonly string[] =>
  findSingleLoginViolations(file, source).map((f) => f.rule)

describe('check-single-client-login', () => {
  it.each([
    ['CAMSTACK_TOKEN', "const t = process.env['CAMSTACK_TOKEN']"],
    ['CAMSTACK_HUB_TOKEN', 'const t = process.env.CAMSTACK_HUB_TOKEN'],
    ['CAMSTACK_HUB_TOKEN_FILE', "env['CAMSTACK_HUB_TOKEN_FILE']"],
    ['a shell variable', 'curl -H "Authorization: Bearer $CAMSTACK_TOKEN" "$HUB"'],
  ])('refuses an env token: %s', (_name, line) => {
    expect(rules('scripts/probe.mts', line)).toContain('env-token')
    expect(rules('scripts/probe.sh', line)).toContain('env-token')
  })

  it.each([
    ["arg('token-file') and a flag literal", "const f = argv.indexOf('--token-file')"],
    ['--token', "program.option('--token <t>')"],
    ['a shell flag', '  --token) TOKEN="$2"; shift 2 ;;'],
  ])('refuses a token option: %s', (_name, line) => {
    expect(rules('packages/cli/src/commands/deploy.ts', line)).toContain('token-option')
  })

  it('does not take --token-url or --tokens for the option', () => {
    expect(rules('scripts/x.ts', "'--tokens'")).toEqual([])
  })

  it('refuses a login call from scripts/, not from a package', () => {
    const line = "await fetch(`${SERVER}/trpc/auth.login`, { method: 'POST' })"
    expect(rules('scripts/bench.mts', line)).toContain('login-call')
    expect(rules('packages/cli/src/commands/login.ts', line)).toEqual([])
  })

  it('leaves the agent join token alone', () => {
    const line = 'HUB_TOKEN="$CAMSTACK_HUB_TOKEN" camstack agent --token "$HUB_TOKEN"'
    expect(rules('scripts/dev-cluster.sh', line)).toEqual([])
    expect(rules('scripts/dev-agent-only.sh', line)).toEqual([])
    expect(rules('packages/cli/src/commands/agent.ts', line)).toEqual([])
    expect(rules('scripts/other.sh', line)).toContain('env-token')
  })

  it('skips comment lines and the files that refuse the removed flags', () => {
    expect(rules('scripts/x.ts', ' * CAMSTACK_TOKEN was removed')).toEqual([])
    expect(rules('scripts/x.sh', '# --token was removed')).toEqual([])
    expect(rules('scripts/hub/hub.mjs', "argv.includes('--token')")).toEqual([])
  })
})
