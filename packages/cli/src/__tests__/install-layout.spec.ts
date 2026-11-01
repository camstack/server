import { describe, expect, it } from 'vitest'
import { detectInstallLayout, managedRoot } from '../install-layout.js'

const HOME = '/home/op'
const ROOT = '/home/op/.local/share/camstack'

describe('install layout detection', () => {
  it('a CLI under cli/<ver> or current is managed', () => {
    expect(
      detectInstallLayout(`${ROOT}/cli/1.2.3/node_modules/camstack/dist/cli.js`, {}, HOME),
    ).toEqual({
      kind: 'managed',
      root: ROOT,
    })
    expect(
      detectInstallLayout(`${ROOT}/current/node_modules/camstack/dist/cli.js`, {}, HOME).kind,
    ).toBe('managed')
  })

  it('the runtime dir alone is not a CLI install', () => {
    expect(detectInstallLayout(`${ROOT}/runtime/bin/node`, {}, HOME).kind).not.toBe('managed')
  })

  it('CAMSTACK_HOME moves the root', () => {
    expect(managedRoot({ CAMSTACK_HOME: '/opt/cs' }, HOME)).toBe('/opt/cs')
    expect(
      detectInstallLayout('/opt/cs/current/x/cli.js', { CAMSTACK_HOME: '/opt/cs' }, HOME).kind,
    ).toBe('managed')
  })

  it('npm-global, npx and anything else are told apart', () => {
    expect(detectInstallLayout('/usr/lib/node_modules/camstack/dist/cli.js', {}, HOME).kind).toBe(
      'npm-global',
    )
    expect(
      detectInstallLayout('/home/op/.npm/_npx/ab/node_modules/camstack/dist/cli.js', {}, HOME).kind,
    ).toBe('npx')
    expect(detectInstallLayout('/work/camstack/packages/cli/dist/cli.js', {}, HOME).kind).toBe(
      'other',
    )
  })
})
