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
    "Auth is the CLI's own: run `camstack login <host>` once in a terminal.",
    'The MCP never asks for or accepts a password. Every write is two-step:',
    'a preview with a one-shot token, then the same call with that token.',
  ].join('\n')
}

export async function runMcp(args: readonly string[], cliVersion: string): Promise<void> {
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
