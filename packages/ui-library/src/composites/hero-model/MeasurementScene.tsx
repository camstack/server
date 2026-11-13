/**
 * The simple sensor's scene inside the layout-A hero card — drawn only for a
 * sensor that also has something to set (a plain sensor is the shared
 * `SensorCard`). The reading, its backdrop, the "since" and the trend are the
 * sensor card's own parts; this frame adds only the hero card's state corner.
 * Under `prefers-reduced-motion` the backdrop stands still (HERO_SCENE_CSS).
 */
import { type HeroMeasurement, isNotReported } from "@camstack/types";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { useUiText } from "../../contexts/ui-text";
import { cn } from "../../lib/cn";
import { Button } from "../../primitives/button";
import { measurementSinceText } from "../device-card/connected/measurement-since";
import { SensorTrend } from "../device-card/connected/SensorTrend";
import { ReadingValue } from "../device-card/parts/ReadingValue";
import { measurementVisual } from "../device-card/scenes/sensor/model";
import { SceneBackdrop } from "../hero-scene/backdrops";
import { HERO_SCENE_CSS } from "../hero-scene/hero-scene-css";
import { TONE_CLASS } from "../hero-scene/scene-map";
import { useCardDisplaySubject } from "./card-display-subject";
import { type HeroLang, pickText } from "./hero-model-view";
import { useMeasurementText } from "./measurement-display";

interface StateCornerProps {
  readonly measurement: HeroMeasurement;
  readonly lang: HeroLang;
  readonly onOpenHistory: (() => void) | undefined;
}

function StateCorner({
  measurement,
  lang,
  onOpenHistory,
}: StateCornerProps): ReactNode {
  const t = useUiText();
  const since = measurementSinceText(measurement, t);
  // Not reported yet: the value already reads "—"; the corner adds nothing.
  if (since === null && isNotReported(measurement.word)) return null;
  const text = (
    <>
      <span className="font-semibold uppercase tracking-wide">
        {pickText(measurement.word, lang)}
      </span>
      {since === null ? null : (
        <span className="font-normal text-foreground-muted">{` · ${since}`}</span>
      )}
    </>
  );
  return (
    <div
      data-testid="measurement-state"
      className="absolute left-2 top-2 z-20 text-xs"
    >
      {onOpenHistory === undefined ? (
        <span className="inline-flex px-2 py-1">{text}</span>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="h-auto gap-1 px-2 py-1 text-xs text-current"
          aria-label={t("uiLibrary.measurement.openHistory", "Open history")}
          onClick={onOpenHistory}
        >
          {text}
          <ChevronRight
            className="size-3.5 text-foreground-muted"
            aria-hidden
          />
        </Button>
      )}
    </div>
  );
}

export interface MeasurementSceneProps {
  readonly measurement: HeroMeasurement;
  readonly lang: HeroLang;
  readonly deviceId: number;
  /** Opens the device's history; absent = the state corner is only read and no trend is drawn. */
  readonly onOpenHistory?: () => void;
}

/**
 * The scene of a sensor that measures one thing. Tall and stacked in a narrow card;
 * in a wide one (the desktop page) lower, with the value and the trend side by side.
 */
export function MeasurementScene({
  measurement,
  lang,
  deviceId,
  onOpenHistory,
}: MeasurementSceneProps): ReactNode {
  const visual = measurementVisual(measurement);
  const text = useMeasurementText(measurement, lang, useCardDisplaySubject());
  return (
    <div
      data-testid="measurement-scene"
      data-quantity={measurement.quantity}
      data-band={measurement.band ?? undefined}
      className={cn(
        "@container relative w-full overflow-hidden rounded-xl border border-current/40 bg-surface/30",
        TONE_CLASS[measurement.tone],
      )}
    >
      <style>{HERO_SCENE_CSS}</style>
      {visual === null ? null : <SceneBackdrop visual={visual} />}
      <StateCorner
        measurement={measurement}
        lang={lang}
        onOpenHistory={onOpenHistory}
      />
      <div className="relative z-10 flex h-64 flex-col items-center justify-center gap-3 px-4 pt-6 @lg:h-48 @lg:flex-row @lg:gap-10">
        <ReadingValue
          icon={measurement.icon}
          value={text.value}
          unit={text.unit}
          text={measurement.quantity === "text"}
        />
        {measurement.historyKey === null ||
        measurement.reading === null ||
        onOpenHistory === undefined ? null : (
          <SensorTrend
            deviceId={deviceId}
            historyKey={measurement.historyKey}
            label={text.value}
            reading={measurement.reading}
          />
        )}
      </div>
    </div>
  );
}
