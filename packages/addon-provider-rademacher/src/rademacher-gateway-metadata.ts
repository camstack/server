/** What the hub box reports about itself, as device metadata. */
export function gatewayMetadataPatch(input: {
  readonly host: string
  readonly model: string | null
  readonly firmware: string | null
  readonly mac: string | null
}): Record<string, string> {
  return {
    manufacturer: 'Rademacher',
    model: input.model ?? 'HomePilot',
    ip: input.host,
    ...(input.firmware === null ? {} : { firmware: input.firmware }),
    ...(input.mac === null ? {} : { mac: input.mac }),
  }
}
