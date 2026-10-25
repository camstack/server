/**
 * The hub-side staging of a job's artefacts: `<dir>/<jobId>/bundle.tar` and
 * `result.json`. A bundle arrives over `ctx.peerBytes`, bounded by the size
 * result.json declared and hashed after it lands; it leaves the same way to
 * Model Studio. The whole job directory goes when the result expires (14 days
 * after ready / registration) or is discarded.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AddonPeerBytes } from '@camstack/types'
import type { ArtifactPort } from './ports.js'

const BUNDLE = 'bundle.tar'
const RESULT = 'result.json'

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/** Job ids are uuids; anything else never becomes a path. */
function jobDir(root: string, jobId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(jobId)) throw new Error(`not a job id: ${jobId}`)
  return path.join(root, jobId)
}

export function createDiskArtifacts(
  root: string,
  peer: Pick<AddonPeerBytes, 'open' | 'offerFile'>,
): ArtifactPort {
  return {
    receiveBundle: async (jobId, ticket, maxBytes) => {
      const dir = jobDir(root, jobId)
      await mkdir(dir, { recursive: true })
      const target = path.join(dir, BUNDLE)
      const opened = await peer.open(ticket)
      if (opened.kind === 'refused')
        throw new Error(`bundle offer refused: ${opened.code} — ${opened.detail}`)
      const written = await opened.body.writeToFile(target, { maxBytes })
      if (written.kind === 'refused')
        throw new Error(`bundle transfer refused: ${written.code} — ${written.detail}`)
      return { bytes: written.bytes, sha256: await sha256File(target) }
    },
    writeResult: async (jobId, text) => {
      const dir = jobDir(root, jobId)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, RESULT), text, 'utf8')
    },
    readResult: async (jobId) => {
      try {
        return await readFile(path.join(jobDir(root, jobId), RESULT), 'utf8')
      } catch {
        return null
      }
    },
    offerBundle: async (jobId) => {
      const offered = await peer.offerFile({
        path: path.join(jobDir(root, jobId), BUNDLE),
        contentType: 'application/x-tar',
        label: 'training-bundle',
      })
      if (offered.kind === 'refused')
        throw new Error(`bundle offer refused: ${offered.code} — ${offered.detail}`)
      return offered.ticket
    },
    remove: async (jobId) => {
      await rm(jobDir(root, jobId), { recursive: true, force: true })
    },
  }
}
