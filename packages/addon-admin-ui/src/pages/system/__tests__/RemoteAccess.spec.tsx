// @vitest-environment jsdom
/**
 * Network → Remote Access is ONE instances table: the tunnel's state and its Start / Stop live in
 * the rows (instance rows and fixed rows), not in a card that lists the providers a second time.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  connected: new Set<string>(),
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("@camstack/ui-library", async (importOriginal) => {
  const real = await importOriginal<typeof import("@camstack/ui-library")>();
  return {
    ...real,
    useNetworkAccessGetStatus: ({ addonId }: { addonId: string }) => ({
      data: {
        connected: h.connected.has(addonId),
        endpoint: h.connected.has(addonId)
          ? {
              url: `https://${addonId}.example.com`,
              hostname: `${addonId}.example.com`,
              port: 443,
              protocol: "https",
            }
          : null,
      },
    }),
    useNetworkAccessStart: () => ({ mutate: h.start }),
    useNetworkAccessStop: () => ({ mutate: h.stop }),
  };
});

vi.mock("../../../components/instances/InstancesTable", () => ({
  InstancesTable: (props: {
    functionCap: string;
    extraColumns?: ReadonlyArray<{ render: (row: unknown) => ReactNode }>;
    rowActions?: (row: unknown) => ReactNode;
    fixedRowActions?: (row: unknown) => ReactNode;
  }) => (
    <div data-testid="table" data-cap={props.functionCap}>
      <div data-testid="instance-row">
        {props.extraColumns?.[0]?.render({
          kind: "instance",
          addonId: "cloudflare",
        })}
        {props.rowActions?.({ kind: "instance", addonId: "cloudflare" })}
      </div>
      <div data-testid="fixed-row">
        {props.extraColumns?.[0]?.render({ kind: "fixed", addonId: "ngrok" })}
        {props.fixedRowActions?.({ kind: "fixed", addonId: "ngrok" })}
      </div>
    </div>
  ),
}));

import { RemoteAccessPage } from "../RemoteAccess";

afterEach(() => {
  cleanup();
  h.connected.clear();
  h.start.mockClear();
  h.stop.mockClear();
});

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RemoteAccessPage />
    </QueryClientProvider>,
  );
}

describe("RemoteAccessPage", () => {
  it("is one network-access table with no second provider list", () => {
    renderPage();
    expect(screen.getByTestId("table").dataset.cap).toBe("network-access");
    expect(screen.queryByText("Tunnel control")).toBeNull();
  });

  it("starts a tunnel from an instance row and from a fixed row", () => {
    renderPage();
    const buttons = screen.getAllByRole("button", { name: "Start" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    fireEvent.click(buttons[1]!);
    expect(h.start).toHaveBeenNthCalledWith(1, { addonId: "cloudflare" });
    expect(h.start).toHaveBeenNthCalledWith(2, { addonId: "ngrok" });
  });

  it("shows Stop, Connected and the endpoint for a connected tunnel", () => {
    h.connected.add("cloudflare");
    renderPage();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(h.stop).toHaveBeenCalledWith({ addonId: "cloudflare" });
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Disconnected")).toBeTruthy();
    expect(screen.getByText("https://cloudflare.example.com")).toBeTruthy();
  });
});
