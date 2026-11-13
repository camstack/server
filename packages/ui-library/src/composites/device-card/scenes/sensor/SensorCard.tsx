import type { ReactElement, ReactNode } from "react";
import { cn } from "../../../../lib/cn";
import { MeasurementFx } from "../../illustrations/MeasurementFx";
import { ReadingValue } from "../../parts/ReadingValue";
import { DeviceCard } from "../../shell/DeviceCard";
import type { CardCommonActions, CardOrientation } from "../../shell/model";
import { cardToneClass } from "../../shell/Corner";
import type { SensorCardModel } from "./model";

export interface SensorCardProps {
  readonly model: SensorCardModel;
  readonly actions?: CardCommonActions;
  readonly orientation?: CardOrientation;
  readonly showName?: boolean;
  /** The last day of the reading, under it (beside it when horizontal); absent = none. */
  readonly trend?: ReactNode;
}

/**
 * A sensor that measures one thing: the value once, big, inside the scene,
 * with its quantity's icon and the backdrop behind. No rows under it repeat
 * the value; the state corner opens the history.
 */
export function SensorCard({
  model,
  actions,
  orientation = "vertical",
  showName = true,
  trend = null,
}: SensorCardProps): ReactElement {
  const { reading, visual } = model;
  const horizontal = orientation === "horizontal";
  return (
    <DeviceCard
      kind="sensor"
      common={model.common}
      orientation={orientation}
      showName={showName}
      state={model.state}
      activity={reading.quantity}
      {...(actions === undefined ? {} : { actions })}
      scene={{
        fx: visual === null ? null : <MeasurementFx visual={visual} />,
        image: (
          <div
            data-testid="dc-sensor"
            data-quantity={reading.quantity}
            className={cn(
              "flex w-full flex-col items-center justify-center gap-3",
              horizontal ? "min-h-32 sm:flex-row sm:gap-10" : "min-h-56",
              cardToneClass(model.state.tone),
            )}
          >
            <ReadingValue
              icon={reading.icon}
              value={reading.value}
              unit={reading.unit}
              text={
                reading.quantity === "text" || reading.quantity === "contact"
              }
            />
            {trend}
          </div>
        ),
      }}
    />
  );
}
