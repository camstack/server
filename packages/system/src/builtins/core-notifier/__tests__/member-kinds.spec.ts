import { type TargetKindCaps } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { GROUP_CAPS } from '../group-descriptor.js'
import { readMemberKinds } from '../member-kinds.js'

const caps: TargetKindCaps = GROUP_CAPS

describe('readMemberKinds', () => {
  it('drops the group kind at the source and keeps every other provider', async () => {
    const kinds = await readMemberKinds({
      notificationOutput: {
        listTargetKinds: {
          query: async () => [
            { kind: 'ntfy', addonId: 'notifiers', caps },
            { kind: 'group', addonId: 'core-notifier', caps },
            { kind: 'homeassistant', addonId: 'provider-homeassistant', caps },
          ],
        },
      },
    })
    expect(kinds.map((k) => k.kind)).toEqual(['ntfy', 'homeassistant'])
  })

  it('a failed read throws instead of answering an empty catalogue', async () => {
    await expect(
      readMemberKinds({
        notificationOutput: {
          listTargetKinds: {
            query: async () => {
              throw new Error('down')
            },
          },
        },
      }),
    ).rejects.toThrow('down')
  })
})
