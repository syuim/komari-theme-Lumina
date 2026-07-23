import { useCallback, useMemo } from "react";
import { CanvasStrip, fillRoundedRect, resolveCssColor } from "./CanvasStrip";
import { latencyHeatColor } from "@/utils/metricTone";
import type { PingOverviewBucket } from "@/types/komari";

const ACTIVE_BAR_HEIGHT = 0.84;

interface MiniBarsProps {
  /** Aggregated latency buckets ordered oldest→newest. */
  buckets: PingOverviewBucket[];
  redrawKey?: string;
  onHoverIndex?: (index: number | null) => void;
}

/** Pixel-matched latency strip, visually aligned with the packet-loss strip. */
export function MiniBars({ buckets, redrawKey, onHoverIndex }: MiniBarsProps) {
  const bars = useMemo(
    () =>
      buckets.map((bucket) => ({
        bucket,
        hasValue: bucket.value != null,
        tone: latencyHeatColor(bucket.value),
      })),
    [buckets],
  );

  // draw / getHoverIndex 用 useCallback 固定身份：hover 引起的 render 不应重绘画布。
  const getHoverIndex = useCallback(
    (offsetX: number, width: number) => {
      if (bars.length === 0 || width <= 0) return null;
      const slotWidth = width / bars.length;
      const index = Math.max(0, Math.min(bars.length - 1, Math.floor(offsetX / slotWidth)));
      return bars[index]?.bucket.index ?? null;
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

      bars.forEach(({ hasValue, tone }, index) => {
        const x = index * (barWidth + gap);

        ctx.globalAlpha = hasValue ? 0.94 : 0.42;
        ctx.fillStyle = hasValue ? tone : inactiveColor;
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
