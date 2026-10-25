import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { frameworkNodePaths } from '../framework-nodepath.js'

describe('frameworkNodePaths', () => {
  it('returns the framework node_modules when set and present', () => {
    const out = frameworkNodePaths(
      '/data/framework',
      (p) => p === path.join('/data/framework', 'node_modules'),
    )
    expect(out).toEqual([path.join('/data/framework', 'node_modules')])
  })

  it('returns empty when unset', () => {
    expect(frameworkNodePaths(undefined, () => true)).toEqual([])
  })

  it('returns empty when the dir does not exist', () => {
    expect(frameworkNodePaths('/data/framework', () => false)).toEqual([])
  })
})
