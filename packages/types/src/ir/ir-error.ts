/** Why an IR/RF codec refused an input. Callers branch on the code, never on the message. */
export type IrCodecErrorCode =
  | 'invalid-timings'
  | 'invalid-raw'
  | 'pronto-malformed'
  | 'pronto-unsupported-form'
  | 'smartir-malformed'

export class IrCodecError extends Error {
  readonly code: IrCodecErrorCode

  constructor(code: IrCodecErrorCode, message: string) {
    super(message)
    this.name = 'IrCodecError'
    this.code = code
  }
}
