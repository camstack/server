import { describe, expect, it, vi } from 'vitest'
import { heroArgsWithValue } from '@camstack/types'
import { callHeroAction, capRouterName, heroCallInput } from '../call-hero-action'

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

  it('sends no deviceId to a singleton cap method and no input when nothing is left', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined)
    await callHeroAction(
      { update: { installUpdate: { mutate } } },
      { cap: 'update', method: 'installUpdate', args: {} },
      9,
      undefined,
    )
    expect(mutate).toHaveBeenCalledWith(undefined)
    expect(heroCallInput({ cap: 'update', method: 'installUpdate', args: {} }, 9, undefined)).toBe(
      undefined,
    )
  })

  it('carries the nested control value and the colour preset to the mutate input', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined)
    const control = {
      cap: 'control',
      method: 'setValue',
      args: heroArgsWithValue({ control: { kind: 'numeric' } }, 'control.value', 22),
    }
    await callHeroAction({ control: { setValue: { mutate } } }, control, 5, undefined)
    expect(mutate).toHaveBeenCalledWith({ control: { kind: 'numeric', value: 22 }, deviceId: 5 })

    const preset = {
      cap: 'color',
      method: 'setColor',
      args: { color: { mode: 'hsv', hsv: { h: 120, s: 80, v: 60 } } },
    }
    await callHeroAction({ color: { setColor: { mutate } } }, preset, 5, 'hub')
    expect(mutate).toHaveBeenLastCalledWith({
      color: { mode: 'hsv', hsv: { h: 120, s: 80, v: 60 } },
      deviceId: 5,
      nodeId: 'hub',
    })
  })
})
