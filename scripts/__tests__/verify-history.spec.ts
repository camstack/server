import { describe, expect, it } from 'vitest'

import { failedProjectsFromHistory } from '../ci/verify-history.mjs'

function line(base: string, projects: readonly { project: string; exitCode: number }[]): string {
  return JSON.stringify({ base, projects })
}

describe('failed projects of the previous run', () => {
  it('reads the newest record of the same base that ran projects', () => {
    const text = [
      line('b1', [{ project: 'old', exitCode: 1 }]),
      line('b2', [{ project: 'other-base', exitCode: 1 }]),
      line('b1', [
        { project: 'ok', exitCode: 0 },
        { project: 'red', exitCode: 1 },
      ]),
      line('b1', []),
    ].join('\n')
    expect(failedProjectsFromHistory(text, 'b1')).toEqual(['red'])
  })

  it('is empty for an unknown base, an empty base or a corrupt line', () => {
    const text = `${line('b1', [{ project: 'red', exitCode: 1 }])}\nnot json\n`
    expect(failedProjectsFromHistory(text, 'zzz')).toEqual([])
    expect(failedProjectsFromHistory(text, '')).toEqual([])
    expect(failedProjectsFromHistory(text, 'b1')).toEqual(['red'])
  })
})
