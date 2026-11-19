import { InstanceSwitchesUnreadError } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { rehydrateSwitchesOnHubConnect } from '../hub-connect-switches.js'

/** An owner whose registry read answers after `failures` refusals. */
function owner(failures: number) {
  let left = failures
  const rehydrateSwitches = vi.fn(async () => {
    if (left > 0) {
      left -= 1
      throw new InstanceSwitchesUnreadError('x-addon')
    }
  })
  return { rehydrateSwitches }
}

function deps(fatalOnUnread: boolean) {
  return {
    fatalOnUnread,
    onUnread: vi.fn(),
    exit: vi.fn(),
  }
}

describe('rehydrateSwitchesOnHubConnect', () => {
  it('an agent that reconnects reads the registry again for an owner still pending', async () => {
    const x = owner(1)
    const d = deps(false)
    const entries = [{ addonId: 'x-addon', addon: x }]
    await rehydrateSwitchesOnHubConnect(entries, d)
    expect(d.onUnread).toHaveBeenCalledTimes(1)
    expect(d.exit).not.toHaveBeenCalled()
    // The next hub connect: the owner is read again and now answers.
    await rehydrateSwitchesOnHubConnect(entries, d)
    expect(x.rehydrateSwitches).toHaveBeenCalledTimes(2)
    expect(d.onUnread).toHaveBeenCalledTimes(1)
  })

  it('a forked runner whose boot read fails exits, so the supervisor respawns it (D6)', async () => {
    const d = deps(true)
    await rehydrateSwitchesOnHubConnect([{ addonId: 'x-addon', addon: owner(1) }], d)
    expect(d.exit).toHaveBeenCalledWith('x-addon', expect.any(InstanceSwitchesUnreadError))
  })

  it('an addon without instance kinds, and one that answers, never exits the runner', async () => {
    const d = deps(true)
    await rehydrateSwitchesOnHubConnect(
      [
        { addonId: 'plain', addon: {} },
        { addonId: 'x-addon', addon: owner(0) },
      ],
      d,
    )
    expect(d.exit).not.toHaveBeenCalled()
    expect(d.onUnread).not.toHaveBeenCalled()
  })

  it('one owner that fails does not stop the others from reading', async () => {
    const good = owner(0)
    const d = deps(false)
    await rehydrateSwitchesOnHubConnect(
      [
        { addonId: 'x-addon', addon: owner(5) },
        { addonId: 'y-addon', addon: good },
      ],
      d,
    )
    expect(good.rehydrateSwitches).toHaveBeenCalledTimes(1)
  })
})
