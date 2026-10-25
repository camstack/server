/** Finding hubs on the LAN (D838) — shared by the CLI and the agent backend (D839). */
export {
  type DiscoverHubsDeps,
  discoverHubs,
  type HubCandidate,
  mergeCandidates,
  MDNS_SOURCE_LABEL,
  normalizeHubUrl,
  probeHttps,
  type RawCandidate,
} from './hub-candidates.js'
export {
  type BrowseOptions,
  browseHubsMdns,
  createRealMdnsSocket,
  hubsFromResponses,
  type MdnsHub,
  type MdnsRecord,
  type MdnsResponse,
  type MdnsSocket,
} from './mdns-browse.js'
export {
  type AgentMdnsState,
  agentsFromResponses,
  browseAgentsMdns,
  type MdnsAgent,
} from './agent-browse.js'
