/**
 * The WinSW the installer ships is the pinned one, checked at BUILD time — a
 * different binary here would be a different program running as SYSTEM.
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WINSW_SHA256, WINSW_URL, verifyWinsw } from '../../../scripts/winsw-bundle.mjs'
import {
  buildAgentServiceSpec,
  serviceResourcePaths,
} from '../../windows-service/agent-service-spec'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'winsw-'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('verifyWinsw', () => {
  it('pins a full sha256 of a versioned GitHub release asset', () => {
    expect(WINSW_SHA256).toMatch(/^[0-9a-f]{64}$/)
    expect(WINSW_URL).toMatch(
      /^https:\/\/github\.com\/winsw\/winsw\/releases\/download\/v\d+\.\d+\.\d+\//,
    )
  })

  it('accepts exactly the pinned bytes', () => {
    const file = path.join(tmp, 'winsw.exe')
    fs.writeFileSync(file, 'pretend this is WinSW')
    const digest = createHash('sha256').update('pretend this is WinSW').digest('hex')
    expect(() => verifyWinsw(file, digest)).not.toThrow()
  })

  it('refuses anything else', () => {
    const file = path.join(tmp, 'winsw.exe')
    fs.writeFileSync(file, 'a different program, run as SYSTEM')
    expect(() => verifyWinsw(file)).toThrow(/pinned checksum/)
  })
})

describe('agent service resources', () => {
  it('points at the shipped wrapper, the supervisor and the bundled Node, Windows-style', () => {
    expect(serviceResourcePaths('C:\\Program Files\\CamStack\\resources')).toEqual({
      winsw: 'C:\\Program Files\\CamStack\\resources\\service\\winsw.exe',
      supervisor: 'C:\\Program Files\\CamStack\\resources\\service\\service-supervisor.js',
      nodeExe: 'C:\\Program Files\\CamStack\\resources\\node\\node.exe',
    })
  })

  it('runs the starter from its own directory', () => {
    const spec = buildAgentServiceSpec({
      resourcesPath: 'C:\\R',
      starterJs: 'C:\\R\\node_modules\\@camstack\\server\\dist\\starter.js',
      env: { CAMSTACK_ROLE: 'agent' },
    })
    expect(spec.workingDir).toBe('C:\\R\\node_modules\\@camstack\\server\\dist')
    expect(spec.env).toEqual({ CAMSTACK_ROLE: 'agent' })
  })
})
