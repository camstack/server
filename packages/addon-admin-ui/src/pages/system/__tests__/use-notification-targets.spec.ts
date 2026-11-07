import type { LinkableInstance } from '@camstack/ui-library'
import { describe, expect, it } from 'vitest'
import { targetsFromInstances } from '../use-notification-targets'

const instance = (overrides: Partial<LinkableInstance>): LinkableInstance => ({
  id: 'tg-1',
  name: 'Phone',
  addonId: 'notifiers',
  kind: 'notify-telegram',
  recordKind: 'notify-telegram',
  enabled: true,
  state: 'ok',
  stateLabel: null,
  usable: true,
  formValues: { chatId: '42' },
  ...overrides,
})

describe('targetsFromInstances', () => {
  it('shapes an instance as the Target the rule editor works with, with the adapter kind', () => {
    expect(targetsFromInstances([instance({})])).toEqual([
      {
        id: 'tg-1',
        name: 'Phone',
        kind: 'telegram',
        addonId: 'notifiers',
        enabled: true,
        config: { chatId: '42' },
      },
    ])
  })

  it('keeps an off instance off', () => {
    expect(targetsFromInstances([instance({ enabled: false })])[0]?.enabled).toBe(false)
  })
})
