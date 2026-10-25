/**
 * The elevated PowerShell that installs / removes the agent service.
 *
 * Installing a service runs code as SYSTEM, so the only dangerous thing this
 * feature can do is let an unprivileged local user influence WHAT runs. Hence:
 *
 *  - the service directory (the WinSW copy and its XML) is created by the
 *    elevated script and locked to Administrators + SYSTEM BEFORE anything is
 *    put in it;
 *  - the XML travels INSIDE the script, and the script travels as an
 *    `-EncodedCommand` argument — not as a file in a user-writable temp dir an
 *    attacker could swap between "written" and "run elevated" (a TOCTOU that
 *    would be a local privilege escalation);
 *  - UAC shows the operator the elevation; declining it is just a failure.
 *
 * Pure: strings in, strings out. Nothing here runs PowerShell.
 */
import { buildWinswXml, type AgentServiceSpec, SERVICE_ID } from './winsw-config'

export const SERVICE_EXE_NAME = 'camstack-agent.exe'
export const SERVICE_XML_NAME = 'camstack-agent.xml'

/** Well-known SIDs: locale-independent, unlike the names "Administrators"/"SYSTEM". */
const SID_ADMINISTRATORS = '*S-1-5-32-544'
const SID_SYSTEM = '*S-1-5-18'

export interface ServiceLayout {
  /** `%ProgramData%\CamStack` — holds only the last-action log. */
  readonly rootDir: string
  /** `%ProgramData%\CamStack\service` — admin-only: WinSW exe, XML, logs. */
  readonly serviceDir: string
  /**
   * `%ProgramData%\CamStack\agent-data` — the service's data dir, admin-only.
   * It holds the addons the node runs, so a user must not be able to write it:
   * code in a user-writable directory executed as SYSTEM is a privilege
   * escalation. The user's own data dir is therefore never the service's.
   */
  readonly dataDir: string
  readonly exePath: string
  readonly xmlPath: string
  readonly logDir: string
  /** Written by the elevated script; read back to explain a failure. */
  readonly lastActionLog: string
}

export function serviceLayout(programData: string): ServiceLayout {
  const rootDir = `${programData}\\CamStack`
  const serviceDir = `${rootDir}\\service`
  return {
    rootDir,
    serviceDir,
    dataDir: `${rootDir}\\agent-data`,
    exePath: `${serviceDir}\\${SERVICE_EXE_NAME}`,
    xmlPath: `${serviceDir}\\${SERVICE_XML_NAME}`,
    logDir: `${serviceDir}\\logs`,
    lastActionLog: `${rootDir}\\service-last-action.log`,
  }
}

/** A PowerShell single-quoted string literal. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function lockDirectory(dir: string): string[] {
  return [
    `New-Item -ItemType Directory -Force -Path ${psQuote(dir)} | Out-Null`,
    `& icacls.exe ${psQuote(dir)} /inheritance:r /grant:r ${psQuote(`${SID_ADMINISTRATORS}:(OI)(CI)F`)} ${psQuote(`${SID_SYSTEM}:(OI)(CI)F`)} | Out-Null`,
    `if ($LASTEXITCODE -ne 0) { throw "could not lock ${dir.replace(/["$`]/g, '')} (icacls exit $LASTEXITCODE)" }`,
  ]
}

function wrapAction(layout: ServiceLayout, body: readonly string[]): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$log = ${psQuote(layout.lastActionLog)}`,
    'try {',
    `  New-Item -ItemType Directory -Force -Path ${psQuote(layout.rootDir)} | Out-Null`,
    ...body.map((line) => `  ${line}`),
    "  'ok' | Set-Content -LiteralPath $log",
    '} catch {',
    '  ($_ | Out-String) | Set-Content -LiteralPath $log',
    '  exit 1',
    '}',
  ].join('\r\n')
}

const STOP_AND_UNINSTALL_IF_PRESENT = (exe: string): string[] => [
  `if (Get-Service -Name ${psQuote(SERVICE_ID)} -ErrorAction SilentlyContinue) {`,
  `  & ${psQuote(exe)} stop | Out-Null`,
  `  & ${psQuote(exe)} uninstall | Out-Null`,
  '}',
]

function checked(command: string): string[] {
  return [
    command,
    'if ($LASTEXITCODE -ne 0) { throw "failed: ' +
      command.replace(/["$`]/g, '') +
      ' (exit $LASTEXITCODE)" }',
  ]
}

export interface InstallScriptInput {
  readonly layout: ServiceLayout
  /** The pinned WinSW binary shipped in the app's resources. */
  readonly winswSource: string
  readonly spec: AgentServiceSpec
  /**
   * The user's `agent.json` (hub address, mesh certificate, node id) to seed the
   * service's own data dir with. The elevated script copies it into the
   * admin-only directory; null starts the service unconfigured.
   */
  readonly agentConfigSource: string | null
}

export function buildInstallScript(input: InstallScriptInput): string {
  const { layout, winswSource, spec, agentConfigSource } = input
  const xml = buildWinswXml({ ...spec, logDir: layout.logDir })
  if (xml.includes("\r\n'@") || xml.includes("\n'@")) {
    throw new Error('service XML contains a here-string terminator')
  }
  return wrapAction(layout, [
    ...lockDirectory(layout.serviceDir),
    ...lockDirectory(layout.dataDir),
    ...(agentConfigSource === null
      ? []
      : [
          `if (Test-Path -LiteralPath ${psQuote(agentConfigSource)}) { Copy-Item -Force -LiteralPath ${psQuote(agentConfigSource)} -Destination ${psQuote(`${layout.dataDir}\\agent.json`)} }`,
        ]),
    ...STOP_AND_UNINSTALL_IF_PRESENT(layout.exePath),
    `Copy-Item -Force -LiteralPath ${psQuote(winswSource)} -Destination ${psQuote(layout.exePath)}`,
    `New-Item -ItemType Directory -Force -Path ${psQuote(layout.logDir)} | Out-Null`,
    `$xml = @'\r\n${xml}\r\n'@`,
    `[IO.File]::WriteAllText(${psQuote(layout.xmlPath)}, $xml, (New-Object Text.UTF8Encoding $false))`,
    ...checked(`& ${psQuote(layout.exePath)} install`),
    ...checked(`& ${psQuote(layout.exePath)} start`),
  ])
}

export function buildRemoveScript(layout: ServiceLayout): string {
  return wrapAction(layout, [
    `if (Test-Path -LiteralPath ${psQuote(layout.exePath)}) {`,
    ...STOP_AND_UNINSTALL_IF_PRESENT(layout.exePath).map((l) => `  ${l}`),
    `  Remove-Item -Force -LiteralPath ${psQuote(layout.exePath)}, ${psQuote(layout.xmlPath)} -ErrorAction SilentlyContinue`,
    '}',
  ])
}

export function encodePowershell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * The (non-elevated) command that shows the UAC prompt and runs `script`
 * elevated, waiting for it and passing its exit code through. Declining UAC
 * makes `Start-Process` throw, which is a non-zero exit like any other failure.
 */
export function elevatedInvocation(
  script: string,
  systemRoot: string | undefined,
): readonly [string, readonly string[]] {
  const powershell = `${systemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  const inner = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodePowershell(script),
  ]
  const argList = inner.map(psQuote).join(',')
  const command = `$p = Start-Process -FilePath ${psQuote(powershell)} -Verb RunAs -Wait -PassThru -ArgumentList ${argList}; exit $p.ExitCode`
  return [
    powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
  ]
}
