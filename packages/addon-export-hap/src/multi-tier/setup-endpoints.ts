/**
 * The `Setup Endpoints` exchange, for the multi-tier RTP service.
 *
 * § 3.6 lists this characteristic among the service's required ones and does
 * NOT redefine it: it is R17's, byte for byte, and hap-nodejs already speaks it
 * on the classic service. The types below are transcribed from that
 * implementation rather than guessed, and the spec file decodes what this
 * encodes with the same library — a transcription error is otherwise entirely
 * plausible on review.
 *
 * Nothing here talks to a socket. The bytes are the part a test can hold still;
 * the adapter that drives the streaming engine is a separate file for exactly
 * that reason.
 */
import { decode, encode, uuid } from '@homebridge/hap-nodejs'

/** Top-level TLV types of the controller's WRITE. */
enum RequestTlv {
  SESSION_ID = 0x01,
  CONTROLLER_ADDRESS = 0x03,
  VIDEO_SRTP_PARAMETERS = 0x04,
  AUDIO_SRTP_PARAMETERS = 0x05,
}

/** Top-level TLV types of the accessory's READ value. */
enum ResponseTlv {
  SESSION_ID = 0x01,
  STATUS = 0x02,
  ACCESSORY_ADDRESS = 0x03,
  VIDEO_SRTP_PARAMETERS = 0x04,
  AUDIO_SRTP_PARAMETERS = 0x05,
  VIDEO_SSRC = 0x06,
  AUDIO_SSRC = 0x07,
}

enum AddressTlv {
  ADDRESS_VERSION = 0x01,
  ADDRESS = 0x02,
  VIDEO_RTP_PORT = 0x03,
  AUDIO_RTP_PORT = 0x04,
}

enum SrtpTlv {
  CRYPTO_SUITE = 0x01,
  MASTER_KEY = 0x02,
  MASTER_SALT = 0x03,
}

export enum SetupEndpointsStatus {
  SUCCESS = 0,
  BUSY = 1,
  ERROR = 2,
}

export interface SrtpParameters {
  readonly cryptoSuite: number
  readonly key: Buffer
  readonly salt: Buffer
}

export interface SetupEndpointsRequest {
  readonly sessionId: string
  readonly addressVersion: 'ipv4' | 'ipv6'
  readonly controllerAddress: string
  readonly videoPort: number
  readonly audioPort: number
  readonly videoSrtp: SrtpParameters
  readonly audioSrtp: SrtpParameters
}

export interface SetupEndpointsResponse {
  readonly sessionId: string
  readonly addressVersion: 'ipv4' | 'ipv6'
  readonly accessoryAddress: string
  readonly videoPort: number
  readonly audioPort: number
  readonly videoSrtp: { readonly key: Buffer; readonly salt: Buffer }
  readonly audioSrtp: { readonly key: Buffer; readonly salt: Buffer }
  readonly videoSsrc: number
  readonly audioSsrc: number
}

/**
 * Read a TLV field that must be present, naming it when it is not.
 *
 * A controller's bytes really can be short, and the refusal we send back has to
 * carry a reason — "undefined is not an object", thrown three frames away in
 * the socket code, is not one.
 */
function required(map: Record<string, Buffer | undefined>, type: number, what: string): Buffer {
  const value = map[String(type)]
  if (value === undefined) {
    throw new Error(`setup-endpoints: ${what} is missing from the controller's write`)
  }
  return value
}

function uint16(value: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(value, 0)
  return b
}

function uint32(value: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(value, 0)
  return b
}

function decodeSrtp(payload: Buffer, what: string): SrtpParameters {
  const map = decode(payload)
  return {
    cryptoSuite: required(map, SrtpTlv.CRYPTO_SUITE, `${what} crypto suite`).readUInt8(0),
    key: required(map, SrtpTlv.MASTER_KEY, `${what} master key`),
    salt: required(map, SrtpTlv.MASTER_SALT, `${what} master salt`),
  }
}

export function decodeSetupEndpointsRequest(base64: string): SetupEndpointsRequest {
  const map = decode(Buffer.from(base64, 'base64'))
  const address = decode(required(map, RequestTlv.CONTROLLER_ADDRESS, 'the controller address'))
  return {
    sessionId: uuid.unparse(required(map, RequestTlv.SESSION_ID, 'the session id')),
    addressVersion:
      required(address, AddressTlv.ADDRESS_VERSION, 'the address version').readUInt8(0) === 0
        ? 'ipv4'
        : 'ipv6',
    controllerAddress: required(address, AddressTlv.ADDRESS, 'the address').toString('utf8'),
    videoPort: required(address, AddressTlv.VIDEO_RTP_PORT, 'the video port').readUInt16LE(0),
    audioPort: required(address, AddressTlv.AUDIO_RTP_PORT, 'the audio port').readUInt16LE(0),
    videoSrtp: decodeSrtp(
      required(map, RequestTlv.VIDEO_SRTP_PARAMETERS, 'the video srtp parameters'),
      'video',
    ),
    audioSrtp: decodeSrtp(
      required(map, RequestTlv.AUDIO_SRTP_PARAMETERS, 'the audio srtp parameters'),
      'audio',
    ),
  }
}

export function encodeSetupEndpointsResponse(response: SetupEndpointsResponse): string {
  const address = encode(
    AddressTlv.ADDRESS_VERSION,
    Buffer.from([response.addressVersion === 'ipv4' ? 0 : 1]),
    AddressTlv.ADDRESS,
    Buffer.from(response.accessoryAddress, 'utf8'),
    AddressTlv.VIDEO_RTP_PORT,
    uint16(response.videoPort),
    AddressTlv.AUDIO_RTP_PORT,
    uint16(response.audioPort),
  )
  // § 3.6: "Supported RTP Configuration must be set to AES_CM_128_HMAC_SHA1_80",
  // which is suite 0 — the only one we declare, so the only one we echo.
  const srtp = (params: { key: Buffer; salt: Buffer }): Buffer =>
    encode(
      SrtpTlv.CRYPTO_SUITE,
      Buffer.from([0]),
      SrtpTlv.MASTER_KEY,
      params.key,
      SrtpTlv.MASTER_SALT,
      params.salt,
    )
  return encode(
    ResponseTlv.SESSION_ID,
    uuid.write(response.sessionId),
    ResponseTlv.STATUS,
    Buffer.from([SetupEndpointsStatus.SUCCESS]),
    ResponseTlv.ACCESSORY_ADDRESS,
    address,
    ResponseTlv.VIDEO_SRTP_PARAMETERS,
    srtp(response.videoSrtp),
    ResponseTlv.AUDIO_SRTP_PARAMETERS,
    srtp(response.audioSrtp),
    ResponseTlv.VIDEO_SSRC,
    uint32(response.videoSsrc),
    ResponseTlv.AUDIO_SSRC,
    uint32(response.audioSsrc),
  ).toString('base64')
}

/**
 * A refusal: STATUS and nothing else, which is exactly what the classic
 * service writes. Not even the session id — matching it byte for byte means a
 * controller parses our refusal with the code it already has.
 */
export function encodeSetupEndpointsRefusal(status: SetupEndpointsStatus): string {
  return encode(ResponseTlv.STATUS, Buffer.from([status])).toString('base64')
}
