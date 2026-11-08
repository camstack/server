import { describe, expect, it, vi } from 'vitest'
import { callHeroAction, capRouterName } from '../call-hero-action'

describe('callHeroAction', () => {
  it('names the router like the generated client', () => {
    expect(capRouterName('media-player')).toBe('mediaPlayer')
    expect(capRouterName('switch')).toBe('switch')
  })

  it('calls the named cap method with the device id and the pinned node', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined)
    const client = { mediaPlayer: { setVolume: { mutate } } }
    await callHeroAction(
      client,
      { cap: 'media-player', method: 'setVolume', args: { level: 30 } },
      9,
      'hub',
    )
    expect(mutate).toHaveBeenCalledWith({
      level: 30,
      deviceId: 9,
      nodeId: 'hub',
    })
  })

  it('omits the node when the binding pins none', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined)
    await callHeroAction(
      { switch: { setState: { mutate } } },
      { cap: 'switch', method: 'setState', args: { on: true } },
      3,
      undefined,
    )
    expect(mutate).toHaveBeenCalledWith({ on: true, deviceId: 3 })
  })

  it('rejects, naming the missing method, instead of doing nothing', async () => {
    await expect(
      callHeroAction({}, { cap: 'switch', method: 'setState', args: {} }, 3, undefined),
    ).rejects.toThrow("no mutation 'switch.setState'")
  })
})
