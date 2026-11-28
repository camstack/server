import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const HUB_MJS = path.resolve(__dirname, '../hub/hub.mjs')

function runHub(args: readonly string[]) {
  return spawnSync(process.execPath, [HUB_MJS, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CAMSTACK_TOKEN: 'ignored-token', CAMSTACK_HUB_TOKEN_FILE: '/nope' },
  })
}

describe('hub.mjs: the dominevo login session is the only credential (D1101)', () => {
  it.each(['--token', '--token-file'])('%s is refused with the removal message', (flag) => {
    const res = runHub([flag, 'x', 'GET', 'addons.list'])
    expect(res.status).toBe(1)
    expect(res.stderr).toMatch(/removed/)
    expect(res.stderr).toMatch(/dominevo login/)
  })
})
