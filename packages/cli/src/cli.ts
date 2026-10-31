import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import * as os from 'node:os'
import { parseArgs, type ParseArgsConfig } from 'node:util'
import { runServe } from './commands/serve.js'
import { runAgent } from './commands/agent.js'
import { runSetup } from './commands/setup.js'
import { deployAddon } from './commands/deploy.js'
import { deployServer } from './commands/deploy-server.js'
import { resolveLoginServer } from './commands/login-server.js'
import {
  LEGACY_LOGIN_FLAG_OPTIONS,
  legacyLoginFlagWarnings,
} from './commands/login-legacy-flags.js'
import { loginCommand, logoutCommand, whoamiCommand } from './commands/auth.js'
import {
  loadSession,
  MissingCredentialsError,
  normalizeHubAddress,
  touchSession,
  resolveFreshCredentials,
  type ResolvedCredentials,
} from '@camstack/develop'
import { runDiscover } from './commands/discover.js'
import { runUpdate } from './commands/update.js'
import { runDev } from './commands/dev.js'
import { runWatch } from './commands/watch.js'
import { developHelp, runDevelop } from './commands/develop.js'
import { mcpHelp, runMcp } from './commands/mcp.js'
import { cliHubTransport } from './http/hub-transport.js'
import { maybeNotifyUpdate } from './update-notifier.js'

/**
 * Zero-dep CLI dispatcher.
 *
 * `commander` was dropped to keep `npx @camstack/cli` install-time at
 * zero transitive packages. `node:util.parseArgs` (Node ≥18.3) handles
 * per-subcommand flag parsing; sub-command routing + help/version is
 * hand-rolled below — every command file exposes a `runX(rawArgs)`
 * entry that owns its own parseArgs schema.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
let pkgVersion = '0.1.0'
try {
  const pkg = require(resolve(__dirname, '..', 'package.json')) as {
    version: string
  }
  pkgVersion = pkg.version
} catch {
  /* fallback */
}

/** Inline replacement for the deleted `@camstack/types` import. */
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}

interface CommandSpec {
  readonly name: string
  readonly aliases?: readonly string[]
  readonly summary: string
  readonly run: (args: readonly string[]) => Promise<void> | void
  readonly help: () => string
}

const HELP_FLAGS = new Set(['-h', '--help'])

function printGlobalHelp(commands: readonly CommandSpec[]): void {
  const lines: string[] = []
  lines.push(`camstack v${pkgVersion} — self-hosted camera platform`)
  lines.push('')
  lines.push('Usage: camstack <command> [options]')
  lines.push('')
  lines.push('Commands:')
  const widest = Math.max(...commands.map((c) => c.name.length))
  for (const cmd of commands) {
    const padded = cmd.name.padEnd(widest, ' ')
    const aliasNote =
      cmd.aliases && cmd.aliases.length > 0 ? ` (alias: ${cmd.aliases.join(', ')})` : ''
    lines.push(`  ${padded}  ${cmd.summary}${aliasNote}`)
  }
  lines.push('')
  lines.push('Global flags:')
  lines.push('  -v, --version    Print version')
  lines.push('  -h, --help       Show this help, or per-command help with `camstack <cmd> --help`')
  console.log(lines.join('\n'))
}

/** Shared by every hub-talking command's help: where the token comes from. */
const TOKEN_RESOLUTION_HELP = [
  'Token resolution (first hit wins): --token, --token-file, $CAMSTACK_TOKEN,',
  '  then the session cached by `camstack login` for the target server.',
].join('\n')

function buildCommands(): readonly CommandSpec[] {
  return [
    {
      name: 'serve',
      summary: 'Start CamStack in hub mode',
      run: runServe,
      help: () =>
        [
          'Usage: camstack serve [options]',
          '',
          'Options:',
          '  -p, --port <port>      Port to listen on',
          '  -d, --data <path>      Data directory path',
        ].join('\n'),
    },
    {
      name: 'agent',
      summary: 'Start CamStack in agent mode (worker node)',
      run: runAgent,
      help: () =>
        [
          'Usage: camstack agent [options]',
          '',
          'Required:',
          '  --hub <ip>             Hub server IP address',
          '  --token <token>        Authentication token',
          '',
          'Optional:',
          '  --name <name>          Agent name (default: hostname-arch)',
          '  --port <port>          Hub port (default: 4443)',
        ].join('\n'),
    },
    {
      name: 'setup',
      summary: 'Check dependencies and create default config',
      run: runSetup,
      help: () =>
        [
          'Usage: camstack setup [options]',
          '',
          'Options:',
          '  -d, --data <path>      Data directory path',
        ].join('\n'),
    },
    {
      name: 'login',
      summary: 'Authenticate and cache your login session at ~/.camstack/<host>.json',
      run: runLogin,
      help: () =>
        [
          'Usage: camstack login [<host>] [options]',
          '',
          '  <host>                 The hub, same as --server: 192.0.2.20, hub.local:4443,',
          '                         https://hub.local, [fe80::1]:4443. Port defaults to 4443, scheme is',
          '                         https (http:// is refused). Example: camstack login 192.0.2.20',
          '',
          'Default flow (no flags): finds the hub from what the LAN announces over mDNS',
          '  plus the hubs this machine knows (saved sessions, $CAMSTACK_HUB_URL),',
          '  then prompts for user + password. Found hubs show a picker (the first, the default, is',
          '  one Enter away) with the source of each and an "Enter an address…" entry, so a hub',
          '  that does not announce is still reachable. A given <host>/--server skips all of it.',
          '',
          'Options (all optional):',
          '  -s, --server <host>    Skip discovery, use this hub ($CAMSTACK_SERVER, then $CAMSTACK_HUB_URL)',
          '  -n, --namespace <ns>   Ignored (kept so old scripts do not fail): hubs are found over mDNS',
          '  -u, --username <name>  Username (skips prompt)',
          '  -p, --password <pwd>   Password (skips prompt — prefer letting the CLI prompt)',
          `  --token-name <name>    Ignored (kept for scripts); login uses your hub session JWT`,
        ].join('\n'),
    },
    {
      name: 'discover',
      summary: 'List the camstack hubs on the LAN (mDNS) and the ones this machine knows',
      run: runDiscover,
      help: () =>
        [
          'Usage: camstack discover [options]',
          '',
          'Lists the hubs `camstack login` would offer: those announcing _camstack._tcp over',
          '  mDNS plus saved sessions, $CAMSTACK_HUB_URL and scratchpad/.hub-url,',
          '  reachable ones only, each with its source. Agents never announce this service.',
          '',
          'Options:',
          '  -t, --timeout <seconds>   mDNS listen window (default: 3)',
          '  -n, --namespace <ns>      Ignored (the namespace belonged to the retired mesh channel)',
          '  --json                    Emit JSON instead of human-readable list',
        ].join('\n'),
    },
    {
      name: 'logout',
      summary: 'Revoke the cached scoped token and drop the local session file',
      run: runLogout,
      help: () =>
        [
          'Usage: camstack logout [options]',
          '',
          'Options:',
          '  -s, --server <host>     CamStack server URL (default: $CAMSTACK_SERVER or https://localhost:4443; a bare host or host:port is fine)',
        ].join('\n'),
    },
    {
      name: 'whoami',
      summary: 'Print the active cached session (server + username + scopes)',
      run: runWhoami,
      help: () =>
        [
          'Usage: camstack whoami [options]',
          '',
          'With one saved session, prints it and checks the token against the hub. With several and',
          'no --server, lists them all (server, user, admin role) and marks the default:',
          '$CAMSTACK_SERVER if set, else the most recently used session.',
          '',
          'Options:',
          '  -s, --server <host>    Show one session (192.0.2.20, hub.local:4443, https://host)',
        ].join('\n'),
    },
    {
      name: 'deploy',
      aliases: ['push'],
      summary:
        'Deploy an addon, or (with --closure) the @camstack/server workspace closure on the dev channel',
      run: runDeploy,
      help: () =>
        [
          'Usage: camstack deploy [options] [path]',
          '       camstack push   [options] [path]    (alias)',
          '       camstack deploy --closure [options]  (server closure, no addon path)',
          '',
          'Argument:',
          '  path                    Path to addon dir, .tgz, or workspace name (e.g. "tailscale")',
          '                          Default: "." (current dir). Ignored with --closure.',
          '',
          'Server closure (dev channel, no npm publish):',
          '      --closure           Build+pack+upload @camstack/server closure, then apply',
          '      --version <ver>     With --closure: reuse hub upload <base>-dev.<epoch>',
          '                          (skip build/pack/upload; propagate+apply only)',
          '',
          'Build (addon path only):',
          '  -b, --build <mode>      `auto` (default — run build if declared),',
          '                          `force` (require + run), or `skip`',
          '      --no-build          Equivalent to --build skip',
          '      --build-script <n>  npm script name (default: build)',
          '      --no-verify         Skip post-deploy verify / promotion poll',
          '',
          'Target options (addon and --closure):',
          '  -s, --server <host>      Hub URL (default: $CAMSTACK_SERVER, then the cached session)',
          '  -t, --token <token>     Auth token override',
          '      --token-file <path> Read the token from a file (bare token or a ~/.camstack session file)',
          '  -n, --node <id>         Target one agent. Mutually exclusive with --cluster',
          '  -c, --cluster           Every online agent (and hub for addons; hub then agents for --closure)',
          '',
          'Note: -s/--server is the hub URL. Use --closure for the server package.',
          '',
          TOKEN_RESOLUTION_HELP,
        ].join('\n'),
    },
    {
      name: 'deploy-server',
      summary: 'Alias of `camstack deploy --closure` (dev server-deploy channel)',
      run: runDeployServer,
      help: () =>
        [
          'Usage: camstack deploy-server [options]',
          '',
          'Deprecated alias of `camstack deploy --closure`. Prefer that form.',
          '',
          'Options:',
          '  -s, --server <host>     Hub URL',
          '  -t, --token <token>    Auth token override',
          '      --token-file <path> Read the token from a file',
          '  -n, --node <id>        Propagate+apply on this agent. Mutually exclusive with --cluster/--all',
          '  -c, --cluster          Propagate+apply on every online agent',
          '      --all              Legacy alias of --cluster',
          '      --version <ver>    Reuse hub upload (skip build/pack/upload)',
          '      --no-verify        Do not wait for promotion',
          '',
          TOKEN_RESOLUTION_HELP,
        ].join('\n'),
    },
    {
      name: 'watch',
      summary: 'Deploy + tail server-side addon logs (polling /trpc/addons.getLogs)',
      run: runWatch,
      help: () =>
        [
          'Usage: camstack watch [options] [path]',
          '',
          'Argument:',
          '  path                       Addon dir / workspace name / `.` for 5-level scan',
          '',
          'Options:',
          '  -s, --server <host>         Server URL (default: cached session)',
          '  -t, --token <token>        Auth token override',
          '      --token-file <path>    Read the token from a file',
          '  -n, --node <id>            Push to a specific node',
          '  -c, --cluster              Push to hub + every online agent',
          '      --no-build             Skip `npm run build`',
          '      --build-script <n>     Override script name (default: build)',
          '  -l, --level <lvl>          Filter logs by level (debug/info/warn/error)',
          '      --no-initial-deploy    Skip initial deploy — only tail existing addon',
          '',
          'Each round polls the last 100 entries; new entries (by timestamp+content)',
          'are printed. Ctrl-C to stop.',
          '',
          TOKEN_RESOLUTION_HELP,
        ].join('\n'),
    },
    {
      name: 'dev',
      summary: 'Watch addon source + auto build & redeploy on every change (live-reload loop)',
      run: runDev,
      help: () =>
        [
          'Usage: camstack dev [options] [path]',
          '',
          'Argument:',
          '  path                      Addon directory (or workspace name). Default: "."',
          '',
          'Watch options:',
          '  -w, --watch-path <dir>    Subpath to watch (default: <addon>/src if it exists, else addon root)',
          '      --debounce <ms>       Coalesce bursts of changes (default: 500)',
          '      --no-initial-push     Skip the first push, only react to changes',
          '',
          'Build options:',
          '      --no-build            Skip `npm run build` (just pack + upload)',
          '      --build-script <n>    Override script name (default: build)',
          '',
          'Target options:',
          '  -s, --server <host>        Server URL (default: cached session)',
          '  -t, --token <token>       Auth token override',
          '      --token-file <path>   Read the token from a file',
          '  -n, --node <id>           Push to a specific node',
          '  -c, --cluster             Push to hub + every online agent',
          '',
          'Stop with Ctrl-C. Each cycle is sequential — concurrent changes during',
          'a push are coalesced into the next cycle.',
          '',
          TOKEN_RESOLUTION_HELP,
        ].join('\n'),
    },
    {
      name: 'develop',
      aliases: ['addon'],
      summary:
        'Authoring tools — catalogue, scaffold, validate, find-example, skills (same ops as MCP)',
      run: runDevelop,
      help: developHelp,
    },
    {
      name: 'mcp',
      summary: 'MCP server (stdio) — setup, ops, configure, develop toolsets',
      run: (args) => runMcp(args, pkgVersion),
      help: mcpHelp,
    },
    {
      name: 'update',
      aliases: ['upgrade'],
      summary: 'Self-upgrade — runs `npm install -g camstack@latest`',
      run: runUpdate,
      help: () =>
        [
          'Usage: camstack update [options]',
          '       camstack upgrade [options]    (alias)',
          '',
          'With no flags: fetches the latest version from npm, confirms,',
          '  then runs `npm install -g camstack@<latest>`.',
          '',
          'Options:',
          '  -V, --version <x.y.z>  Install a specific version (pin/downgrade)',
          '  -y, --yes              Skip confirmation (useful for scripts)',
        ].join('\n'),
    },
    {
      name: 'info',
      summary: 'Print detailed version and platform info',
      run: () => {
        console.log(`camstack v${pkgVersion}`)
        console.log(`Platform: ${os.platform()}-${os.arch()}`)
        console.log(`Node.js: ${process.version}`)
        console.log(`CPU: ${os.cpus()[0]?.model ?? 'unknown'} (${os.cpus().length} cores)`)
        console.log(`Memory: ${Math.round(os.totalmem() / 1024 / 1024)} MB`)
      },
      help: () => 'Usage: camstack info',
    },
  ]
}

/**
 * Wrap parseArgs so the subcommand-help convention (`camstack X --help`)
 * intercepts BEFORE parseArgs throws on unknown flags. Returns either the
 * parsed values + positionals, or `null` if help was requested (caller
 * prints the per-command help and exits).
 */
function parseSubcommandArgs(
  args: readonly string[],
  options: ParseArgsConfig['options'],
  allowPositionals: boolean,
): {
  values: Record<string, string | boolean | undefined>
  positionals: readonly string[]
} | null {
  if (args.some((a) => HELP_FLAGS.has(a))) return null
  const parsed = parseArgs({
    args: [...args],
    options,
    allowPositionals,
    strict: true,
  })
  return {
    values: parsed.values as Record<string, string | boolean | undefined>,
    positionals: parsed.positionals,
  }
}

async function runLogin(args: readonly string[]): Promise<void> {
  const parsed = parseSubcommandArgs(
    args,
    {
      server: { type: 'string', short: 's' },
      namespace: { type: 'string', short: 'n' },
      username: { type: 'string', short: 'u' },
      password: { type: 'string', short: 'p' },
      'token-name': { type: 'string' },
      // Removed (D895), still parsed so an old script does not abort: each one
      // present prints a one-line warning and the login goes on.
      ...LEGACY_LOGIN_FLAG_OPTIONS,
      // Accepted-and-ignored: `--no-verify` is a `deploy`-only flag (skip the
      // post-deploy health gate). Login has no verify step, but operators
      // muscle-memory it in — we swallow it here so `camstack login --no-verify`
      // never errors with "Unknown option --no-verify".
      'no-verify': { type: 'boolean' },
    },
    true,
  )
  if (!parsed) {
    console.log(commandHelp('login'))
    return
  }
  const explicitServer = resolveLoginServer(
    stringOpt(parsed.values, 'server'),
    parsed.positionals,
    process.env,
  )
  if (stringOpt(parsed.values, 'namespace') !== undefined) {
    console.warn('--namespace is ignored: hubs are found over mDNS, not the mesh channel.')
  }
  for (const warning of legacyLoginFlagWarnings(parsed.values)) console.warn(warning)
  // Resolution chain:
  //   --server / $CAMSTACK_SERVER   → silent, use as-is
  //   neither                       → mDNS + known hubs; one is taken, several get a picker
  // We never auto-fallback to localhost.
  await loginCommand({
    ...(explicitServer ? { server: explicitServer } : {}),
    ...optionalString(parsed.values, 'username'),
    ...optionalString(parsed.values, 'password'),
    ...optionalString(parsed.values, 'token-name', 'tokenName'),
  })
}

async function runLogout(args: readonly string[]): Promise<void> {
  const parsed = parseSubcommandArgs(
    args,
    {
      server: { type: 'string', short: 's' },
    },
    false,
  )
  if (!parsed) {
    console.log(commandHelp('logout'))
    return
  }
  const server = normalizeHubAddress(
    stringOpt(parsed.values, 'server') ?? process.env.CAMSTACK_SERVER ?? DEFAULT_SERVER_URL,
  )
  await logoutCommand({ server })
}

async function runWhoami(args: readonly string[]): Promise<void> {
  const parsed = parseSubcommandArgs(
    args,
    {
      server: { type: 'string', short: 's' },
    },
    false,
  )
  if (!parsed) {
    console.log(commandHelp('whoami'))
    return
  }
  const server = stringOpt(parsed.values, 'server')
  await whoamiCommand(server ? { server: normalizeHubAddress(server) } : {})
}

async function resolveClosureDeployOpts(
  values: Record<string, string | boolean | undefined>,
): Promise<Parameters<typeof deployServer>[0]> {
  const nodeId = stringOpt(values, 'node')
  const cluster = boolOpt(values, 'cluster') || boolOpt(values, 'all')
  if (cluster && nodeId) {
    console.error('[camstack] Error: --node and --cluster/--all are mutually exclusive.')
    process.exit(1)
  }
  const version = stringOpt(values, 'version')
  const creds = await resolveCommandCredentials(values)
  return {
    serverUrl: creds.server ?? DEFAULT_SERVER_URL,
    token: creds.token,
    authSource: creds.source,
    verify: !boolOpt(values, 'no-verify'),
    ...(nodeId ? { nodeIds: [nodeId] } : {}),
    ...(cluster ? { allAgents: true } : {}),
    ...(version ? { existingVersion: version } : {}),
  }
}

async function runDeploy(args: readonly string[]): Promise<void> {
  const parsed = parseSubcommandArgs(
    args,
    {
      server: { type: 'string', short: 's' },
      token: { type: 'string', short: 't' },
      'token-file': { type: 'string' },
      node: { type: 'string', short: 'n' },
      cluster: { type: 'boolean', short: 'c' },
      closure: { type: 'boolean' },
      version: { type: 'string' },
      build: { type: 'string', short: 'b' },
      'build-script': { type: 'string' },
      'no-build': { type: 'boolean' },
      'no-verify': { type: 'boolean' },
    },
    true,
  )
  if (!parsed) {
    console.log(commandHelp('deploy'))
    return
  }

  if (boolOpt(parsed.values, 'closure')) {
    if (stringOpt(parsed.values, 'build') || boolOpt(parsed.values, 'no-build')) {
      console.error('[camstack] Error: --closure does not take addon --build / --no-build flags.')
      process.exit(1)
    }
    await deployServer(await resolveClosureDeployOpts(parsed.values))
    return
  }

  if (stringOpt(parsed.values, 'version')) {
    console.error('[camstack] Error: --version requires --closure (server closure reuse).')
    process.exit(1)
  }

  const addonPath = parsed.positionals[0] ?? '.'
  const creds = await resolveCommandCredentials(parsed.values)
  const server = creds.server ?? DEFAULT_SERVER_URL
  const token = creds.token
  const nodeId = stringOpt(parsed.values, 'node')
  const cluster = boolOpt(parsed.values, 'cluster')
  if (nodeId && cluster) {
    console.error('[camstack] Error: --node and --cluster are mutually exclusive.')
    process.exit(1)
  }
  // Build mode: `--no-build` wins; `--build <mode>` next; else auto.
  const buildFlag = stringOpt(parsed.values, 'build')
  const noBuild = boolOpt(parsed.values, 'no-build')
  let buildMode: 'auto' | 'force' | 'skip' = 'auto'
  if (noBuild) buildMode = 'skip'
  else if (buildFlag === 'force' || buildFlag === 'skip' || buildFlag === 'auto')
    buildMode = buildFlag
  else if (buildFlag) {
    console.error(`[camstack] Error: --build must be one of: auto, force, skip (got: ${buildFlag})`)
    process.exit(1)
  }
  const buildScript = stringOpt(parsed.values, 'build-script')
  const noVerify = boolOpt(parsed.values, 'no-verify')
  await deployAddon(addonPath, {
    serverUrl: server,
    token,
    authSource: creds.source,
    ...(nodeId ? { nodeId } : {}),
    ...(cluster ? { cluster: true } : {}),
    buildMode,
    ...(buildScript ? { buildScript } : {}),
    verify: !noVerify,
  })
}

async function runDeployServer(args: readonly string[]): Promise<void> {
  const parsed = parseSubcommandArgs(
    args,
    {
      server: { type: 'string', short: 's' },
      token: { type: 'string', short: 't' },
      'token-file': { type: 'string' },
      node: { type: 'string', short: 'n' },
      cluster: { type: 'boolean', short: 'c' },
      all: { type: 'boolean' },
      version: { type: 'string' },
      'no-verify': { type: 'boolean' },
    },
    false,
  )
  if (!parsed) {
    console.log(commandHelp('deploy-server'))
    return
  }
  console.log('[camstack] note: `deploy-server` is an alias of `deploy --closure`')
  await deployServer(await resolveClosureDeployOpts(parsed.values))
}

const DEFAULT_SERVER_URL = 'https://localhost:4443'

/**
 * `--token` / `--token-file` / $CAMSTACK_TOKEN / cached session → credentials
 * (see `commands/credentials.ts`). A missing token exits 1 with the
 * "run `camstack login`" guidance instead of a stack-ish failure line.
 */
async function resolveCommandCredentials(
  values: Record<string, string | boolean | undefined>,
): Promise<ResolvedCredentials> {
  const server = stringOpt(values, 'server')
  const token = stringOpt(values, 'token')
  const tokenFile = stringOpt(values, 'token-file')
  try {
    const creds = await resolveFreshCredentials({
      ...(server ? { server } : {}),
      ...(token ? { token } : {}),
      ...(tokenFile ? { tokenFile } : {}),
      loadSession,
      transport: cliHubTransport,
    })
    if (creds.warning) console.error(`[camstack] Warning: ${creds.warning}`)
    if (creds.source === 'session' && creds.server) touchSession(creds.server)
    return creds
  } catch (err) {
    if (err instanceof MissingCredentialsError) {
      console.error(`[camstack] ${err.message}`)
      process.exit(1)
    }
    throw err
  }
}

/** Lookup a command's help() text by name — used when --help is in mid-argv. */
function commandHelp(name: string): string {
  const cmd = buildCommands().find((c) => c.name === name)
  return cmd ? cmd.help() : ''
}

function stringOpt(
  values: Record<string, string | boolean | undefined>,
  key: string,
): string | undefined {
  const v = values[key]
  return typeof v === 'string' ? v : undefined
}

function boolOpt(values: Record<string, string | boolean | undefined>, key: string): boolean {
  return values[key] === true
}

function optionalString(
  values: Record<string, string | boolean | undefined>,
  key: string,
  outKey?: string,
): Record<string, string> {
  const v = values[key]
  if (typeof v !== 'string') return {}
  return { [outKey ?? key]: v }
}

async function main(): Promise<void> {
  // TLS note: camstack hubs ship a self-signed cert on the LAN. Verification is
  // never switched off: hub calls go through `src/http/hub-http.ts`, which
  // trusts only the CA pinned for that hub (`~/.camstack/<host>_<port>.ca.pem`).

  // Fire-and-forget update check. Reads cached state synchronously to
  // surface a banner instantly if we already know about a newer release;
  // refreshes the cache in background for next time. Never blocks.
  maybeNotifyUpdate('camstack', pkgVersion)

  const argv = process.argv.slice(2)
  const commands = buildCommands()

  if (argv.length === 0 || (argv.length === 1 && HELP_FLAGS.has(argv[0] ?? ''))) {
    printGlobalHelp(commands)
    return
  }
  if (argv[0] === '-v' || argv[0] === '--version') {
    console.log(pkgVersion)
    return
  }

  const cmdName = argv[0] ?? ''
  const cmd = commands.find((c) => c.name === cmdName || (c.aliases?.includes(cmdName) ?? false))
  if (!cmd) {
    console.error(`[camstack] Unknown command: ${cmdName}`)
    console.error('Run `camstack --help` for the list of commands.')
    process.exit(1)
  }

  const subArgs = argv.slice(1)
  // Intercept `<cmd> --help` here so sub-commands don't have to special-case
  // it inside their parseArgs schemas (which would otherwise reject the flag).
  if (subArgs.some((a) => HELP_FLAGS.has(a))) {
    console.log(cmd.help())
    return
  }

  try {
    await cmd.run(subArgs)
  } catch (err) {
    console.error(`[camstack] ${cmd.name} failed:`, errMsg(err))
    process.exit(1)
  }
}

void main()
