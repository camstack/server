/**
 * Delete-time occupancy on a SHARED recordings root.
 *
 * `/recordings` holds high + low + events as sibling class subtrees under
 * each camera. A shallow `readdir` of the root sees camera dirs (and
 * `.camstack-location`) and reports occupied for EVERY class — which is
 * how a drained `eventMedia:default` / `recordingsLow:default` refused
 * delete while `recordings:default` was still writing high footage there.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { probeLocalDirectoryOccupancy } from '../location-occupancy.js'

const roots: string[] = []

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'occupancy-'))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function put(root: string, rel: string, body = 'x'): Promise<void> {
  const full = path.join(root, rel)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, body)
}

describe('probeLocalDirectoryOccupancy', () => {
  it('treats eventMedia as empty when the shared root only has high footage', async () => {
    const root = await scratch()
    await put(root, '104/high/2026/09/01/seg.m4s')
    await writeFile(path.join(root, '.camstack-location'), '{}')
    await mkdir(path.join(root, '.rec-tmp'))
    expect(await probeLocalDirectoryOccupancy({ type: 'eventMedia', basePath: root })).toBe('empty')
  })

  it('treats eventMedia as occupied when any camera still has events/', async () => {
    const root = await scratch()
    await put(root, '104/high/seg.m4s')
    await put(root, '104/events/crop.jpg')
    expect(await probeLocalDirectoryOccupancy({ type: 'eventMedia', basePath: root })).toBe(
      'occupied',
    )
  })

  it('treats recordingsLow as empty when only high/ and events/ remain', async () => {
    const root = await scratch()
    await put(root, '104/high/seg.m4s')
    await put(root, '104/events/crop.jpg')
    expect(await probeLocalDirectoryOccupancy({ type: 'recordingsLow', basePath: root })).toBe(
      'empty',
    )
  })

  it('treats recordingsLow as occupied when low/ has an entry', async () => {
    const root = await scratch()
    await put(root, '104/low/seg.m4s')
    expect(await probeLocalDirectoryOccupancy({ type: 'recordingsLow', basePath: root })).toBe(
      'occupied',
    )
  })

  it('treats recordings as occupied on high/ and empty when only events/ remain', async () => {
    const root = await scratch()
    await put(root, '104/events/crop.jpg')
    expect(await probeLocalDirectoryOccupancy({ type: 'recordings', basePath: root })).toBe('empty')
    await put(root, '104/high/seg.m4s')
    expect(await probeLocalDirectoryOccupancy({ type: 'recordings', basePath: root })).toBe(
      'occupied',
    )
  })

  it('treats an empty class subtree as empty', async () => {
    const root = await scratch()
    await mkdir(path.join(root, '104', 'events'), { recursive: true })
    expect(await probeLocalDirectoryOccupancy({ type: 'eventMedia', basePath: root })).toBe('empty')
  })

  it('treats a missing root as empty', async () => {
    expect(
      await probeLocalDirectoryOccupancy({
        type: 'eventMedia',
        basePath: path.join(tmpdir(), 'occupancy-missing-' + Date.now()),
      }),
    ).toBe('empty')
  })

  it('treats an unmapped type as occupied on any non-dot root entry', async () => {
    const root = await scratch()
    await writeFile(path.join(root, '.hidden'), 'x')
    expect(await probeLocalDirectoryOccupancy({ type: 'backups', basePath: root })).toBe('empty')
    await writeFile(path.join(root, 'nightly.tar'), 'x')
    expect(await probeLocalDirectoryOccupancy({ type: 'backups', basePath: root })).toBe('occupied')
  })
})
