/**
 * The process-table readers behind the staging-directory guard (D667).
 *
 * The real-process spec exercises whichever reader the CURRENT platform has.
 * This one pins both parsers on every platform, so a Linux-only break is seen
 * on a Mac and the other way round: the `/proc` reader over a fake tree, and
 * the `ps` table parser over captured output.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createLinuxProcessLister,
  parseLinuxStat,
  parsePsElapsed,
  parsePsTable,
} from '../process-table.js'
import { specRoot } from './spec-root.js'

/** A `/proc/<pid>/stat` line; `comm` deliberately holds a space and a `)`. */
function statLine(pid: number, ppid: number, startTicks: number): string {
  const afterComm = [
    'S',
    String(ppid),
    ...Array.from({ length: 17 }, () => '0'),
    String(startTicks),
  ]
  return `${pid} (ff mpeg) x) ${afterComm.join(' ')} 0 0 0\n`
}

describe('the /proc reader', () => {
  it('returns exact argv, ppid and age for the processes that carry the marker — and skips zombies', async () => {
    const root = specRoot('proc-table')
    writeFileSync(path.join(root, 'uptime'), '1000.00 5000.00\n')
    const put = (pid: number, argv: readonly string[], stat: string): void => {
      mkdirSync(path.join(root, String(pid)))
      writeFileSync(
        path.join(root, String(pid), 'cmdline'),
        argv.length ? `${argv.join('\0')}\0` : '',
      )
      writeFileSync(path.join(root, String(pid), 'stat'), stat)
    }
    const dir = '/media/Cam Disk/.rec-tmp/101/high'
    put(4242, ['ffmpeg', '-segment_list', `${dir}/live.m3u8`], statLine(4242, 1, 40_000))
    put(4300, ['node', 'server.js'], statLine(4300, 1, 100))
    put(4301, [], statLine(4301, 1, 100)) // zombie / kernel thread
    mkdirSync(path.join(root, 'self'))

    const listed = await createLinuxProcessLister(root).list('-segment_list')

    expect(listed).toEqual([
      {
        pid: 4242,
        ppid: 1,
        argv: ['ffmpeg', '-segment_list', `${dir}/live.m3u8`],
        command: `ffmpeg -segment_list ${dir}/live.m3u8`,
        // uptime 1000 s, started at 40 000 ticks = 400 s → 600 s old.
        ageMs: 600_000,
      },
    ])
  })

  it('throws — never answers "none" — when the table itself cannot be read', async () => {
    await expect(createLinuxProcessLister('/nonexistent-proc-root').list('x')).rejects.toThrow()
  })

  it('reads ppid and start time past a comm that contains `)`', () => {
    expect(parseLinuxStat(statLine(7, 42, 12_345))).toEqual({ ppid: 42, startTicks: 12_345 })
    expect(parseLinuxStat('garbage')).toEqual({ ppid: null, startTicks: null })
  })
})

describe('the ps parser', () => {
  it('parses pid, ppid, elapsed and the whole command, keeping only marker lines', () => {
    const stdout = [
      '    1     0 10-02:03:04 /sbin/launchd',
      ' 4242     1       01:05 /opt/ffmpeg -segment_list /Volumes/Cam Disk/.rec-tmp/101/high/live.m3u8 x',
      '',
    ].join('\n')
    expect(parsePsTable(stdout, '-segment_list')).toEqual([
      {
        pid: 4242,
        ppid: 1,
        argv: null,
        command: '/opt/ffmpeg -segment_list /Volumes/Cam Disk/.rec-tmp/101/high/live.m3u8 x',
        ageMs: 65_000,
      },
    ])
  })

  it('reads every etime shape, and says null for one it does not know', () => {
    expect(parsePsElapsed('05')).toBeNull()
    expect(parsePsElapsed('01:05')).toBe(65_000)
    expect(parsePsElapsed('02:01:05')).toBe(7_265_000)
    expect(parsePsElapsed('3-02:01:05')).toBe(266_465_000)
  })
})
