import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * D777: the capability toggle is an addon's ONE enable. The generated addon
 * must not ship a private `enabled` "master switch" — a second enable that
 * nothing reads and that can contradict the toggle.
 */
const TEMPLATE = path.join(
  __dirname,
  '..',
  'generators',
  'addon',
  'files',
  'src',
  '__addon__.addon.ts.template',
)

describe('addon generator template', () => {
  it('declares no `enabled` master switch', () => {
    const text = fs.readFileSync(TEMPLATE, 'utf8')
    expect(text).not.toMatch(/\benabled\b/)
    expect(text).not.toMatch(/master switch/i)
  })
})
