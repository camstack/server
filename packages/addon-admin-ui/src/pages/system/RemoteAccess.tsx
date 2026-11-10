/**
 * Remote Access — the `network-access` providers registered on the hub
 * (Cloudflare Tunnel, ngrok, Tailscale Funnel, …), one table.
 *
 * A `<InstancesTable>` over `network-access` (Network → Remote Access): a provider that
 * keeps `integration-instances` records (Cloudflare Tunnel) is a row per record, edited in the
 * table's dialog; one without is a fixed row. The Enable switch, Restart and the activity stream
 * are the table's. What is remote-access-specific lives IN the rows, not beside them:
 *   • a Tunnel column: Connected / Disconnected, the endpoint link and the last start/stop error;
 *   • a Start / Stop row action, on instance rows and on fixed rows alike.
 */
import { useState, type ReactElement } from "react";
import { ExternalLink, Globe, Loader2, Play, Square } from "lucide-react";
import {
  Badge,
  IconButton,
  useNetworkAccessGetStatus,
  useNetworkAccessStart,
  useNetworkAccessStop,
  type DataColumn,
} from "@camstack/ui-library";
import { NetworkAccessStatusSchema } from "@camstack/types";
import type { NetworkAccessStatus } from "@camstack/types";
import { useQueryClient } from "@tanstack/react-query";
import { STATUS_BADGE_CLASS } from "../../components/integration-hub/addon-controls";
import { InstancesTable } from "../../components/instances/InstancesTable";
import type { PanelRow } from "../../components/instances/instances-model";
import { useTranslation } from "react-i18next";

const STATUS_POLL_INTERVAL_MS = 5_000;
const CAPABILITY = "network-access";

/**
 * Input shape React-Query hands to a collection-cap mutation callback.
 * Codegen makes the whole `{ nodeId?, addonId? }` object optional, so
 * the variables may also be `void` / `undefined`.
 */
type MutationVariables =
  { readonly nodeId?: string; readonly addonId?: string } | void | undefined;

const EMPTY_STATUS: NetworkAccessStatus = {
  connected: false,
  endpoint: null,
};

export function RemoteAccessPage(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  // Per-provider error state. Surfaces start/stop failures in the row so the
  // operator sees WHY a tunnel didn't come up (e.g.
  // tailscale-ingress's "tailnet not joined — open Mesh Networks…").
  const [errorByAddon, setErrorByAddon] = useState<Record<string, string>>({});

  // The codegen'd collection-cap mutations accept an optional
  // `{ nodeId?, addonId? }` input, so React-Query types `variables` as
  // `void | { nodeId?, addonId? } | undefined`. Narrow it here.
  const onSuccess = (_data: unknown, variables: MutationVariables) => {
    // Invalidate ONLY the mutated provider's status query: a bare
    // `[['networkAccess']]` prefix matched every `getStatus` query in the cache, so starting one
    // tunnel force-refetched every row's status at once. Sibling rows keep their own 5 s poll.
    const addonId = variables?.addonId;
    queryClient.invalidateQueries({
      queryKey: [
        ["networkAccess", "getStatus"],
        { input: { addonId }, type: "query" as const },
      ],
    });
    setBusyId(null);
    setErrorByAddon((prev) => {
      if (addonId === undefined || !(addonId in prev)) return prev;
      const next = { ...prev };
      delete next[addonId];
      return next;
    });
  };

  const onError = (err: unknown, variables: MutationVariables) => {
    setBusyId(null);
    const addonId = variables?.addonId;
    if (addonId === undefined) return;
    const message = err instanceof Error ? err.message : String(err);
    setErrorByAddon((prev) => ({ ...prev, [addonId]: message }));
  };

  const startMutation = useNetworkAccessStart({ onSuccess, onError });
  const stopMutation = useNetworkAccessStop({ onSuccess, onError });

  const tunnelColumn: DataColumn<PanelRow> = {
    key: "tunnel",
    header: t("system.remoteAccess.colTunnel", "Tunnel"),
    notSortableReason: t(
      "system.remoteAccess.tunnelNotSortable",
      "A live connection state is not a value to order by.",
    ),
    render: (row) => (
      <TunnelStatusCell
        addonId={row.addonId}
        error={errorByAddon[row.addonId]}
      />
    ),
  };

  const lifecycle = (addonId: string): ReactElement => (
    <TunnelLifecycleButton
      addonId={addonId}
      busyId={busyId}
      onStart={(id) => {
        setBusyId(id);
        startMutation.mutate({ addonId: id });
      }}
      onStop={(id) => {
        setBusyId(id);
        stopMutation.mutate({ addonId: id });
      }}
    />
  );

  return (
    <InstancesTable
      functionCap={CAPABILITY}
      icon={Globe}
      title={t("system.remoteAccess.remoteAccess2", "Remote Access")}
      subtitle={t(
        "system.remoteAccess.publicFacingTunnelsThatExpose",
        "Public-facing tunnels that expose this hub to the internet (Cloudflare Tunnel, ngrok, …).",
      )}
      emptyTitle={t(
        "system.remoteAccess.noRemoteAccessProvidersInstalled",
        "No remote-access providers installed",
      )}
      emptyDescription={t(
        "system.remoteAccess.installATunnelAddonE",
        "Install a tunnel addon (e.g. @camstack/addon-cloudflare) to expose this hub publicly.",
      )}
      addLabel={t("system.remoteAccess.addTunnel", "Add tunnel")}
      extraColumns={[tunnelColumn]}
      rowActions={(row) => lifecycle(row.addonId)}
      fixedRowActions={(row) => lifecycle(row.addonId)}
    />
  );
}

/**
 * Live status of one provider, validated against
 * `NetworkAccessStatusSchema`. `getStatus`'s codegen'd wire output is
 * `unknown`; the safeParse keeps a typed value without a cast. Cold
 * start falls back to `EMPTY_STATUS`.
 */
function useNetworkAccessStatus(addonId: string): NetworkAccessStatus {
  const { data } = useNetworkAccessGetStatus(
    { addonId },
    { refetchInterval: STATUS_POLL_INTERVAL_MS, retry: false },
  );
  const parsed = data ? NetworkAccessStatusSchema.safeParse(data) : null;
  return parsed?.success ? parsed.data : EMPTY_STATUS;
}

// ── Tunnel column (Connected / endpoint link / last error) ──────────

function TunnelStatusCell({
  addonId,
  error,
}: {
  readonly addonId: string;
  readonly error: string | undefined;
}): ReactElement {
  const { t } = useTranslation();
  const status = useNetworkAccessStatus(addonId);
  return (
    <span className="flex flex-col items-start gap-1">
      <Badge
        variant={status.connected ? "success" : "default"}
        className={STATUS_BADGE_CLASS}
      >
        {status.connected
          ? t("system.remoteAccess.connected", "Connected")
          : t("system.remoteAccess.disconnected", "Disconnected")}
      </Badge>
      {status.endpoint && (
        <a
          href={status.endpoint.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-w-0 items-center gap-1 break-all text-[11px] text-success hover:underline"
        >
          <ExternalLink className="h-3 w-3" />
          {status.endpoint.url}
        </a>
      )}
      {error !== undefined && (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
    </span>
  );
}

// ── Row action (Start / Stop) ───────────────────────────────────────

interface TunnelLifecycleButtonProps {
  readonly addonId: string;
  readonly busyId: string | null;
  readonly onStart: (addonId: string) => void;
  readonly onStop: (addonId: string) => void;
}

/**
 * The page-specific lifecycle action. The provider's live `connected` state (queried via
 * `networkAccess.getStatus({ addonId })`) drives whether Start or Stop is shown.
 */
function TunnelLifecycleButton({
  addonId,
  busyId,
  onStart,
  onStop,
}: TunnelLifecycleButtonProps): ReactElement {
  const { t } = useTranslation();
  const status = useNetworkAccessStatus(addonId);
  const isBusy = busyId === addonId;
  return status.connected ? (
    <IconButton
      icon={isBusy ? Loader2 : Square}
      variant="ghost"
      size="sm"
      aria-label={t("system.remoteAccess.stop", "Stop")}
      disabled={isBusy}
      onClick={() => onStop(addonId)}
    />
  ) : (
    <IconButton
      icon={isBusy ? Loader2 : Play}
      variant="ghost"
      size="sm"
      aria-label={t("system.remoteAccess.start", "Start")}
      disabled={isBusy}
      onClick={() => onStart(addonId)}
    />
  );
}
