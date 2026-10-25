import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { RtpHeader, SrtpSession } from 'werift'

/**
 * SRTP protection is the bytes on the wire. `patches/werift+0.22.9.patch`
 * (D868) makes werift write header, ciphertext and tag into one arena slice
 * instead of allocating a header and concatenating three buffers; the digests
 * below were recorded from the UNPATCHED werift@0.22.9, with the same keys and
 * sequence, so a patch that moved one byte fails here.
 *
 * The fixture covers rollover (sequence 65000 -> wrap), a timestamp wrap, one-
 * byte header extensions, a CSRC, the marker bit, and payload sizes 1..1380.
 */

const FIXTURE_PACKETS = 400
const AES_128_CM_HMAC_SHA1_80 = 1
const AEAD_AES_128_GCM = 7

const GOLDEN = {
  [AES_128_CM_HMAC_SHA1_80]: {
    digest: '5d88255652cb953be5725b9ee804f159dd58278b750239e956c1279b90d99559',
    first: '91e0fde8fffffed811223344deadbeefbede00021030320102030000a4a176280965133d461ebb',
  },
  [AEAD_AES_128_GCM]: {
    digest: '31552cb0c6123504139c899cb44d9b72abeb52754baf8e665f05d56437062e69',
    first:
      '91e0fde8fffffed811223344deadbeefbede00021030320102030000a07ad4370cf5320baa15a273993409eae8',
  },
} as const

interface Run {
  readonly digest: string
  readonly first: string
}

function run(profile: typeof AES_128_CM_HMAC_SHA1_80 | typeof AEAD_AES_128_GCM): Run {
  const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')
  const saltLength = profile === AEAD_AES_128_GCM ? 12 : 14
  const salt = Buffer.alloc(saltLength)
  for (let i = 0; i < saltLength; i++) salt[i] = 0xa0 + i
  const session = new SrtpSession({
    profile,
    keys: {
      localMasterKey: key,
      localMasterSalt: salt,
      remoteMasterKey: key,
      remoteMasterSalt: salt,
    },
  })
  const hash = createHash('sha256')
  let first = ''
  for (let i = 0; i < FIXTURE_PACKETS; i++) {
    const header = new RtpHeader({
      payloadType: 96,
      sequenceNumber: (65000 + i) & 0xffff,
      timestamp: (4294967000 + i * 3000) >>> 0,
      ssrc: 0x11223344,
      marker: i % 7 === 0,
    })
    if (i % 3 === 0) {
      header.extensions = [
        { id: 1, payload: Buffer.from('0') },
        { id: 3, payload: Buffer.from([1, 2, 3]) },
      ]
    }
    if (i % 11 === 0) header.csrc = [0xdeadbeef]
    const payload = Buffer.alloc(1 + ((i * 37) % 1380), i & 0xff)
    const encrypted = session.encrypt(payload, header)
    if (i === 0) first = Buffer.from(encrypted).toString('hex')
    hash.update(encrypted)
  }
  return { digest: hash.digest('hex'), first }
}

describe('SRTP output of the patched werift', () => {
  it.each([
    ['AES-128-CM / HMAC-SHA1-80', AES_128_CM_HMAC_SHA1_80],
    ['AEAD AES-128-GCM', AEAD_AES_128_GCM],
  ] as const)('%s is byte-identical to the published werift', (_name, profile) => {
    const result = run(profile)
    expect(result.first).toBe(GOLDEN[profile].first)
    expect(result.digest).toBe(GOLDEN[profile].digest)
  })

  it('encrypts into arena slices: no header alloc and no concat per packet', () => {
    const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')
    const salt = Buffer.alloc(12, 0xa5)
    const session = new SrtpSession({
      profile: AEAD_AES_128_GCM,
      keys: {
        localMasterKey: key,
        localMasterSalt: salt,
        remoteMasterKey: key,
        remoteMasterSalt: salt,
      },
    })
    const header = new RtpHeader({ payloadType: 96, sequenceNumber: 1, timestamp: 1, ssrc: 7 })
    const payload = Buffer.alloc(1200, 1)
    const allocSpy = vi.spyOn(Buffer, 'alloc')
    const concatSpy = vi.spyOn(Buffer, 'concat')
    try {
      for (let i = 0; i < 50; i++) {
        header.sequenceNumber = i + 1
        session.encrypt(payload, header)
      }
      expect({ alloc: allocSpy.mock.calls.length, concat: concatSpy.mock.calls.length }).toEqual({
        alloc: 0,
        concat: 0,
      })
    } finally {
      allocSpy.mockRestore()
      concatSpy.mockRestore()
    }
  })
})
