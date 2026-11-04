import { describe, expect, it } from 'vitest'
import { deleteSkillRows } from '../skill-cleanup.js'

describe('deleting a skill', () => {
  it('removes its links, its exposure and its state, and only those of that id', async () => {
    const deleted: string[] = []
    const handle = (kind: string) => ({
      delete: async (id: string) => {
        deleted.push(`${kind}:${id}`)
        return true
      },
    })
    await deleteSkillRows(
      {
        links: handle('links'),
        exports: handle('exports'),
        state: handle('state'),
      },
      'alexa-skill-2',
    )
    expect(deleted).toEqual(['links:alexa-skill-2', 'exports:alexa-skill-2', 'state:alexa-skill-2'])
  })
})
