import type { BrokerLinkPorts } from '@camstack/types'

/** Link ports over nothing: for a spec that runs the catalogue without exercising the link migration. */
export const NO_LINK_PORTS: BrokerLinkPorts = {
  listBrokers: async () => [],
  readConnection: async () => null,
  putConnection: async () => undefined,
  clearBrokerLink: async () => undefined,
  warn: () => undefined,
}
