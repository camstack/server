import { describe, expect, it, vi } from 'vitest'
import { installUpdateIfStaged } from '../install-update'

function deps(isStaged: (() => boolean) | null, quit: () => void = () => undefined) {
  return {
    isStaged,
    nudgeIfNotStaged: vi.fn(),
    quitAndInstall: vi.fn(quit),
    warn: vi.fn(),
  }
}

describe('installUpdateIfStaged', () => {
  it('refuses a not-staged update: nudges, warns, never quits', () => {
    const d = deps(() => false)
    expect(installUpdateIfStaged(d)).toEqual({ kind: 'refused-not-staged' })
    expect(d.quitAndInstall).not.toHaveBeenCalled()
    expect(d.nudgeIfNotStaged).toHaveBeenCalledOnce()
    expect(d.warn).toHaveBeenCalled()
  })

  it('installs a staged update', () => {
    const d = deps(() => true)
    expect(installUpdateIfStaged(d)).toEqual({ kind: 'installing' })
    expect(d.quitAndInstall).toHaveBeenCalledOnce()
  })

  it('installs where there is no native staging step', () => {
    const d = deps(null)
    expect(installUpdateIfStaged(d).kind).toBe('installing')
  })

  it('catches a quitAndInstall throw', () => {
    const d = deps(
      () => true,
      () => {
        throw new Error('The command is disabled and cannot be executed')
      },
    )
    expect(installUpdateIfStaged(d)).toEqual({
      kind: 'failed',
      message: 'The command is disabled and cannot be executed',
    })
    expect(d.warn).toHaveBeenCalled()
  })
})
