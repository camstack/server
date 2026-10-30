import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createPublicServer } from '../mcp/server.js'
import { formFields, looksLikeCredentialName, viewConfig } from '../mcp/configure-support.js'
import { gatedHub } from './configure-fixtures.js'

/** Tool-argument names that are allowed even though they name a "token": the gate's one-shot handle. */
const ALLOWED = new Set(['confirm_token'])

async function listedTools(): Promise<Awaited<ReturnType<Client['listTools']>>['tools']> {
  const server = createPublicServer({
    toolsets: ['configure'],
    context: gatedHub({}).ctx,
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(b)
  return (await client.listTools()).tools
}

describe('no configure tool accepts a secret', () => {
  it('no input schema has a field named like a credential', async () => {
    const tools = await listedTools()
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'configure_addons_search',
        'configure_addon_install',
        'configure_addon_update',
        'configure_addon_uninstall',
        'configure_camera_providers',
        'configure_camera_discover',
        'configure_camera_add',
        'configure_notifiers',
        'configure_notification_targets',
        'configure_notification_target_upsert',
        'configure_notification_target_test',
      ]),
    )
    const offenders = tools.flatMap((tool) =>
      Object.keys(tool.inputSchema.properties ?? {})
        .filter((name) => !ALLOWED.has(name) && looksLikeCredentialName(name))
        .map((name) => `${tool.name}.${name}`),
    )
    expect(offenders).toEqual([])
  })

  it('a password-typed form field is secret, whatever its name, and a text field named password is not', () => {
    const fields = formFields({
      sections: [
        {
          fields: [
            { type: 'password', key: 'topic', label: 'Topic' },
            {
              type: 'text',
              key: 'password',
              label: 'Looks secret but is text',
            },
            { type: 'text', key: 'x', secret: true, label: 'Marked' },
            {
              type: 'editable-array',
              key: 'headers',
              label: 'H',
              itemFields: [{ type: 'password', key: 'value' }],
            },
          ],
        },
      ],
    })
    expect(fields?.filter((f) => f.secret).map((f) => f.key)).toEqual(['topic', 'x', 'headers'])
  })

  it('a stored config is shown with secrets as set/unset only', () => {
    const fields =
      formFields({
        sections: [
          {
            fields: [{ type: 'password', key: 'topic', label: 'T', required: true }],
          },
        ],
      }) ?? []
    const view = viewConfig(fields, {
      topic: 'plain-value',
      api_key: 'abc',
      host: 'h',
    })
    expect(view.values).toEqual({ host: 'h' })
    expect(view.secrets).toEqual({ topic: 'set', api_key: 'set' })
    expect(JSON.stringify(view)).not.toContain('plain-value')
  })
})
