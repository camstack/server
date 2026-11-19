/**
 * The registry row is the one stored switch (D1066). The fail-closed window is per owner addon:
 * one addon's unread registry never turns off another's instances, and an addon with no instance
 * kind is never held back. A created instance is on, and a re-apply announces only a CHANGED state.
 */
import { createTRPCClient, TRPCClientError, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AppRouter } from '../../generated/addon-api.js'
import { defineEntryKind } from '../../records/entry-kind.js'
import { makeInMemoryRecords } from '../../records/in-memory-records.js'
import { BaseAddon } from '../base-addon.js'
import { fakeAddonContext } from '../fake-addon-context.js'
import {
  claimInstance,
  clearInstanceSwitches,
  clearServedInstanceKinds,
  forgetInstanceSwitch,
  isInstanceOn,
  recordRegistrySwitch,
} from '../instance-switches.js'
import { isInstanceSwitchesUnreadError } from '../instance-switches-unread-error.js'
import { RecordIntegrationInstances } from '../record-integration-instances.js'

const BodySchema = z.object({ name: z.string().min(1), url: z.string() })
type Body = z.infer<typeof BodySchema>
const kind = defineEntryKind('switch-things', {
  title: 'Things',
  nameField: 'name',
  schema: BodySchema,
})

async function helperOf(owner: string) {
  const world = makeInMemoryRecords(owner)
  await world.records.declare({ 'switch-things': kind })
  const instances = new RecordIntegrationInstances<Body>(world.records, kind, {
    description: {
      role: 'services',
      instanceMode: 'multiple',
      kind: 'thing',
      canTest: false,
      kinds: [{ id: 'k', label: 'K', functionCap: 'device-provider' }],
    },
    formSchema: () => ({ sections: [] }),
    initialBody: (name) => ({ name, url: '' }),
    configured: () => true,
  })
  return instances
}

interface Hub {
  readonly link: TRPCLink<AppRouter>
  rows: readonly { id: string; enabled: boolean }[] | 'down'
}

function hub(rows: Hub['rows']): Hub {
  const state: Hub = {
    rows,
    link:
      () =>
      ({ op }) =>
        observable((observer) => {
          if (op.path === 'integrations.listByAddon') {
            if (state.rows === 'down') observer.error(TRPCClientError.from(new Error('hub down')))
            else observer.next({ result: { data: state.rows } })
          } else if (op.path === 'integrations.adoptInstanceRows') {
            observer.next({ result: { data: { created: 0, updated: 0, conflicts: [] } } })
          } else {
            observer.next({ result: { data: undefined } })
          }
          observer.complete()
        }),
  }
  return state
}

class Owner extends BaseAddon {
  constructor() {
    super({})
  }
  protected async onInitialize() {
    return []
  }
}

async function boot(id: string, h: Hub): Promise<Owner> {
  const addon = new Owner()
  await addon.initialize(
    fakeAddonContext({ id, api: createTRPCClient<AppRouter>({ links: [h.link] }) }),
  )
  return addon
}

afterEach(() => {
  clearInstanceSwitches()
  clearServedInstanceKinds()
})

describe('the fail-closed window is per owner', () => {
  it('addon X fails its read: its instance is off, addon Y instance is on', async () => {
    const x = await helperOf('x-addon')
    const y = await helperOf('y-addon')
    await x.createInstance({ id: 'x1', name: 'X' })
    await y.createInstance({ id: 'y1', name: 'Y' })
    // The stated state is forgotten as a restart would: only the owners differ.
    forgetInstanceSwitch('x1')
    forgetInstanceSwitch('y1')
    const xHub = hub('down')
    const yHub = hub([])
    await boot('x-addon', xHub)
    await boot('y-addon', yHub)
    expect((await x.getInstance({ id: 'x1' }))?.enabled).toBe(false)
    expect((await y.getInstance({ id: 'y1' }))?.enabled).toBe(true)
    // An id of Y that nobody stated (no row, no record yet) is a fresh instance: on.
    claimInstance('y-addon', 'y-fresh')
    expect(isInstanceOn('y-fresh')).toBe(true)
  })

  it('an addon with no instance kind is never held back by its own failed read', async () => {
    await boot('kindless-addon', hub('down'))
    expect(isInstanceOn('anything')).toBe(true)
  })

  it('a registry that stays unreadable fails the boot of an addon that serves a kind, by name', async () => {
    await helperOf('x-addon')
    const down = hub('down')
    const addon = await boot('x-addon', down)
    await expect(addon.rehydrateSwitches()).rejects.toSatisfy(isInstanceSwitchesUnreadError)
    down.rows = [{ id: 'x1', enabled: true }]
    await expect(addon.rehydrateSwitches()).resolves.toBeUndefined()
    expect(isInstanceOn('x1')).toBe(true)
  })

  it('a kindless addon never throws on a connect', async () => {
    const addon = await boot('kindless-addon', hub('down'))
    await expect(addon.rehydrateSwitches()).resolves.toBeUndefined()
  })
})

describe('a created instance and the re-apply', () => {
  it('a created instance is on while its owner still waits for the registry', async () => {
    const x = await helperOf('x-addon')
    await boot('x-addon', hub('down'))
    await x.createInstance({ id: 'fresh', name: 'Fresh' })
    expect(isInstanceOn('fresh')).toBe(true)
  })

  it('the re-apply announces only the instances whose state the addon did not already know', async () => {
    const x = await helperOf('x-addon')
    await x.createInstance({ id: 'steady', name: 'Steady' })
    await x.createInstance({ id: 'moved', name: 'Moved' })
    const seen: string[] = []
    x.onSwitched((id, enabled) => {
      seen.push(`${id}:${enabled}`)
    })
    await x.getResolved('steady')
    await x.getResolved('moved')
    recordRegistrySwitch('moved', false)
    await x.reapply()
    expect(seen).toEqual(['moved:false'])
    await x.reapply()
    expect(seen).toEqual(['moved:false'])
  })
})
