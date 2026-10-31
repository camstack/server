import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConnectOutcome } from '@camstack/develop'
import {
  doctorExitCode,
  formatDoctor,
  runDoctorChecks,
  type DoctorCheck,
  type DoctorDeps,
} from '../mcp/doctor.js'

const TOKEN = 'tok-never-printed'
let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

function connected(tier: 'admin' | 'protected'): ConnectOutcome {
  return {
    ok: true,
    connection: {
      server: 'https://hub.example.test:4443',
      token: TOKEN,
      tier,
      source: 'session',
      tls: {},
      client: { call: async () => null },
      adminHint: tier === 'admin' ? null : 'log in as admin',
      loginCommand: 'camstack login',
    },
  }
}

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    cliVersion: '1.0.0',
    nodeVersion: 'v24.1.0',
    connect: async () => connected('admin'),
    probeHub: async () => ({ reachable: true }),
    fetch: async () => new Response(JSON.stringify({ version: '1.0.0' })),
    env: {},
    sessionDir: dir,
    ...over,
  }
}

const byId = (checks: readonly DoctorCheck[], id: DoctorCheck['id']): DoctorCheck => {
  const found = checks.find((c) => c.id === id)
  if (!found) throw new Error(`no check ${id}`)
  return found
}

describe('camstack mcp doctor', () => {
  it('reports every check and passes when all is well', async () => {
    const checks = await runDoctorChecks(deps())
    expect(checks.map((c) => c.id)).toEqual(['node', 'hub', 'ca', 'session', 'scope', 'version'])
    expect(byId(checks, 'node').status).toBe('ok')
    expect(byId(checks, 'hub').status).toBe('ok')
    expect(byId(checks, 'scope').detail).toBe('admin')
    expect(byId(checks, 'version').status).toBe('ok')
    expect(doctorExitCode(checks)).toBe(0)
  })

  it('fails Node older than 24 and says so', async () => {
    const node = byId(await runDoctorChecks(deps({ nodeVersion: 'v22.5.0' })), 'node')
    expect(node.status).toBe('fail')
    expect(node.detail).toContain('older than the required 24')
    expect(node.fix).toBeTruthy()
  })

  it('an unreachable hub fails; the pinned CA is ok only with a pin file', async () => {
    const down = deps({ probeHub: async () => ({ reachable: false, error: 'ECONNREFUSED' }) })
    expect(byId(await runDoctorChecks(down), 'hub').status).toBe('fail')
    fs.writeFileSync(path.join(dir, 'hub.example.test_4443.ca.pem'), 'PEM')
    expect(byId(await runDoctorChecks(deps()), 'ca').status).toBe('ok')
  })

  it('a TLS failure without a pin fails the CA check with the pin path', async () => {
    const tlsErr = Object.assign(new Error('self signed'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
    const checks = await runDoctorChecks(
      deps({ probeHub: async () => ({ reachable: false, error: 'self signed', cause: tlsErr }) }),
    )
    const ca = byId(checks, 'ca')
    expect(ca.status).toBe('fail')
    expect(ca.fix).toContain('hub.example.test_4443.ca.pem')
  })

  it('no session fails the session check and leaves the dependent ones unknown', async () => {
    const checks = await runDoctorChecks(
      deps({
        connect: async () => ({
          ok: false,
          reason: 'no-session',
          message: 'none',
          action: 'run camstack login',
        }),
      }),
    )
    expect(byId(checks, 'session').status).toBe('fail')
    expect(byId(checks, 'hub').status).toBe('unknown')
    expect(byId(checks, 'scope').status).toBe('unknown')
  })

  it('a non-admin token is reported as such, an old CLI as a failure, an unreadable registry as unknown', async () => {
    expect(
      byId(await runDoctorChecks(deps({ connect: async () => connected('protected') })), 'scope')
        .detail,
    ).toContain('not admin')
    const old = deps({ cliVersion: '0.9.0' })
    expect(byId(await runDoctorChecks(old), 'version').status).toBe('fail')
    const offline = deps({
      fetch: async () => {
        throw new Error('offline')
      },
    })
    expect(byId(await runDoctorChecks(offline), 'version').status).toBe('unknown')
  })

  it('never prints a token value', async () => {
    const out = formatDoctor(await runDoctorChecks(deps()))
    expect(out).not.toContain(TOKEN)
    expect(out).toContain('[ok     ] Node.js version')
  })
})
