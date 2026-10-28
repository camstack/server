import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readServerVersionFrom } from '../hub-server-version.js'

function pkg(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-version-'))
  const file = path.join(dir, 'package.json')
  fs.writeFileSync(file, contents)
  return file
}

describe('readServerVersionFrom', () => {
  it('reads the @camstack/server version', () => {
    expect(readServerVersionFrom(pkg('{"name":"@camstack/server","version":"1.2.650"}'))).toBe(
      '1.2.650',
    )
  })
  it('is null for another package, an unreadable file or a missing version', () => {
    expect(readServerVersionFrom(pkg('{"name":"x","version":"1.0.0"}'))).toBeNull()
    expect(readServerVersionFrom(pkg('not json'))).toBeNull()
    expect(readServerVersionFrom(pkg('{"name":"@camstack/server"}'))).toBeNull()
    expect(readServerVersionFrom('/nonexistent/package.json')).toBeNull()
  })
})
