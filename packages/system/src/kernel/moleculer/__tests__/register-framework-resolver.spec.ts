import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:module', () => ({
  register: vi.fn(),
}))

import { registerFrameworkResolver } from '../register-framework-resolver.js'
import { register as registerMock } from 'node:module'

describe('registerFrameworkResolver', () => {
  beforeEach(() => {
    vi.mocked(registerMock).mockClear()
  })

  it('registers the hook when frameworkDir is set', () => {
    registerFrameworkResolver('/data/framework')
    expect(registerMock).toHaveBeenCalledTimes(1)
    const [spec, opts] = vi.mocked(registerMock).mock.calls[0] ?? []
    expect(String(spec)).toContain('framework-resolver-hook.mjs')
    expect(opts?.data).toEqual({ frameworkDir: '/data/framework' })
  })

  it('is a no-op when frameworkDir is unset/empty', () => {
    registerFrameworkResolver(undefined)
    registerFrameworkResolver('')
    expect(registerMock).not.toHaveBeenCalled()
  })
})
