/** What the gateway box reports about itself, as device metadata. */
export function gatewayMetadataPatch(input: {
  readonly host: string
  readonly firmware: string | null
}): Record<string, string> {
  return {
    manufacturer: 'Velux',
    model: 'KLF-200',
    ip: input.host,
    ...(input.firmware === null ? {} : { firmware: input.firmware }),
  }
}
