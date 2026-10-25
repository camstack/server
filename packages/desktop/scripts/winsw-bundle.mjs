/**
 * The service wrapper the Windows installer ships (D846): WinSW, pinned.
 *
 * It is fetched at BUILD time, hashed against the value below, and packed into
 * the installer under `resources/service/winsw.exe` — never downloaded on a
 * user's machine, and never taken from an npm package that embeds an old copy.
 * `WinSW.NET461.exe` is the 640 KB build for the .NET Framework that every
 * supported Windows 10/11 already has (the 18 MB `WinSW-x64.exe` bundles its
 * own runtime for no benefit here).
 *
 * Changing the version is changing these two constants after re-hashing:
 *   curl -fsSL -o w.exe <WINSW_URL> && shasum -a 256 w.exe
 */
import { sha256File } from './node-bundle.mjs'

export const WINSW_VERSION = 'v2.12.0'
export const WINSW_URL = `https://github.com/winsw/winsw/releases/download/${WINSW_VERSION}/WinSW.NET461.exe`
/** SHA-256 of the pinned artifact, taken 2026-10-13 (655,872 bytes). */
export const WINSW_SHA256 = 'b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f'
/** Where it lands under the staged dir, and so under `resources/`. */
export const WINSW_STAGED_NAME = 'winsw.exe'

/** Refuse a WinSW that is not the pinned one. Throws. */
export function verifyWinsw(path, expected = WINSW_SHA256) {
  const actual = sha256File(path)
  if (actual !== expected) {
    throw new Error(
      `WinSW does not match its pinned checksum — refusing it. url=${WINSW_URL} expected=${expected} actual=${actual}`,
    )
  }
}
