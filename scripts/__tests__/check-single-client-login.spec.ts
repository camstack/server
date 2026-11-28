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

  it('leaves the agent join token alone, only where it is marked', () => {
    const line = 'HUB_TOKEN="$CAMSTACK_HUB_TOKEN" dominevo agent --token "$HUB_TOKEN"'
    const marked = `${line}  # agent-join:line`
    expect(rules('scripts/dev-cluster.sh', marked)).toEqual([])
    expect(rules('scripts/dev-agent-only.sh', marked)).toEqual([])
    expect(rules('packages/cli/src/commands/agent.ts', `${line} // agent-join:line`)).toEqual([])
    const region = ['# agent-join:begin', line, '# agent-join:end'].join('\n')
    expect(rules('scripts/dev-agent-only.sh', region)).toEqual([])
    // the marker means nothing in a file that is not an agent join file
    expect(rules('scripts/other.sh', marked)).toContain('env-token')
  })

  it('a client command in an agent file that regains a token still fails', () => {
    const agentUsage = "'  --token <token>        Authentication token', // agent-join:line"
    expect(rules('packages/cli/src/main.ts', agentUsage)).toEqual([])
    expect(rules('packages/cli/src/main.ts', "'  --token <token>   deploy token',")).toContain(
      'token-option',
    )
    expect(rules('packages/cli/src/main.ts', "process.env['CAMSTACK_TOKEN']")).toContain(
      'env-token',
    )
    // the region closes: a line after `agent-join:end` is a client line again
    const after = [
      '// agent-join:begin',
      "'--token <t>'",
      '// agent-join:end',
      "'--token <t>'",
    ].join('\n')
    expect(rules('packages/cli/src/main.ts', after)).toHaveLength(1)
    expect(
      rules('scripts/dev-cluster.sh', 'curl -H "Authorization: Bearer $CAMSTACK_TOKEN"'),
    ).toContain('env-token')
  })

  it('skips comment lines and the files that refuse the removed flags', () => {
    expect(rules('scripts/x.ts', ' * CAMSTACK_TOKEN was removed')).toEqual([])
    expect(rules('scripts/x.sh', '# --token was removed')).toEqual([])
  })

  it('hub.mjs and deploy-addon.sh may name a removed flag only inside the refusal', () => {
    const refusal = [
      '// removed-flag:begin',
      "if (argv.includes('--token')) {",
      '}',
      '// removed-flag:end',
    ]
    expect(rules('scripts/hub/hub.mjs', refusal.join('\n'))).toEqual([])
    expect(rules('scripts/hub/hub.mjs', "x = argv.includes('--token')")).toContain('token-option')
    const after = [...refusal, "argv.includes('--token')"].join('\n')
    expect(rules('scripts/hub/hub.mjs', after)).toContain('token-option')
    expect(rules('scripts/deploy-addon.sh', '--token) # removed-flag:begin')).toEqual([])
    expect(rules('scripts/deploy-addon.sh', 'curl --token "$T"')).toContain('token-option')
    // the marker means nothing in another file
    const other = "// removed-flag:line\nargv.includes('--token')"
    expect(rules('scripts/other.mjs', other)).toContain('token-option')
  })
})
