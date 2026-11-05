import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { alexaConnectionSchema, type AlexaBrokerEntry } from '../config.js'
import { SESSION_FILE, readNewerSession, removeSessionFile } from '../session-file-migration.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function dataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alexa-session-'))
  dirs.push(dir)
  return dir
}

function registration(tokenDate: number, marker: string) {
  return {
    refreshToken: `rt-${marker}`,
    loginCookie: 'a=b',
    deviceSerial: 's',
    amazonPage: 'amazon.it',
    localCookie: `c-${marker}`,
    csrf: marker,
    tokenDate,
    dataVersion: 2,
  }
}

function entry(cookie: unknown): AlexaBrokerEntry {
  return {
    id: 'alexa_001',
    name: 'Home',
    connection: alexaConnectionSchema.parse(
      cookie === undefined ? {} : { cookie: JSON.stringify(cookie) },
    ),
  }
}

async function writeFile(dir: string, cookieData: unknown): Promise<void> {
  await fs.writeFile(path.join(dir, `alexa_001.${SESSION_FILE}`), JSON.stringify({ cookieData }))
}

describe('the one-shot move of an old session file into the record', () => {
  it('takes the file when it is newer than the record', async () => {
    const dir = await dataDir()
    await writeFile(dir, registration(2000, 'file'))
    const moved = await readNewerSession(dir, entry(registration(1000, 'record')))
    expect(moved).not.toBeNull()
    expect(JSON.parse(moved ?? '{}')).toMatchObject({ csrf: 'file', tokenDate: 2000 })
  })

  it('takes the file when the record holds no registration at all', async () => {
    const dir = await dataDir()
    await writeFile(dir, registration(1, 'file'))
    expect(await readNewerSession(dir, entry(undefined))).not.toBeNull()
  })

  it('keeps the record when it is as new or newer', async () => {
    const dir = await dataDir()
    await writeFile(dir, registration(1000, 'file'))
    expect(await readNewerSession(dir, entry(registration(1000, 'record')))).toBeNull()
    expect(await readNewerSession(dir, entry(registration(5000, 'record')))).toBeNull()
  })

  it('ignores a missing, unparsable or foreign file', async () => {
    const dir = await dataDir()
    expect(await readNewerSession(dir, entry(registration(1, 'record')))).toBeNull()
    await fs.writeFile(path.join(dir, `alexa_001.${SESSION_FILE}`), 'not json')
    expect(await readNewerSession(dir, entry(registration(1, 'record')))).toBeNull()
    await writeFile(dir, { somethingElse: true })
    expect(await readNewerSession(dir, entry(registration(1, 'record')))).toBeNull()
    expect(await readNewerSession(undefined, entry(registration(1, 'record')))).toBeNull()
  })

  it('deletes the file, and tolerates it being absent', async () => {
    const dir = await dataDir()
    await writeFile(dir, registration(1, 'file'))
    await removeSessionFile(dir, 'alexa_001')
    expect(await fs.readdir(dir)).toEqual([])
    await expect(removeSessionFile(dir, 'alexa_001')).resolves.toBeUndefined()
  })
})
