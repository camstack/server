/**
 * The service definition and the elevated installer script. The security
 * properties matter more than the syntax: nothing the elevated process runs may
 * come from a place an unprivileged local user can write.
 */
import { describe, expect, it } from 'vitest'
import {
  buildInstallScript,
  buildRemoveScript,
  elevatedInvocation,
  encodePowershell,
  psQuote,
  serviceLayout,
} from '../../windows-service/service-script'
import { buildWinswXml, xmlEscape, type AgentServiceSpec } from '../../windows-service/winsw-config'
import { buildNodeEnv } from '../../node-env'

const layout = serviceLayout('C:\\ProgramData')
const spec: AgentServiceSpec = {
  nodeExe: 'C:\\Program Files\\Cam&Stack\\resources\\node\\node.exe',
  supervisorJs: 'C:\\Program Files\\Cam&Stack\\resources\\service\\service-supervisor.js',
  starterJs:
    'C:\\Program Files\\Cam&Stack\\resources\\node_modules\\@camstack\\server\\dist\\starter.js',
  workingDir: 'C:\\Program Files\\Cam&Stack\\resources\\node_modules\\@camstack\\server\\dist',
  env: buildNodeEnv({
    role: 'agent',
    dataDir: "C:\\Users\\O'Brien\\AppData\\Roaming\\CamStack\\data",
    appVersion: '1.2.3',
    agent: { hubAddress: '192.0.2.10:4443', agentName: 'win-box', statusPort: 4444 },
    bundledAddonsDir: 'C:\\Program Files\\Cam&Stack\\resources\\node_modules\\@camstack',
    seedServerDir: null,
  }),
  logDir: layout.logDir,
}

describe('buildWinswXml', () => {
  const xml = buildWinswXml(spec)

  it('runs the bundled Node on the supervisor, handing it the starter', () => {
    expect(xml).toContain('<id>CamStackAgent</id>')
    expect(xml).toContain('node.exe</executable>')
    expect(xml).toContain(
      '<arguments>"C:\\Program Files\\Cam&amp;Stack\\resources\\service\\service-supervisor.js" "C:\\Program Files\\Cam&amp;Stack\\resources\\node_modules\\@camstack\\server\\dist\\starter.js"</arguments>',
    )
  })

  it('carries the SAME environment the Electron shell gives the child, escaped', () => {
    expect(xml).toContain('<env name="CAMSTACK_ROLE" value="agent"/>')
    expect(xml).toContain('<env name="CAMSTACK_HUB_ADDRESS" value="192.0.2.10:4443"/>')
    expect(xml).toContain(
      '<env name="CAMSTACK_DATA" value="C:\\Users\\O&apos;Brien\\AppData\\Roaming\\CamStack\\data"/>',
    )
    expect(xml).not.toMatch(/SECRET|TOKEN/i)
  })

  it('restarts on failure with a back-off and starts automatically, delayed', () => {
    expect(xml).toContain('<startmode>Automatic</startmode>')
    expect(xml).toContain('<delayedAutoStart>true</delayedAutoStart>')
    expect(xml.match(/<onfailure action="restart"/g)).toHaveLength(4)
  })

  it('escapes the five XML specials', () => {
    expect(xmlEscape(`<a href="x">&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;',
    )
  })
})

describe('buildInstallScript', () => {
  const winsw = 'C:\\Program Files\\CamStack\\resources\\service\\winsw.exe'
  const script = buildInstallScript({
    layout,
    winswSource: winsw,
    spec,
    agentConfigSource: 'C:\\Users\\alice\\AppData\\Roaming\\CamStack\\data\\agent.json',
  })

  it('locks the service directory to Administrators + SYSTEM BEFORE putting anything in it', () => {
    const lock = script.indexOf('/inheritance:r')
    const copy = script.indexOf('Copy-Item')
    const write = script.indexOf('WriteAllText')
    expect(lock).toBeGreaterThan(-1)
    expect(lock).toBeLessThan(copy)
    expect(lock).toBeLessThan(write)
    expect(script).toContain("'*S-1-5-32-544:(OI)(CI)F'")
    expect(script).toContain("'*S-1-5-18:(OI)(CI)F'")
  })

  it('also locks the service DATA dir (it holds the addons SYSTEM will run) and seeds only agent.json', () => {
    expect(layout.dataDir).toBe('C:\\ProgramData\\CamStack\\agent-data')
    expect(script.match(/\/inheritance:r/g)).toHaveLength(2)
    expect(script).toContain("-Destination 'C:\\ProgramData\\CamStack\\agent-data\\agent.json'")
    expect(script.indexOf("agent-data' /inheritance")).toBeLessThan(script.indexOf('Copy-Item'))
  })

  it('carries the XML INSIDE the script; the only user-owned file read while elevated is agent.json', () => {
    expect(script).toContain("$xml = @'")
    expect(script).toContain('<id>CamStackAgent</id>')
    const userOwned = (script.match(/-LiteralPath '[^']*'/g) ?? []).filter((p) =>
      /Temp|AppData/i.test(p),
    )
    // The Test-Path and Copy-Item of the config; nothing that is executed.
    expect(userOwned.length).toBeGreaterThan(0)
    expect(userOwned.every((p) => p.endsWith("agent.json'"))).toBe(true)
  })

  it('reinstalls over an existing service, then installs and starts, checking each step', () => {
    expect(script.indexOf('uninstall')).toBeLessThan(script.indexOf("camstack-agent.exe' install"))
    expect(script).toContain("& 'C:\\ProgramData\\CamStack\\service\\camstack-agent.exe' install")
    expect(script).toContain('start')
    expect(script).toContain('$LASTEXITCODE -ne 0')
  })

  it('logs the outcome where the unprivileged app can read it back', () => {
    expect(script).toContain("'C:\\ProgramData\\CamStack\\service-last-action.log'")
  })

  it('quotes an apostrophe in a path instead of breaking out of the literal', () => {
    expect(psQuote("C:\\Users\\O'Brien")).toBe("'C:\\Users\\O''Brien'")
  })
})

describe('buildRemoveScript', () => {
  it('stops and uninstalls the service and removes the wrapper', () => {
    const script = buildRemoveScript(layout)
    expect(script).toContain('stop')
    expect(script).toContain('uninstall')
    expect(script).toContain('Remove-Item')
  })
})

describe('elevatedInvocation', () => {
  const script = buildRemoveScript(layout)
  const [file, args] = elevatedInvocation(script, 'C:\\Windows')

  it('shows UAC (RunAs), waits, and returns the elevated exit code', () => {
    expect(file).toMatch(/System32.WindowsPowerShell.v1\.0.powershell\.exe$/)
    const command = args[args.length - 1] ?? ''
    expect(command).toContain('-Verb RunAs')
    expect(command).toContain('-Wait -PassThru')
    expect(command).toContain('exit $p.ExitCode')
  })

  it('passes the script as an encoded command, never as a file', () => {
    const command = args[args.length - 1] ?? ''
    expect(command).toContain(`'${encodePowershell(script)}'`)
    expect(command).not.toMatch(/-File\b/)
    expect(Buffer.from(encodePowershell(script), 'base64').toString('utf16le')).toBe(script)
  })

  it('stays well under the CreateProcess command-line limit for the install script', () => {
    const big = buildInstallScript({
      layout,
      winswSource: 'C:\\x\\winsw.exe',
      spec,
      agentConfigSource: null,
    })
    const [, bigArgs] = elevatedInvocation(big, undefined)
    expect(bigArgs.join(' ').length).toBeLessThan(30_000)
  })
})
