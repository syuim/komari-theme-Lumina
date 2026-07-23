import { useCallback, useEffect, useRef, useState } from "react";
import type uPlot from "uplot";

export interface TimeRangeOption {
  label: string;
  value: number;
}

export const LOAD_TIME_RANGE_OPTIONS: TimeRangeOption[] = [
  { label: "1 小时", value: 1 },
  { label: "4 小时", value: 4 },
  { label: "1 天", value: 24 },
  { label: "7 天", value: 168 },
  { label: "30 天", value: 720 },
];

export const PING_TIME_RANGE_OPTIONS: TimeRangeOption[] = [
  { label: "1 小时", value: 1 },
  { label: "4 小时", value: 4 },
  { label: "1 天", value: 24 },
  { label: "7 天", value: 168 },
];

function formatRangeLabel(hours: number) {
  if (hours % 24 === 0) {
    const days = hours / 24;
    return `${days} 天`;
  }

  return `${hours} 小时`;
}

function buildHistoryRangeOptions(
  presets: TimeRangeOption[],
  maxHours: number | null | undefined,
  includeRealtime: boolean,
) {
  const options = includeRealtime ? [{ label: "实时", value: 0 }] : [];
  if (!Number.isFinite(maxHours) || !maxHours || maxHours <= 0) {
    return [...options, ...presets];
  }

  const safeMaxHours = Math.floor(maxHours);
  const resolved = presets.filter((option) => option.value <= safeMaxHours);
  const hasExactMatch = resolved.some((option) => option.value === safeMaxHours);

  if (safeMaxHours > 0 && !hasExactMatch) {
    resolved.push({
      label: formatRangeLabel(safeMaxHours),
      value: safeMaxHours,
    });
  }

  return [...options, ...resolved];
}

export function buildLoadTimeRangeOptions(maxHours: number | null | undefined) {
  return buildHistoryRangeOptions(LOAD_TIME_RANGE_OPTIONS, maxHours, true);
}

export function buildPingTimeRangeOptions(maxHours: number | null | undefined) {
  return buildHistoryRangeOptions(PING_TIME_RANGE_OPTIONS, maxHours, false);
}

export function formatRangeSummary(hours: number) {
  if (hours === 0) return "实时";
  return formatRangeLabel(hours);
}

const MINUTE_SECONDS = 60;
const DAY_SECONDS = 86400;

export function toChartSeconds(value: string | number): number {
  if (typeof value === "number") {
    return value > 1_000_000_000_000 ? value / 1000 : value;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed / 1000;
}

function pad2(value: number) {
  return value.toString().padStart(2, "0");
}

function getDateParts(timestampSeconds: number) {
  const date = new Date(timestampSeconds * 1000);
  return {
    year: date.getFullYear(),
    month: pad2(date.getMonth() + 1),
    day: pad2(date.getDate()),
    hour: pad2(date.getHours()),
    minute: pad2(date.getMinutes()),
    second: pad2(date.getSeconds()),
  };
}

/**
 * 轴标签跟随实际刻度间隔自适应：跨天用 MM/DD、日内用 HH:MM、
 * 放大到分钟以内再补上秒，缩放后也不会出现整排重复的标签。
 */
export function formatAxisTimeLabel(timestampSeconds: number, incrSeconds: number) {
  const parts = getDateParts(timestampSeconds);
  if (incrSeconds >= DAY_SECONDS) return `${parts.month}/${parts.day}`;
  if (parts.hour === "00" && parts.minute === "00" && parts.second === "00") {
    return `${parts.month}/${parts.day}`;
  }
  if (incrSeconds >= MINUTE_SECONDS) return `${parts.hour}:${parts.minute}`;
  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

function getAxisFont(self: uPlot, axisIdx: number) {
  const axis = self.axes[axisIdx] as unknown as { font?: [string, number, number] };
  return Array.isArray(axis.font) ? axis.font[0] : null;
}

function measureAxisLabel(self: uPlot, axisIdx: number, text: string) {
  const font = getAxisFont(self, axisIdx);
  const ctx = self.ctx;
  const previousFont = ctx.font;
  if (font) ctx.font = font;
  const width = ctx.measureText(text).width;
  ctx.font = previousFont;
  return width / (window.devicePixelRatio || 1);
}

/**
 * 画布两端没有留白，居中绘制的首/末个标签会被裁掉半个字符。
 * 这里按实际文本宽度判断，越界的标签直接不渲染（网格线保留）。
 */
function dropOverflowingLabels(
  self: uPlot,
  axisIdx: number,
  splits: Array<number | null>,
  labels: Array<string | null>,
) {
  const chartWidth = self.width;
  if (!Number.isFinite(chartWidth) || chartWidth <= 0) return labels;

  // 留 3px 余量：轴尺寸收敛过程中位置可能有零点几像素的漂移。
  const margin = 3;
  return labels.map((label, index) => {
    const value = splits[index];
    if (label == null || value == null) return label;
    const position = self.valToPos(value, "x");
    if (!Number.isFinite(position)) return label;
    const half = measureAxisLabel(self, axisIdx, label) / 2;
    if (position - half < margin) return null;
    if (position + half > chartWidth - margin) return null;
    return label;
  });
}

export function createTimeAxisValues(): uPlot.Axis.DynamicValues {
  return (self, splits, axisIdx, _foundSpace, foundIncr) => {
    const labels = splits.map((value) =>
      value == null ? null : formatAxisTimeLabel(value, foundIncr),
    );
    return dropOverflowingLabels(self, axisIdx, splits, labels);
  };
}

/** Y 轴宽度按最长标签实测，避免 "1.23 MB/s" 被截断或短标签浪费横向空间。 */
export function createAxisSizer(minSize: number, extraGap = 6): uPlot.Axis.Size {
  return (self, values, axisIdx, cycleNum) => {
    const axis = self.axes[axisIdx] as uPlot.Axis & { _size?: number };
    // 第二轮起直接沿用上一轮结果，强制尺寸收敛（uPlot 官方示例做法）。
    if (cycleNum > 1) return axis._size ?? minSize;

    const gap = axis.gap ?? 0;
    const tickSize = axis.ticks?.size ?? 0;
    // 逐个实测取最宽，字符数最多的未必最宽（"1.23 MB/s" vs "100 Kbps"）。
    let textWidth = 0;
    for (const value of values ?? []) {
      if (value == null || value === "") continue;
      textWidth = Math.max(textWidth, measureAxisLabel(self, axisIdx, String(value)));
    }

    return Math.max(minSize, Math.ceil(gap + tickSize + textWidth + extraGap));
  };
}

/** 刻度间隔决定小数位，避免相邻刻度四舍五入成同一个标签。 */
export function decimalsForIncrement(incrementValue: number, maxDecimals = 4) {
  if (!Number.isFinite(incrementValue) || incrementValue <= 0) return 0;
  const digits = Math.ceil(-Math.log10(incrementValue));
  return Math.min(maxDecimals, Math.max(0, digits));
}

export function formatTooltipTime(timestampSeconds: number, withDate = false): string {
  const parts = getDateParts(timestampSeconds);
  if (withDate) {
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  }
  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

function isSameLocalDay(leftSeconds: number, rightSeconds: number) {
  const left = new Date(leftSeconds * 1000);
  const right = new Date(rightSeconds * 1000);
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/** 视图跨天或跨度较大时补上日期，缩放后同样成立。 */
export function formatCursorTime(self: uPlot, timestampSeconds: number): string {
  const min = self.scales.x?.min;
  const max = self.scales.x?.max;
  const withDate =
    typeof min === "number" && typeof max === "number"
      ? max - min >= 6 * 3600 || !isSameLocalDay(min, max)
      : false;
  return formatTooltipTime(timestampSeconds, withDate);
}

export function formatChartCoverageTime(timestampSeconds: number): string {
  const parts = getDateParts(timestampSeconds);
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

export function formatChartCoverageRange(startSeconds: number, endSeconds: number): string {
  const start = getDateParts(startSeconds);
  const end = getDateParts(endSeconds);
  const sameDay =
    start.year === end.year && start.month === end.month && start.day === end.day;
  if (sameDay) {
    return `${start.month}/${start.day} ${start.hour}:${start.minute} - ${end.hour}:${end.minute}`;
  }
  return `${formatChartCoverageTime(startSeconds)} - ${formatChartCoverageTime(endSeconds)}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function getChartTooltipPosition({
  containerWidth,
  containerHeight,
  anchorX,
  anchorY,
  rowCount,
  estimatedWidth = 188,
}: {
  containerWidth: number;
  containerHeight: number;
  anchorX: number;
  anchorY: number;
  rowCount: number;
  estimatedWidth?: number;
}) {
  const margin = 10;
  const offsetX = 18;
  const offsetY = 16;
  const estimatedHeight = 34 + rowCount * 22;
  const maxLeft = Math.max(margin, containerWidth - estimatedWidth - margin);
  const maxTop = Math.max(margin, containerHeight - estimatedHeight - margin);

  let left =
    anchorX + estimatedWidth + offsetX <= containerWidth - margin
      ? anchorX + offsetX
      : anchorX - estimatedWidth - offsetX;
  left = clamp(left, margin, maxLeft);

  let top = anchorY - estimatedHeight - offsetY;
  if (top < margin) top = anchorY + offsetY;
  top = clamp(top, margin, maxTop);

  return { left, top };
}

const GRID_CHART_FALLBACK_WIDTH = 320;
const WIDE_CHART_FALLBACK_WIDTH = 720;

function resolveChartHeight(mode: "grid" | "wide", width: number) {
  if (mode === "grid") return width < 260 ? 136 : 150;
  if (width < 560) return 260;
  if (width < 900) return 300;
  return 340;
}

/**
 * 直接量取图表容器宽度，而不是按 window.innerWidth 猜断点：
 * 断点猜测与真实栅格列数一旦不一致，画布就会溢出容器并被裁掉右侧坐标。
 */
export function useChartSize<T extends HTMLElement>(mode: "grid" | "wide") {
  const [width, setWidth] = useState(
    mode === "grid" ? GRID_CHART_FALLBACK_WIDTH : WIDE_CHART_FALLBACK_WIDTH,
  );
  const observerRef = useRef<ResizeObserver | null>(null);
  const frameRef = useRef(0);

  // 用回调 ref 而不是 useEffect：图表容器可能先渲染骨架屏、稍后才挂载，
  // 只在挂载时初始化的 effect 会永远观测不到真正的容器。
  const ref = useCallback((element: T | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    window.cancelAnimationFrame(frameRef.current);
    if (!element) return;

    const applyWidth = (next: number) => {
      const rounded = Math.floor(next);
      // 容器被 display:none 隐藏时宽度为 0，保留上一次的有效宽度。
      if (rounded <= 0) return;
      setWidth((previous) => (previous === rounded ? previous : rounded));
    };

    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      const next = entry.contentRect.width;
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = window.requestAnimationFrame(() => applyWidth(next));
    });

    observer.observe(element);
    observerRef.current = observer;
    applyWidth(element.getBoundingClientRect().width);
  }, []);

  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      window.cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  return { ref, w: width, h: resolveChartHeight(mode, width) };
}
