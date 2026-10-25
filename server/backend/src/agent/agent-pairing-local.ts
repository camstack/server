/**
 * Where a pairing's one-time PIN, the agent's own code and the reset code are shown: ONLY on the
 * agent's machine (D857).
 *
 * The agent's page is opened from another PC and its API is reachable by the whole LAN, so anything
 * shown there could be read and used by anyone. The operator reads these things at the machine
 * instead - the process console (`docker logs` for a container), a 0600 file in the data dir, and the
 * desktop window (which asks the agent's loopback `status`) - and types the hub's code and the PIN
 * into the page.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { LocalPairingSecret } from '@camstack/system'
import { writeOwnerOnlyFileSync } from '@camstack/types/node'

export const PAIRING_PIN_FILE = 'pairing-pin.txt'
export const PAIRING_RESET_FILE = 'pairing-reset.txt'

export interface LocalPairingLog {
  warn(message: string): void
}

export interface LocalPairingAnnouncer {
  readonly onSecret: (secret: LocalPairingSecret) => void
  readonly onCleared: (pairingId: string) => void
  /** The reset code, printed at boot and renewed each time it is used. */
  readonly onResetCode: (code: string) => void
}

function describe(s: LocalPairingSecret): string {
  const fp = s.hub.caFingerprint.slice(0, 16)
  return [
    `Pairing request from hub "${s.hub.nodeId}" (${s.hub.url}), CA ${fp}`,
    `  PIN:        ${s.pin}   (type it on this agent's page with the code the HUB shows)`,
    `  this agent's code: ${s.code ?? '(not known yet - the hub has not revealed its nonce)'}   (type it on the hub)`,
    `  expires:    ${new Date(s.expiresAt).toISOString()}`,
  ].join('\n')
}

/**
 * Keep `pairing-pin.txt` (0600) and the console in step with the pending pairings. The file always
 * holds exactly the live ones and is removed when none is left - and a stale one left by a previous
 * run is removed here, at boot. A PIN is never logged anywhere else.
 */
export function createLocalPairingAnnouncer(
  dataDir: string,
  log: LocalPairingLog,
): LocalPairingAnnouncer {
  const file = path.join(dataDir, PAIRING_PIN_FILE)
  const resetFile = path.join(dataDir, PAIRING_RESET_FILE)
  const live = new Map<string, LocalPairingSecret>()

  const flush = (): void => {
    try {
      if (live.size === 0) {
        fs.rmSync(file, { force: true })
        return
      }
      fs.mkdirSync(dataDir, { recursive: true })
      writeOwnerOnlyFileSync(file, `${[...live.values()].map(describe).join('\n\n')}\n`)
    } catch (err) {
      log.warn(
        `could not write ${file}: ${err instanceof Error ? err.message : String(err)} - the PIN is in the console above`,
      )
    }
  }
  // A PIN file from a previous run belongs to pairings that no longer exist.
  flush()

  return {
    onSecret(secret) {
      live.set(secret.pairingId, secret)
      // The console is the agent's own stdout: `docker logs`, the service journal, the desktop log.
      log.warn(`\n${describe(secret)}\n  (also in ${file})`)
      flush()
    },
    onCleared(pairingId) {
      if (live.delete(pairingId)) flush()
    },
    onResetCode(code) {
      log.warn(
        `\nPairing reset code: ${code}\n  (clears pairing lockouts and pending offers: POST /api/agent/pairing/reset {"code": ...}; also in ${resetFile})`,
      )
      try {
        fs.mkdirSync(dataDir, { recursive: true })
        writeOwnerOnlyFileSync(resetFile, `${code}\n`)
      } catch (err) {
        log.warn(
          `could not write ${resetFile}: ${err instanceof Error ? err.message : String(err)} - the code is in the console above`,
        )
      }
    },
  }
}
