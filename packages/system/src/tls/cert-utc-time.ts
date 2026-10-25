/**
 * `@peculiar/asn1-x509` `Time` zeroes the sub-second field with
 * `Date#setMilliseconds`. That setter rebuilds the instant from the local
 * wall clock. On a DST fall-back the repeated hour is ambiguous, and the
 * instant is stored one hour early: a leaf's span grows by that hour and can
 * pass the browsers' 397-day cap, and a mesh CA's `notBefore` moves into the
 * past. X.509 UTCTime is UTC.
 *
 * Validity is built only after `create` awaits the SPKI export, so the UTC
 * setter has to stay in place until the generator's promise settles. A depth
 * count keeps a second issuance, started while the first is still signing,
 * from restoring the local setter early — or from leaving the UTC setter in
 * place after the last one finishes.
 */
type DateSetMilliseconds = (this: Date, ms: number) => number

let encodingDepth = 0
let localSetMilliseconds: DateSetMilliseconds | undefined

function setMillisecondsAsUtc(this: Date, ms: number): number {
  return this.setUTCMilliseconds(ms)
}

export async function withUtcTimeEncoding<T>(encode: () => T | Promise<T>): Promise<T> {
  if (encodingDepth === 0) {
    localSetMilliseconds = Date.prototype.setMilliseconds
    Date.prototype.setMilliseconds = setMillisecondsAsUtc
  }
  encodingDepth += 1
  try {
    return await encode()
  } finally {
    encodingDepth -= 1
    if (encodingDepth === 0 && localSetMilliseconds !== undefined) {
      Date.prototype.setMilliseconds = localSetMilliseconds
      localSetMilliseconds = undefined
    }
  }
}
