/**
 * The bundle tar reader trusts nothing: only allowlisted regular files are
 * written, each hashed on the way; a long name (PAX / GNU, what Python's
 * tarfile writes past 100 bytes) resolves; an unlisted entry, a link or a
 * traversal path refuses the WHOLE bundle.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { create } from 'tar'
import { afterEach, describe, expect, it } from 'vitest'
import { extractBundleTar, isSafeBundlePath } from '../bundle/bundle-tar.js'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'bundle-tar-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

async function makeTar(
  files: Record<string, Buffer>,
  opts: { portable?: boolean; link?: string } = {},
): Promise<string> {
  const src = await tempDir()
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(src, name)), { recursive: true })
    await writeFile(path.join(src, name), body)
  }
  if (opts.link !== undefined) await symlink('/etc/passwd', path.join(src, opts.link))
  const out = path.join(await tempDir(), 'bundle.tar')
  const entries = [...Object.keys(files), ...(opts.link !== undefined ? [opts.link] : [])]
  await create({ file: out, cwd: src, portable: opts.portable ?? true }, entries)
  return out
}

describe('bundle tar reader', () => {
  it('extracts allowlisted files with their sha256, long names included', async () => {
    const long = `custom-${'x'.repeat(70)}.mlpackage/Data/com.apple.CoreML/weights/weight.bin`
    const files = {
      'm.onnx': Buffer.from('onnx-bytes'),
      [long]: Buffer.alloc(3 * 1024 * 1024 + 7, 9),
    }
    const tar = await makeTar(files)
    const dest = await tempDir()
    const result = await extractBundleTar(tar, dest, new Set(Object.keys(files)))
    expect(result.kind).toBe('extracted')
    if (result.kind !== 'extracted') return
    const byPath = new Map(result.files.map((f) => [f.path, f]))
    for (const [name, body] of Object.entries(files)) {
      expect(byPath.get(name)?.sha256).toBe(sha(body))
      expect(byPath.get(name)?.bytes).toBe(body.length)
      expect((await readFile(path.join(dest, name))).equals(body)).toBe(true)
    }
  })

  it('refuses an entry that is not in the allowlist', async () => {
    const tar = await makeTar({ 'm.onnx': Buffer.from('a'), 'extra.sh': Buffer.from('b') })
    const result = await extractBundleTar(tar, await tempDir(), new Set(['m.onnx']))
    expect(result).toEqual({
      kind: 'refused',
      detail: 'entry "extra.sh" is not part of the declared bundle',
    })
  })

  it('refuses a link', async () => {
    const tar = await makeTar({ 'm.onnx': Buffer.from('a') }, { link: 'evil' })
    const result = await extractBundleTar(tar, await tempDir(), new Set(['m.onnx', 'evil']))
    expect(result.kind).toBe('refused')
  })

  it('never accepts a traversal or absolute path', () => {
    expect(isSafeBundlePath('../x')).toBe(false)
    expect(isSafeBundlePath('/etc/x')).toBe(false)
    expect(isSafeBundlePath('a/../b')).toBe(false)
    expect(isSafeBundlePath('a//b')).toBe(false)
    expect(isSafeBundlePath('a/b.bin')).toBe(true)
  })
})
