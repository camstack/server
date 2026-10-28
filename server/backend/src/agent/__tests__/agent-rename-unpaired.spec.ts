/**
 * An unpaired agent renames itself locally (D857): the name lands in agent.json whatever the hub or
 * the broker say, and the request answers success.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ServiceBroker } from 'moleculer'
import { afterAll, describe, expect, it } from 'vitest'
import { defaultAgentName } from '../agent-config.js'
import { createAgentHttpServer } from '../agent-http.js'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

function brokerThatCannotRename(): ServiceBroker {
  return {
    nodeID: 'test-agent',
    call: async () => {
      throw new Error('no hub, no service')
    },
    registry: { getNodeList: () => [] },
  } as unknown as ServiceBroker
}

describe('renaming an agent that is not paired', () => {
  it('persists the name to agent.json and answers success when the rename action fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rename-'))
    dirs.push(dir)
    const configPath = path.join(dir, 'agent.json')
    const app = await createAgentHttpServer(brokerThatCannotRename, {
      port: 0,
      nodeId: 'test-agent',
      dataDir: dir,
      configPath,
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/config',
      payload: { name: 'kitchen-mac' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ success: true })
    const file: Record<string, unknown> = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    expect(file['name']).toBe('kitchen-mac')
    const status = await app.inject({ method: 'GET', url: '/api/agent/status' })
    expect(status.json()).toMatchObject({ name: 'kitchen-mac', paired: false })
    await app.close()
  })

  it('reports host-arch, not the node id, while agent.json carries no name', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-default-name-'))
    dirs.push(dir)
    const app = await createAgentHttpServer(brokerThatCannotRename, {
      port: 0,
      nodeId: 'agent-bbce9dde',
      dataDir: dir,
      configPath: path.join(dir, 'agent.json'),
    })
    const status = await app.inject({ method: 'GET', url: '/api/agent/status' })
    const name: unknown = status.json().name
    expect(name).not.toBe('agent-bbce9dde')
    expect(name).toBe(
      process.env['CAMSTACK_AGENT_NAME'] || defaultAgentName(os.hostname(), os.arch()),
    )
    await app.close()
  })
})
