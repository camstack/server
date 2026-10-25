/**
 * The role, read SYNCHRONOUSLY at module top — before `app.whenReady`.
 *
 * Chromium command-line switches (`ignore-certificate-errors`) must be appended
 * before the app is ready, but the `electron-store` instance is only created
 * INSIDE `whenReady` (v11 is ESM-only, hence the dynamic import in `main.ts`).
 * So at switch time the role is not knowable through the store. It IS knowable
 * from the store's file on disk: `electron-store`'s default name is
 * `config.json` under `app.getPath('userData')`, and `app.getPath` works before
 * ready.
 *
 * `parseBootRole` is the whole decision and is a pure function of the file's
 * bytes: absent, unreadable, non-JSON, JSON that is not an object, or a `role`
 * key holding anything unexpected all yield `'hub'` — the same fallback
 * `parseRoleSetting` gives the store-read path, so the two can never disagree
 * about a corrupt store. `readBootRoleSync` is the thin fs wrapper.
 *
 * Consequence of getting this wrong in either direction: a hub whose role reads
 * as `'viewer'` loses the switch and cannot load its own self-signed
 * `https://localhost:4443`; a viewer whose role reads as `'hub'` silently
 * accepts ANY certificate on the LAN. Hence the spec.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { DesktopProduct } from '../product/desktop-product'
import { parseRoleSetting } from '../role-setting'
import type { NodeRole } from '../types'
import { roleForProduct } from './effective-role'

/** `electron-store`'s default store file name, relative to `userData`. */
export const STORE_FILE_NAME = 'config.json'

/**
 * Pure: the persisted role as expressed by the raw store file contents.
 * `null` means "the file could not be read at all" (absent / unreadable).
 */
export function parseBootRole(fileContents: string | null): NodeRole {
  if (fileContents === null) return 'hub'
  let parsed: unknown
  try {
    parsed = JSON.parse(fileContents)
  } catch {
    return 'hub'
  }
  if (!isRecord(parsed)) return 'hub'
  return parseRoleSetting(parsed['role'])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read `<userDataDir>/config.json` synchronously and derive the boot role.
 * Never throws: an unreadable file is indistinguishable from an absent one and
 * both mean "not configured yet" → `'hub'`.
 *
 * The PRODUCT is consulted first and can settle the answer on its own: the
 * reduced product is a viewer by construction (`roleForProduct`), so it returns
 * without touching the file. That is the single composition point for the
 * certificate switch — no store, however stale or corrupt, can hand the viewer
 * product a role that appends `ignore-certificate-errors`.
 */
export function readBootRoleSync(userDataDir: string, product: DesktopProduct): NodeRole {
  if (product === 'viewer') return roleForProduct(product, 'viewer')
  let contents: string | null = null
  try {
    contents = fs.readFileSync(path.join(userDataDir, STORE_FILE_NAME), 'utf8')
  } catch {
    contents = null
  }
  return roleForProduct(product, parseBootRole(contents))
}

/**
 * Whether this role needs the global `ignore-certificate-errors` switch.
 *
 * Hub and agent talk to a LOCALHOST child whose cert they generated themselves;
 * the switch's blast radius is the loopback interface. The viewer talks to a
 * remote hub over the LAN, where the same switch would accept any certificate
 * from any host on the path — see ADR-0402. Viewer trust is adjudicated per
 * session by `cert-trust.ts` instead.
 */
export function shouldIgnoreCertificateErrors(role: NodeRole): boolean {
  return role !== 'viewer'
}
