/**
 * The helper binary is part of the published addon, and it speaks the
 * protocol this addon parses.
 *
 * The package half runs everywhere: `files` must ship the binary, and the
 * committed binary must have been built from the committed source (the stamp
 * `scripts/build-afm.mjs` writes) — a Swift edit without a rebuild would ship
 * the old helper under the new source.
 *
 * The protocol half runs only on darwin, against the REAL binary: a probe
 * whose answer the cap schema accepts, and the JSON-Schema mapper refusing
 * what it cannot enforce. Neither calls the model, so it runs on any Mac
 * whatever its Apple Intelligence state.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { AppleFmAvailabilitySchema } from '@camstack/types'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AppleFmHelper } from '../runtime/apple/afm-helper.js'
import { AfmProbeReplySchema } from '../runtime/apple/afm-protocol.js'
import { makeTestLogger } from './support/logger.js'

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..')
const NATIVE = path.join(PACKAGE_ROOT, 'native', 'afm')
const BINARY = path.join(NATIVE, 'camstack-afm')

const PackageJsonSchema = z.object({ files: z.array(z.string()) }).loose()
const PackResultSchema = z.array(
  z.object({ files: z.array(z.object({ path: z.string(), mode: z.number() })) }).loose(),
)

describe('camstack-afm packaging', () => {
  it('the published files include the helper binary', () => {
    const pkg = PackageJsonSchema.parse(
      JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')),
    )
    expect(pkg.files).toContain('native/afm/camstack-afm')
  })

  it('the committed binary was built from the committed source — both halves stamped', () => {
    const sha = (file: string): string =>
      createHash('sha256')
        .update(readFileSync(path.join(NATIVE, file)))
        .digest('hex')
    const stamp = (file: string): string => readFileSync(path.join(NATIVE, file), 'utf8').trim()
    expect(stamp('camstack-afm.source-sha256')).toBe(sha('camstack-afm.swift'))
    // The binary is bound too: a hand-copied or stale binary fails here even
    // when the source and its stamp agree.
    expect(stamp('camstack-afm.binary-sha256')).toBe(sha('camstack-afm'))
  })

  it('the PACKED tarball carries the binary, executable', () => {
    // What `camstack deploy` and `npm publish` actually ship — `files` in
    // package.json is only the intent. `--ignore-scripts` keeps it a read.
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
    })
    const packed = PackResultSchema.parse(JSON.parse(out))
    const entry = packed[0]?.files.find((f) => f.path === 'native/afm/camstack-afm')
    expect(entry, 'native/afm/camstack-afm is not in the packed tarball').toBeDefined()
    expect((entry?.mode ?? 0) & 0o777).toBe(0o755)
  }, 60_000)

  it('the binary is an arm64 Mach-O executable', () => {
    const head = readFileSync(BINARY).subarray(0, 8)
    // MH_MAGIC_64 (little-endian) + CPU_TYPE_ARM64.
    expect(head.readUInt32LE(0)).toBe(0xfeedfacf)
    expect(head.readUInt32LE(4)).toBe(0x0100000c)
  })
})

describe.runIf(process.platform === 'darwin')('camstack-afm protocol (real binary)', () => {
  const helper = new AppleFmHelper({ binaryPath: BINARY, logger: makeTestLogger() })
  afterAll(() => helper.dispose())

  it('answers a probe the cap schema accepts', async () => {
    const outcome = await helper.request({ op: 'probe' }, { timeoutMs: 15_000 })
    expect(outcome.kind).toBe('reply')
    if (outcome.kind !== 'reply') return
    const reply = AfmProbeReplySchema.parse(outcome.reply)
    expect(AppleFmAvailabilitySchema.safeParse(reply.availability).success).toBe(true)
    expect(reply.protocol).toBe(1)
  })

  it('maps the notification-gate schema and REFUSES a constraint it cannot enforce', async () => {
    const gate = await helper.request(
      {
        op: 'checkSchema',
        jsonSchema: {
          type: 'object',
          properties: {
            confirmed: { type: 'boolean' },
            count: { type: 'integer', minimum: 0 },
            reason: { type: 'string' },
            tags: { type: 'array', items: { enum: ['a', 'b'] }, maxItems: 2 },
          },
          required: ['confirmed', 'count', 'reason'],
        },
      },
      { timeoutMs: 15_000 },
    )
    expect(gate).toMatchObject({ kind: 'reply', reply: { ok: true } })

    const refused = await helper.request(
      { op: 'checkSchema', jsonSchema: { type: 'string', maxLength: 40 } },
      { timeoutMs: 15_000 },
    )
    expect(refused).toMatchObject({ kind: 'reply', reply: { ok: false, code: 'bad-request' } })
  })
})
