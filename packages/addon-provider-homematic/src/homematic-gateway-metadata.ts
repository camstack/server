/** What the CCU box is known by, as device metadata (a CCU announces no model or firmware over XML-RPC). */
export function gatewayMetadataPatch(input: { readonly host: string }): Record<string, string> {
  return {
    manufacturer: 'eQ-3',
    model: 'CCU3 / RaspberryMatic',
    ip: input.host,
  }
}
