/**
 * `camstack mcp` — the public MCP server (stdio), shipped inside the CLI.
 *
 *   npm i -g camstack
 *   claude mcp add camstack -- camstack mcp
 */
import { parseArgs } from 'node:util'
import { DEFAULT_TOOLSETS, parseToolsets, TOOLSET_NAMES } from '../mcp/toolsets.js'

export function mcpHelp(): string {
  return [
    'Usage: camstack mcp [options]',
    '       camstack mcp doctor [--json]',
    '       camstack mcp update <version> | --latest',
    '       camstack mcp rollback',
    '',
    'Runs the CamStack MCP server on stdio. Register it with your assistant:',
    '  claude mcp add camstack -- camstack mcp',
    '',
    'Options:',
    `  --toolsets <list>     Comma list of: ${TOOLSET_NAMES.join(', ')}`,
    `                        (default: ${DEFAULT_TOOLSETS.join(',')})`,
    '  -s, --server <host>   Hub to use instead of the cached login session',
    '      --token-file <p>  Read an explicit token from a file',
    '',
    'Diagnose: `camstack mcp doctor` checks, read-only, Node >= 24, the hub, its pinned CA,',
    'the session or token file, the token scope (admin or not) and the CLI version, each',
    'ok / fail / unknown with a fix hint. It never prints a token.',
    'No TTY (CI, a service): `camstack login <host> --token-file <path>` with a chmod 600 file.',
    'Update: `camstack mcp update <version>|--latest` (installer layout only) stages the version, runs',
    '`mcp doctor --json` on it, then switches the active one atomically; `camstack mcp rollback` undoes it.',
    'Your login sessions in ~/.camstack are never touched. Other installs get instructions.',
    'MCP clients such as OpenCode keep the old process: restart them after `camstack mcp` updates.',
    '',
    "Auth is the CLI's own: run `camstack login <host>` once in a terminal.",
    'The MCP never asks for or accepts a password. Every write is two-step:',
    'a preview with a one-shot token, then the same call with that token.',
  ].join('\n')
}

export async function runMcp(args: readonly string[], cliVersion: string): Promise<void> {
  if (args[0] === 'doctor') {
    const { runDoctorCommand } = await import('../mcp/doctor-command.js')
    process.exitCode = await runDoctorCommand(args.slice(1), cliVersion)
    return
  }
  if (args[0] === 'update' || args[0] === 'rollback') {
    process.exitCode = await runUpdateCommand(args)
    return
  }
  const parsed = parseArgs({
    args: [...args],
    options: {
      toolsets: { type: 'string' },
      server: { type: 'string', short: 's' },
      'token-file': { type: 'string' },
    },
    allowPositionals: false,
    strict: true,
  })
  const selection = parseToolsets(parsed.values.toolsets)
  if (!selection.ok) {
    process.stderr.write(`camstack mcp: ${selection.error}\n`)
    process.exitCode = 1
    return
  }
  // Loaded lazily: the SDK is not paid for by any other command.
  const { runPublicMcp } = await import('../mcp/server.js')
  await runPublicMcp({
    cliVersion,
    toolsets: selection.toolsets,
    ...(parsed.values.server ? { server: parsed.values.server } : {}),
    ...(parsed.values['token-file'] ? { tokenFile: parsed.values['token-file'] } : {}),
  })
}

async function runUpdateCommand(args: readonly string[]): Promise<number> {
  const { homedir } = await import('node:os')
  const { realpathSync } = await import('node:fs')
  const { runMcpRollback, runMcpUpdate } = await import('./mcp-update.js')
  const { runCommand } = await import('../mcp/ops-update-cli.js')
  const { latestOnNpm } = await import('../mcp/setup-tools.js')
  const entry = process.argv[1] ?? ''
  const deps = {
    entryPath: entry === '' ? entry : realpathSync(entry),
    env: process.env,
    home: homedir(),
    run: runCommand,
    latestVersion: async () =>
      (await latestOnNpm('camstack', (url, init) => fetch(url, init))).latest,
    print: (line: string) => console.log(line),
  }
  return args[0] === 'rollback' ? runMcpRollback(deps) : runMcpUpdate(args.slice(1), deps)
}
