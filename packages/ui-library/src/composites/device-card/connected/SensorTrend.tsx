import type { HeroMeasurementReading } from "@camstack/types";
import { type ReactElement, useMemo } from "react";
import { useUnitPreferences } from "../../../contexts/unit-preferences";
import { preferenceForQuantity } from "../../../lib/unit-preferences";
import { Sparkline, type SparklinePoint } from "../../charts/Sparkline";
import { HISTORY_WINDOW_MS } from "../../device-history/history-window";
import { useHistoryReads } from "../../device-history/use-device-history";

const MINUTE_MS = 60_000;

/** The fewest points a trend line is drawn from: one point is not a trend. */
export const TREND_MIN_POINTS = 2;

export interface SensorTrendProps {
  readonly deviceId: number;
  /** The history series (`cap:<cap>.<field>`). */
  readonly historyKey: string;
  readonly label: string;
  /** The series is in this reading's base unit; the tooltip converts it like the value. */
  readonly reading: HeroMeasurementReading;
}

/** The last day of a sensor's reading; nothing until the read answers with a line. */
export function SensorTrend({
  deviceId,
  historyKey,
  label,
  reading,
}: SensorTrendProps): ReactElement | null {
  const unitPreferences = useUnitPreferences();
  const window = useMemo(() => {
    const to = Math.ceil(Date.now() / MINUTE_MS) * MINUTE_MS;
    return { from: to - HISTORY_WINDOW_MS["24h"], to };
  }, []);
  const items = useMemo(
    () => [{ deviceId, key: historyKey }],
    [deviceId, historyKey],
  );
  const reads = useHistoryReads(items, window, false);
  if (reads.status !== "ok") return null;
  const entry = [...reads.data.current.values()][0];
  if (entry === undefined || !entry.ok) return null;
  const points: SparklinePoint[] = (entry.result.series[0]?.points ?? []).map(
    (p) => ({
      x: p.t,
      v: p.mean ?? p.last,
    }),
  );
  if (points.filter((p) => p.v !== null).length < TREND_MIN_POINTS) return null;
  return (
    <span data-testid="dc-sensor-trend" className="flex justify-center">
      <Sparkline
        points={points}
        ariaLabel={label}
        token="primary"
        quantity={reading.quantity}
        displayPreference={preferenceForQuantity(
          unitPreferences,
          reading.quantity,
        )}
        zeroBased={false}
        height={36}
        widthClassName="w-48 @lg:w-64"
      />
    </span>
  );
}
