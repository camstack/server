/**
 * A minimal POSIX ustar writer — enough to emit a dataset archive entry by
 * entry, without ever holding the archive in memory.
 *
 * ## Why hand-rolled rather than the `tar` package
 *
 * `tar` is in the workspace and is the right tool for what it does: archive a
 * set of paths under one `cwd`. This is a different job. A track's media lives
 * across several storage LOCATION roots (`eventMedia` and whatever else the
 * operator relocated to), under paths that encode nothing a training set wants —
 * `101/events/track/<uuid>/keyFrame.jpg` — and every entry has to be RENAMED on
 * the way in, to `tracks/101/<trackId>/keyFrame.jpg`. `tar.create` takes a list
 * of paths relative to a single cwd and gives no rename hook, so using it would
 * mean staging a whole shadow tree on disk first: a full second copy of the
 * dataset, written and then deleted, to avoid writing 100 lines.
 *
 * So: ustar, which is a 512-byte header and a 512-byte-padded body per entry,
 * fully specified, and asserted against the system `tar` binary in the spec next
 * door rather than against my reading of the format.
 *
 * ## What this deliberately does NOT do
 *
 * No gzip — the payload is JPEG, already compressed; a gzip pass would burn CPU
 * on the hub for a percent or two. No long-name (GNU/PAX) extension: ustar
 * splits a path across a 155-byte prefix and a 100-byte name, and
 * {@link tarNameTooLong} reports a path that will not fit so the caller can skip
 * it and SAY it skipped it, rather than emitting a silently truncated entry.
 */

const BLOCK_SIZE = 512
const NAME_MAX = 100
const PREFIX_MAX = 155

/** One file in the archive. */
export interface TarEntry {
  /** Path inside the archive, `/`-separated, no leading slash. */
  readonly name: string
  readonly body: Buffer
  /** Modification time in ms since epoch. */
  readonly mtimeMs: number
}

/**
 * Split a path into the ustar `prefix` + `name` pair, or `null` when it cannot
 * be represented. The split must land on a `/`, and each half has its own cap.
 */
export function splitUstarName(name: string): { prefix: string; name: string } | null {
  if (Buffer.byteLength(name) <= NAME_MAX) return { prefix: '', name }
  // Prefer the LAST separator that leaves a representable tail, so the prefix
  // absorbs as much of the path as possible.
  for (let i = name.length - 1; i >= 0; i--) {
    if (name[i] !== '/') continue
    const head = name.slice(0, i)
    const tail = name.slice(i + 1)
    if (Buffer.byteLength(tail) > NAME_MAX) break
    if (Buffer.byteLength(head) <= PREFIX_MAX) return { prefix: head, name: tail }
  }
  return null
}

/** True when a path cannot be represented as a ustar entry name. */
export function tarNameTooLong(name: string): boolean {
  return splitUstarName(name) === null
}

function writeString(block: Buffer, value: string, offset: number, length: number): void {
  block.write(value.slice(0, length - 1), offset, length - 1, 'utf8')
}

/** ustar numeric field: zero-padded octal, NUL-terminated. */
function writeOctal(block: Buffer, value: number, offset: number, length: number): void {
  const text = Math.floor(value)
    .toString(8)
    .padStart(length - 1, '0')
  block.write(text.slice(-(length - 1)), offset, length - 1, 'ascii')
}

/**
 * The 512-byte header for one regular file.
 *
 * The checksum is computed with the checksum field itself read as eight spaces —
 * that is the format's rule, and getting it wrong produces an archive that looks
 * fine until something tries to read it.
 */
function tarHeader(entry: TarEntry): Buffer {
  const split = splitUstarName(entry.name)
  if (split === null) throw new Error(`tar: entry name too long for ustar: ${entry.name}`)
  const block = Buffer.alloc(BLOCK_SIZE)
  writeString(block, split.name, 0, NAME_MAX)
  writeOctal(block, 0o644, 100, 8) // mode
  writeOctal(block, 0, 108, 8) // uid
  writeOctal(block, 0, 116, 8) // gid
  writeOctal(block, entry.body.length, 124, 12) // size
  writeOctal(block, Math.floor(entry.mtimeMs / 1000), 136, 12)
  block.write('        ', 148, 8, 'ascii') // checksum placeholder
  block.write('0', 156, 1, 'ascii') // typeflag: regular file
  block.write('ustar\0', 257, 6, 'ascii')
  block.write('00', 263, 2, 'ascii')
  writeString(block, split.prefix, 345, PREFIX_MAX)

  let sum = 0
  for (const byte of block) sum += byte
  writeOctal(block, sum, 148, 7)
  block.write('\0', 154, 1, 'ascii')
  block.write(' ', 155, 1, 'ascii')
  return block
}

/** Zero padding that rounds a body up to the 512-byte block. */
function tarPadding(size: number): Buffer {
  const remainder = size % BLOCK_SIZE
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK_SIZE - remainder)
}

/** Header + body + padding for one entry, ready to write. */
export function tarBlocks(entry: TarEntry): readonly Buffer[] {
  return [tarHeader(entry), entry.body, tarPadding(entry.body.length)]
}

/** The two zero blocks that terminate an archive. */
export function tarTrailer(): Buffer {
  return Buffer.alloc(BLOCK_SIZE * 2)
}
