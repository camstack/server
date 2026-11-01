import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import {
  composeNodePath,
  frameworkNodePaths,
  isActiveFrameworkRoot,
} from '../framework-nodepath.js'

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

describe('isActiveFrameworkRoot', () => {
  const root = '/data/server-root/current'
  const folded = path.join(root, 'node_modules', '@camstack', 'server', 'system', 'package.json')

  it('recognises a closure whose server carries the framework (D989)', () => {
    expect(isActiveFrameworkRoot(root, (p) => p === folded)).toBe(true)
  })

  it('a closure with only the retired standalone framework package is not one', () => {
    const legacy = path.join(root, 'node_modules', '@camstack', 'system')
    expect(isActiveFrameworkRoot(root, (p) => p === legacy)).toBe(false)
  })

  it('is false when the active root is unset', () => {
    expect(isActiveFrameworkRoot(undefined, () => true)).toBe(false)
  })
})

describe('composeNodePath', () => {
  it('puts the active closure ahead of an inherited image entry', () => {
    const out = composeNodePath(
      '/data/framework/node_modules',
      ['/data/server-root/current/node_modules', '/srv/nm'],
      ':',
    )
    expect(out.split(':')).toEqual([
      '/data/server-root/current/node_modules',
      '/srv/nm',
      '/data/framework/node_modules',
    ])
  })

  it('keeps one copy of an entry already inherited', () => {
    expect(composeNodePath('/a:/b', ['/b', '/c'], ':')).toBe('/b:/c:/a')
  })

  it('is the preferred list when nothing is inherited', () => {
    expect(composeNodePath(undefined, ['/c'], ':')).toBe('/c')
  })
})
