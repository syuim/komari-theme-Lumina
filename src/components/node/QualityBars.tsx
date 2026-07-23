import { useCallback, useMemo } from "react";
import { CanvasStrip, fillRoundedRect, resolveCssColor } from "./CanvasStrip";
import { lossHeatColor } from "@/utils/metricTone";
import type { PingOverviewBucket } from "@/types/komari";

const ACTIVE_BAR_HEIGHT = 0.84;

interface QualityBarsProps {
  value: number | null | undefined;
  count?: number;
  buckets?: PingOverviewBucket[];
  redrawKey?: string;
  onHoverIndex?: (index: number | null) => void;
}

export function QualityBars({
  value,
  count,
  buckets,
  redrawKey,
  onHoverIndex,
}: QualityBarsProps) {
  const hasValue = value != null && Number.isFinite(value);
  const resolvedCount = count ?? Math.max(1, buckets?.length ?? 24);

  const bars = useMemo(
    () => {
      const fallbackTone = hasValue ? lossHeatColor(value) : "var(--progress-bg)";
      return Array.from({ length: resolvedCount }, (_, index) => {
        const bucket = buckets?.[index] ?? null;
        const bucketLoss = bucket?.loss;
        const hasBucketValue =
          bucketLoss != null &&
          Number.isFinite(bucketLoss) &&
          (bucket?.total ?? 0) > 0;
        const loss = hasBucketValue ? bucketLoss : null;
        const active = hasBucketValue || (!buckets?.length && hasValue);
        const tone = hasBucketValue ? lossHeatColor(loss) : fallbackTone;

        return {
          active,
          bucket,
          tone,
        };
      });
    },
    [buckets, hasValue, resolvedCount, value],
  );

  // draw / getHoverIndex 用 useCallback 固定身份：hover 引起的 render 不应重绘画布。
  const getHoverIndex = useCallback(
    (offsetX: number, width: number) => {
      if (bars.length === 0 || width <= 0) return null;
      const slotWidth = width / bars.length;
      const index = Math.max(0, Math.min(bars.length - 1, Math.floor(offsetX / slotWidth)));
      const bar = bars[index];
      return bar?.bucket?.index ?? (bar?.active ? index : null);
    },
    [bars],
  );

  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, width: number, height: number) => {
      const inactiveColor = resolveCssColor("var(--progress-bg)");
      const gap = bars.length > 48 ? 1 : 2;
      const barWidth = Math.max(1, (width - gap * (bars.length - 1)) / Math.max(1, bars.length));
      const barHeight = height * ACTIVE_BAR_HEIGHT;
      const y = height - barHeight;

      bars.forEach(({ active, tone }, index) => {
        const x = index * (barWidth + gap);
        ctx.globalAlpha = active ? 0.94 : 0.42;
        ctx.fillStyle = active ? tone : inactiveColor;
        fillRoundedRect(ctx, x, y, barWidth, barHeight, 2);
      });

      ctx.globalAlpha = 1;
    },
    [bars],
  );

  return (
    <CanvasStrip
      className="mini-bar-row"
      height={16}
      ariaHidden
      redrawKey={redrawKey}
      getHoverIndex={getHoverIndex}
      onHoverIndex={onHoverIndex}
      draw={draw}
    />
  );
}
