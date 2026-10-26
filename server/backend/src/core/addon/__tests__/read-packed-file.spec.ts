import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isPackedChangelogPath, readPackedChangelog } from '../read-packed-file.js'

const tmpDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-docs-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function tarball(files: Readonly<Record<string, string>>): Buffer {
  const srcDir = makeTempDir()
  for (const [rel, body] of Object.entries(files)) {
    const dest = path.join(srcDir, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, body)
  }
  const tgzPath = path.join(srcDir, 'pkg.tgz')
  execFileSync('tar', ['-czf', tgzPath, '-C', srcDir, 'package'], { timeout: 10_000 })
  return fs.readFileSync(tgzPath)
}

describe('readPackedChangelog', () => {
  it('reads package/CHANGELOG.md and ignores a nested copy', async () => {
    const tgz = tarball({
      'package/CHANGELOG.md': '# Changelog\n\n## 1.0.0\n',
      'package/docs/CHANGELOG.md': 'not this one\n',
    })
    await expect(readPackedChangelog(tgz)).resolves.toBe('# Changelog\n\n## 1.0.0\n')
  })

  it('returns null when the tarball has no changelog', async () => {
    const tgz = tarball({ 'package/README.md': '# Hi\n' })
    await expect(readPackedChangelog(tgz)).resolves.toBeNull()
  })

  it('accepts only the package-root changelog path', () => {
    expect(isPackedChangelogPath('package/CHANGELOG.md')).toBe(true)
    expect(isPackedChangelogPath('package/changelog.md')).toBe(true)
    expect(isPackedChangelogPath('CHANGELOG.md')).toBe(true)
    expect(isPackedChangelogPath('package/docs/CHANGELOG.md')).toBe(false)
  })
})
