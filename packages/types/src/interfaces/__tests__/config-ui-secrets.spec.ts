import { describe, expect, it } from 'vitest'
import type { ConfigUISchema } from '../config-ui.js'
import { collectKeychainStoredKeys } from '../config-ui-secrets.js'

const boardsSchema: ConfigUISchema = {
  sections: [
    {
      id: 'main',
      title: 'Main',
      columns: 1,
      fields: [
        { type: 'password', key: 'token', label: 'Token' },
        {
          type: 'editable-array',
          key: 'boards',
          label: 'Boards',
          itemIdKey: 'id',
          itemFields: [
            { type: 'text', key: 'host', label: 'Host' },
            { type: 'password', key: 'encryptionKey', label: 'Key' },
            { type: 'text', key: 'note', label: 'Note', secret: true, storage: 'inline' },
          ],
        },
        {
          type: 'editable-array',
          key: 'plain',
          label: 'Plain',
          itemFields: [{ type: 'text', key: 'host', label: 'Host' }],
        },
      ],
    },
  ],
}

describe('collectKeychainStoredKeys', () => {
  it('names a top-level secret by key and an array row secret by its id-addressed path', () => {
    expect([...collectKeychainStoredKeys(boardsSchema)].sort()).toEqual([
      'boards[id].encryptionKey',
      'token',
    ])
  })

  it('addresses rows by a custom itemIdKey', () => {
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 's',
          title: 'S',
          columns: 1,
          fields: [
            {
              type: 'editable-array',
              key: 'rows',
              label: 'Rows',
              itemIdKey: 'slug',
              itemFields: [{ type: 'password', key: 'pw', label: 'Pw' }],
            },
          ],
        },
      ],
    }
    expect([...collectKeychainStoredKeys(schema)]).toEqual(['rows[slug].pw'])
  })
})
