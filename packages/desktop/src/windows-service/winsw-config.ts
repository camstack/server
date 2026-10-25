/**
 * The WinSW service definition for the desktop AGENT (D846).
 *
 * WinSW wraps a console program as a real Windows service: it answers the
 * Service Control Manager, runs the wrapped process, restarts it when it fails,
 * and rotates its log. The wrapped program here is the bundled real Node
 * running the shared starter under a small supervisor (`supervisor.ts`) —
 * exactly what the Electron shell would spawn as a child, with the same
 * environment (`buildNodeEnv`), minus the window.
 *
 * Pure: a spec in, XML text out.
 */

export const SERVICE_ID = 'CamStackAgent'
export const SERVICE_DISPLAY_NAME = 'CamStack Agent'

export interface AgentServiceSpec {
  /** `<resources>\node\node.exe` — the bundled real Node. */
  readonly nodeExe: string
  /**
   * The supervisor script (`<resources>/service/service-supervisor.js`, outside
   * the asar): relaunches the starter on ANY exit, which WinSW alone does not.
   */
  readonly supervisorJs: string
  /** The shared starter (`@camstack/server/dist/starter.js`). */
  readonly starterJs: string
  /** Working directory of the node (the starter's own dir). */
  readonly workingDir: string
  /** The environment `buildNodeEnv` produced. */
  readonly env: Readonly<Record<string, string>>
  /** Where WinSW writes (and rotates) the service's stdout/stderr. */
  readonly logDir: string
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Restart policy: three quick retries, then a slow one forever — a node that
 * cannot start (hub unreachable, bad config) must not spin the CPU, and must
 * not give up either. The failure counter resets after an hour of uptime.
 */
const ON_FAILURE = [
  '<onfailure action="restart" delay="10 sec"/>',
  '<onfailure action="restart" delay="30 sec"/>',
  '<onfailure action="restart" delay="60 sec"/>',
  '<onfailure action="restart" delay="5 min"/>',
]

export function buildWinswXml(spec: AgentServiceSpec): string {
  const envLines = Object.entries(spec.env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `  <env name="${xmlEscape(name)}" value="${xmlEscape(value)}"/>`)
  return [
    '<service>',
    `  <id>${SERVICE_ID}</id>`,
    `  <name>${SERVICE_DISPLAY_NAME}</name>`,
    '  <description>CamStack agent node: runs detection and media work for a CamStack hub.</description>',
    `  <executable>${xmlEscape(spec.nodeExe)}</executable>`,
    `  <arguments>"${xmlEscape(spec.supervisorJs)}" "${xmlEscape(spec.starterJs)}"</arguments>`,
    `  <workingdirectory>${xmlEscape(spec.workingDir)}</workingdirectory>`,
    ...envLines,
    '  <startmode>Automatic</startmode>',
    '  <delayedAutoStart>true</delayedAutoStart>',
    '  <stoptimeout>20 sec</stoptimeout>',
    ...ON_FAILURE.map((line) => `  ${line}`),
    '  <resetfailure>1 hour</resetfailure>',
    `  <logpath>${xmlEscape(spec.logDir)}</logpath>`,
    '  <log mode="roll-by-size">',
    '    <sizeThreshold>10240</sizeThreshold>',
    '    <keepFiles>5</keepFiles>',
    '  </log>',
    '</service>',
    '',
  ].join('\n')
}
