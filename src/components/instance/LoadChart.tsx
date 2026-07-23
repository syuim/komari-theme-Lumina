import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import UplotReact from "uplot-react";
import type uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { Activity, ArrowDown, ArrowUp, Cpu, Gauge, HardDrive, MemoryStick, Network, Workflow } from "lucide-react";
import { useLoadRecords } from "@/hooks/useRecords";
import { useNode } from "@/hooks/useNode";
import { InstancePanel } from "./InstancePanel";
import {
  createAxisSizer,
  createTimeAxisValues,
  decimalsForIncrement,
  formatChartCoverageRange,
  formatCursorTime,
  formatRangeSummary,
  getChartTooltipPosition,
  toChartSeconds,
  useChartSize,
} from "./chartShared";
import {
  fillMissingMetricPoints,
  interpolateMetricGaps,
} from "./chartData";
import { formatBytes, formatTrafficRateLabel } from "@/utils/format";
import { useResolvedAppearance } from "@/hooks/usePreferences";
import type { LoadRecord } from "@/types/komari";

const CHART_COLORS = {
  cpu: "#5d88ff",
  memory: "#a35cf5",
  disk: "#f1873d",
  success: "#61c08f",
  warning: "#d4a54a",
  load: "#e56f8f",
} as const;

const LOAD_HISTORY_SAMPLE_LIMIT = 360;
const LOAD_HISTORY_RENDER_LIMIT = 720;
const REALTIME_HISTORY_SEED_LIMIT = 120;
const REALTIME_SAMPLE_LIMIT = 600;

const CPU_KEYS = ["cpu"];
const CPU_COLORS = [CHART_COLORS.cpu];
const MEMORY_KEYS = ["ram", "swap"];
const MEMORY_COLORS = [CHART_COLORS.memory, CHART_COLORS.warning];
const DISK_KEYS = ["disk"];
const DISK_COLORS = [CHART_COLORS.disk];
const NETWORK_KEYS = ["netIn", "netOut"];
const NETWORK_COLORS = [CHART_COLORS.success, CHART_COLORS.cpu];
const CONNECTION_KEYS = ["connections", "udp"];
const CONNECTION_COLORS = [CHART_COLORS.memory, CHART_COLORS.cpu];
const PROCESS_KEYS = ["process"];
const PROCESS_COLORS = [CHART_COLORS.warning];
const LOAD_KEYS = ["load"];
const LOAD_COLORS = [CHART_COLORS.load];
const SERIES_LABELS: Record<string, string> = {
  cpu: "CPU",
  ram: "内存",
  swap: "Swap",
  disk: "磁盘",
  diskBytes: "磁盘",
  netIn: "下行",
  netOut: "上行",
  connections: "TCP",
  udp: "UDP",
  process: "进程",
  load: "负载",
};
const LOAD_INTERPOLATE_KEYS = [
  "cpu",
  "ram",
  "swap",
  "disk",
  "diskBytes",
  "netIn",
  "netOut",
  "connections",
  "udp",
  "process",
  "load",
];

interface ChartPoint {
  time: number;
  [key: string]: number | null;
}

interface TooltipState {
  show: boolean;
  left: number;
  top: number;
  rows: Array<{ label: string; value: string; color: string }>;
  time: string;
}

const HIDDEN_TOOLTIP: TooltipState = {
  show: false,
  left: 0,
  top: 0,
  rows: [],
  time: "",
};

function metricData(points: ChartPoint[], keys: string[]): uPlot.AlignedData {
  const times = points.map((point) => point.time);
  return [times, ...keys.map((key) => points.map((point) => point[key] ?? null))] as uPlot.AlignedData;
}

function getHistoryRenderLimit(hours: number) {
  if (hours <= 4) return LOAD_HISTORY_SAMPLE_LIMIT;
  return LOAD_HISTORY_RENDER_LIMIT;
}

function downsamplePoints(points: ChartPoint[], limit: number) {
  if (points.length <= limit || limit < 2) return points;

  const result: ChartPoint[] = [];
  const lastIndex = points.length - 1;
  const step = lastIndex / (limit - 1);
  let previousIndex = -1;

  for (let index = 0; index < limit; index += 1) {
    const sourceIndex = Math.min(lastIndex, Math.round(index * step));
    if (sourceIndex === previousIndex) continue;
    result.push(points[sourceIndex]);
    previousIndex = sourceIndex;
  }

  return result;
}

function getSeriesLabel(key: string) {
  return SERIES_LABELS[key] ?? key;
}

function pointFromNode(node: NonNullable<ReturnType<typeof useNode>>): ChartPoint {
  return {
    time: Date.now() / 1000,
    cpu: node.cpuPct,
    ram: node.ramTotal > 0 ? (node.ramUsed / node.ramTotal) * 100 : 0,
    swap: node.swapTotal > 0 ? (node.swapUsed / node.swapTotal) * 100 : 0,
    disk: node.diskTotal > 0 ? (node.diskUsed / node.diskTotal) * 100 : 0,
    diskBytes: node.diskUsed,
    netIn: node.netDown,
    netOut: node.netUp,
    connections: node.connectionsTcp,
    udp: node.connectionsUdp,
    process: node.process,
    load: node.load1,
  };
}

function formatTooltipValue(key: string, value: number | null | undefined, unit: string) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (key === "netIn" || key === "netOut") return formatTrafficRateLabel(value);
  if (unit === "%") return `${value.toFixed(2)}%`;
  if (key === "process" || key === "connections" || key === "udp") return `${Math.round(value)}`;
  return value.toFixed(2);
}

function formatNetworkAxisValue(value: number) {
  if (!Number.isFinite(value)) return "";
  if (value <= 0) return "0";
  return formatTrafficRateLabel(value);
}

/** 计数轴只允许整数刻度，避免 "97 / 97 / 98" 这种重复标签。 */
const WHOLE_NUMBER_INCRS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000,
  100_000, 200_000, 500_000, 1_000_000,
];

/**
 * 数值几乎恒定时 uPlot 会把噪声放大到小数点后好几位，
 * 这里给每类指标一个最小跨度，读数才有意义。
 */
function percentRange(minSpan: number): uPlot.Scale.Range {
  return (_self, dataMin, dataMax) => {
    let low = Math.max(0, Math.min(dataMin ?? 0, dataMax ?? 0));
    let high = Math.min(100, Math.max(dataMax ?? 0, low));
    const span = high - low;
    if (span < minSpan) {
      const center = (low + high) / 2;
      low = center - minSpan / 2;
      high = center + minSpan / 2;
      if (low < 0) {
        high -= low;
        low = 0;
      }
      if (high > 100) {
        low = Math.max(0, low - (high - 100));
        high = 100;
      }
    } else {
      const pad = span * 0.08;
      low = Math.max(0, low - pad);
      high = Math.min(100, high + pad);
    }
    return [low, high];
  };
}

function fromZeroRange(minTop: number): uPlot.Scale.Range {
  return (_self, _dataMin, dataMax) => {
    const top = Math.max(minTop, (dataMax ?? 0) * 1.15);
    return [0, top];
  };
}

const countRange: uPlot.Scale.Range = (_self, dataMin, dataMax) => {
  const low = Math.min(dataMin ?? 0, dataMax ?? 0);
  const high = Math.max(dataMax ?? 0, low);
  const span = high - low;
  if (span < 2) {
    const center = (low + high) / 2;
    return [Math.max(0, center - 1), Math.max(1, center + 1)];
  }
  const pad = span * 0.1;
  return [Math.max(0, low - pad), high + pad];
};

function buildChartOptions({
  title,
  keys,
  colors,
  unit,
  height,
  width,
  resolvedAppearance,
  spanGaps,
  axisKind = "default",
  syncKey,
}: {
  title: string;
  keys: string[];
  colors: string[];
  unit: string;
  height: number;
  width: number;
  resolvedAppearance: "light" | "dark";
  spanGaps?: boolean;
  axisKind?: "default" | "percent" | "network" | "count" | "load";
  syncKey: string;
}): uPlot.Options {
  const isDark = resolvedAppearance === "dark";
  const grid = isDark ? "rgba(255,255,255,0.065)" : "rgba(0,0,0,0.08)";
  const text = isDark ? "#a5a5aa" : "#52525b";
  const yRange =
    axisKind === "percent"
      ? percentRange(0.5)
      : axisKind === "network"
        ? fromZeroRange(1)
        : axisKind === "load"
          ? fromZeroRange(0.1)
          : countRange;

  return {
    width,
    height,
    padding: [8, 16, 8, 2],
    cursor: {
      drag: { x: true, y: false },
      y: false,
      sync: { key: syncKey, scales: ["x", null] },
    },
    legend: { show: false },
    scales: { x: { time: true }, y: { auto: true, range: yRange } },
    axes: [
      {
        stroke: text,
        grid: { stroke: grid, width: 1 },
        ticks: { stroke: grid, size: 4 },
        gap: 4,
        size: 32,
        space: 62,
        values: createTimeAxisValues(),
      },
      {
        stroke: text,
        grid: { stroke: grid, width: 1 },
        ticks: { stroke: grid, size: 4 },
        gap: 5,
        size: createAxisSizer(34),
        incrs: axisKind === "count" ? WHOLE_NUMBER_INCRS : undefined,
        values: (_self, splits, _axisIdx, _foundSpace, foundIncr) => {
          const decimals = decimalsForIncrement(foundIncr, axisKind === "percent" ? 2 : 3);
          return splits.map((value) => {
            if (axisKind === "network") return formatNetworkAxisValue(value);
            if (axisKind === "percent") return `${value.toFixed(decimals)}%`;
            if (axisKind === "count") return value.toFixed(0);
            return `${value.toFixed(decimals)}${unit}`;
          });
        },
      },
    ],
    series: [
      { label: "time" },
      ...keys.map((key, index) => ({
        label: getSeriesLabel(key),
        stroke: colors[index] ?? colors[0],
        fill: index === 0 ? `${colors[index] ?? colors[0]}22` : undefined,
        width: 1.6,
        spanGaps: spanGaps ?? false,
        points: { show: false },
      })),
    ],
    hooks: {
      init: [
        (u) => {
          u.root.setAttribute("aria-label", title);
        },
      ],
    },
  };
}

const ChartCard = memo(function ChartCard({
  icon,
  title,
  value,
  note,
  points,
  keys,
  colors,
  resolvedAppearance,
  unit = "",
  spanGaps,
  axisKind,
  syncKey,
}: {
  icon: ReactNode;
  title: string;
  value: ReactNode;
  note?: ReactNode;
  points: ChartPoint[];
  keys: string[];
  colors: string[];
  resolvedAppearance: "light" | "dark";
  unit?: string;
  spanGaps?: boolean;
  axisKind?: "default" | "percent" | "network" | "count" | "load";
  syncKey: string;
}) {
  const dataRef = useRef<uPlot.AlignedData>([[]]);
  const hoveredRef = useRef(false);
  const { ref: wrapRef, w, h } = useChartSize<HTMLDivElement>("grid");
  const [tooltip, setTooltip] = useState<TooltipState>(HIDDEN_TOOLTIP);
  const data = useMemo(() => metricData(points, keys), [points, keys]);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);
  const options = useMemo(
    () =>
      buildChartOptions({
        title,
        keys,
        colors,
        unit,
        height: h,
        width: w,
        resolvedAppearance,
        spanGaps,
        axisKind,
        syncKey,
      }),
    [axisKind, colors, h, keys, resolvedAppearance, spanGaps, syncKey, title, unit, w],
  );

  const hideTooltip = useCallback(() => {
    setTooltip((previous) => (previous.show ? HIDDEN_TOOLTIP : previous));
  }, []);

  const enhancedOptions = useMemo<uPlot.Options>(() => ({
    ...options,
    hooks: {
      ...options.hooks,
      setCursor: [
        (u) => {
          // 光标在多图之间同步，只有真正悬停的卡片才弹出气泡。
          if (!hoveredRef.current) {
            hideTooltip();
            return;
          }
          const idx = u.cursor.idx;
          if (idx == null || idx < 0) {
            hideTooltip();
            return;
          }
          const currentData = dataRef.current;
          const timestamp = currentData[0]?.[idx];
          if (typeof timestamp !== "number") {
            hideTooltip();
            return;
          }
          const rows = keys.map((key, keyIndex) => {
            const value = currentData[keyIndex + 1]?.[idx] as number | null | undefined;
            return {
              label: getSeriesLabel(key),
              value: formatTooltipValue(key, value, unit),
              color: colors[keyIndex] ?? colors[0],
            };
          });
          const bbox = u.root.getBoundingClientRect();
          const anchorX = u.valToPos(timestamp, "x");
          const anchorY = typeof u.cursor.top === "number" ? u.cursor.top : bbox.height * 0.5;
          const position = getChartTooltipPosition({
            containerWidth: bbox.width,
            containerHeight: bbox.height,
            anchorX,
            anchorY,
            rowCount: rows.length,
            estimatedWidth: 176,
          });
          setTooltip({
            show: true,
            left: position.left,
            top: position.top,
            rows,
            time: formatCursorTime(u, timestamp),
          });
        },
      ],
    },
  }), [colors, hideTooltip, keys, options, unit]);

  return (
    <div
      className="instance-chart-card"
      style={{ "--chart-accent": colors[0] } as CSSProperties}
    >
      <header className="instance-chart-card-head">
        <div className="instance-chart-card-heading">
          <div className="instance-panel-subhead">
            {icon}
            <span>{title}</span>
          </div>
          {keys.length > 1 && (
            <div className="instance-chart-legend">
              {keys.map((key, index) => (
                <span key={key} className="instance-chart-legend-item">
                  <span
                    className="instance-chart-legend-dot"
                    style={{ background: colors[index] ?? colors[0] }}
                  />
                  {getSeriesLabel(key)}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="instance-series-stats">
          <span className="tabular">{value}</span>
          {note && <span className="tabular text-[var(--text-tertiary)]">{note}</span>}
        </div>
      </header>
      <div
        className="instance-uplot-wrap"
        ref={wrapRef}
        onMouseEnter={() => {
          hoveredRef.current = true;
        }}
        onMouseLeave={() => {
          hoveredRef.current = false;
          hideTooltip();
        }}
      >
        <UplotReact options={enhancedOptions} data={data} />
        {tooltip.show && (
          <div
            className="instance-chart-tooltip"
            style={{ left: tooltip.left, top: tooltip.top }}
          >
            <div className="instance-chart-tooltip-time">{tooltip.time}</div>
            {tooltip.rows.map((row) => (
              <div key={row.label} className="instance-chart-tooltip-row">
                <span className="instance-chart-tooltip-dot" style={{ background: row.color }} />
                <span>{row.label}</span>
                <strong>{row.value}</strong>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

export function LoadChart({
  uuid,
  hours,
  active = true,
}: {
  uuid: string;
  hours: number;
  active?: boolean;
}) {
  const queryHours = hours === 0 ? 1 : hours;
  const { data, isLoading } = useLoadRecords(uuid, queryHours, active);
  const isRealtime = hours === 0;
  const node = useNode(uuid, active);
  // 历史记录里的 *_total 字段恒为 0（komari 只落盘已用量），
  // 百分比要用节点静态容量兜底，否则内存/磁盘曲线会整条压在 0%。
  const ramTotalHint = node?.mem_total || node?.ramTotal || 0;
  const swapTotalHint = node?.swap_total || node?.swapTotal || 0;
  const diskTotalHint = node?.disk_total || node?.diskTotal || 0;
  const resolvedAppearance = useResolvedAppearance();
  const [realtimePoints, setRealtimePoints] = useState<ChartPoint[]>([]);
  const [connectNulls, setConnectNulls] = useState(false);
  const syncKey = `lumina-load-${uuid}`;

  useEffect(() => {
    if (!active || !isRealtime || !node) return;
    const point = pointFromNode(node);
    setRealtimePoints((prev) => {
      const last = prev[prev.length - 1];
      if (last && Math.abs(last.time - point.time) < 1) return prev;
      return [...prev, point].slice(-REALTIME_SAMPLE_LIMIT);
    });
  }, [active, isRealtime, node]);

  useEffect(() => {
    setRealtimePoints([]);
  }, [hours, uuid]);

  const historyPoints = useMemo<ChartPoint[]>(() => {
    const records = [...(data?.records ?? [])];
    const toPercent = (used: number, recordTotal: number, fallbackTotal: number) => {
      const total = recordTotal > 0 ? recordTotal : fallbackTotal;
      return total > 0 ? (used / total) * 100 : null;
    };
    const rawPoints = records
      .map((record) => ({
        time: toChartSeconds(record.time),
        cpu: record.cpu,
        ram: toPercent(record.ram, record.ram_total, ramTotalHint),
        swap: toPercent(record.swap, record.swap_total, swapTotalHint),
        disk: toPercent(record.disk, record.disk_total, diskTotalHint),
        diskBytes: record.disk,
        netIn: record.net_in,
        netOut: record.net_out,
        connections: record.connections,
        udp: record.connections_udp,
        process: record.process,
        load: record.load,
      }))
      .filter((point) => point.time > 0)
      .sort((a, b) => a.time - b.time);
    const sampled = downsamplePoints(rawPoints, getHistoryRenderLimit(hours));
    const filled = fillMissingMetricPoints(sampled);
    return interpolateMetricGaps(filled, LOAD_INTERPOLATE_KEYS);
  }, [data, diskTotalHint, hours, ramTotalHint, swapTotalHint]);

  const points = useMemo<ChartPoint[]>(() => {
    if (isRealtime) {
      const initial = historyPoints.slice(-REALTIME_HISTORY_SEED_LIMIT);
      const merged = [...initial, ...realtimePoints].sort((a, b) => a.time - b.time);
      const deduped = merged.filter((point, index, arr) => {
        const next = arr[index + 1];
        return !next || Math.abs(next.time - point.time) >= 1;
      });
      return deduped.slice(-REALTIME_SAMPLE_LIMIT);
    }
    return historyPoints;
  }, [historyPoints, isRealtime, realtimePoints]);

  /** 卡片顶部展示最新一条真实记录，避免读到重采样后补齐的空槽。 */
  const latestRecord = useMemo<LoadRecord | null>(() => {
    let latest: LoadRecord | null = null;
    let latestTime = -Infinity;
    for (const record of data?.records ?? []) {
      const time = toChartSeconds(record.time);
      if (time > latestTime) {
        latestTime = time;
        latest = record;
      }
    }
    return latest;
  }, [data]);

  const live = isRealtime && node ? node : null;
  const resolveTotal = (recordTotal: number | undefined, hint: number) =>
    recordTotal && recordTotal > 0 ? recordTotal : hint;
  const historyRamTotal = resolveTotal(latestRecord?.ram_total, ramTotalHint);
  const historySwapTotal = resolveTotal(latestRecord?.swap_total, swapTotalHint);
  const historyDiskTotal = resolveTotal(latestRecord?.disk_total, diskTotalHint);
  const rangeSummary = formatRangeSummary(hours);
  const sourceRecordCount = data?.records.length ?? 0;
  const wasDownsampled = !isRealtime && sourceRecordCount > getHistoryRenderLimit(hours);
  const sampleSummary = isRealtime
    ? `${points.length} 个点`
    : wasDownsampled
      ? `${points.length} / ${sourceRecordCount} 个点`
      : `${points.length} 个点`;
  const coverageSummary = points.length
    ? formatChartCoverageRange(points[0].time, points[points.length - 1].time)
    : "—";

  if (isLoading) {
    return <section className="instance-panel instance-chart-skeleton" aria-busy />;
  }

  if (!points.length) {
    return (
      <InstancePanel title="负载图表">
        <div className="instance-empty">暂无负载历史数据</div>
      </InstancePanel>
    );
  }

  return (
    <InstancePanel
      title="负载图表"
      aside={<span className="instance-chart-range-chip">{rangeSummary}</span>}
      className="instance-chart-panel"
    >
      <div className="instance-chart-toolbar">
        <div className="instance-chart-meta" aria-label="图表数据范围">
          <span>
            覆盖 <strong>{coverageSummary}</strong>
          </span>
          <span>
            采样 <strong>{sampleSummary}</strong>
          </span>
          <span className="instance-chart-hint">框选缩放 · 双击还原</span>
        </div>
        <button
          type="button"
          className="instance-toggle-button instance-switch-button"
          data-active={connectNulls ? "true" : "false"}
          onClick={() => setConnectNulls((value) => !value)}
          aria-pressed={connectNulls}
          title="开启后断点两侧直接连线，关闭则保留数据缺口"
        >
          <span className="instance-switch-copy">断点连线</span>
          <span className="instance-switch-track" aria-hidden>
            <span className="instance-switch-thumb" />
          </span>
          <span className="instance-switch-state">
            {connectNulls ? "开启" : "关闭"}
          </span>
        </button>
      </div>
      <div className="instance-chart-grid">
        <ChartCard
          icon={<Cpu size={13} />}
          title="CPU"
          value={
            live
              ? `${live.cpuPct.toFixed(2)}%`
              : latestRecord
                ? `${latestRecord.cpu.toFixed(2)}%`
                : "—"
          }
          note="使用率"
          points={points}
          keys={CPU_KEYS}
          colors={CPU_COLORS}
          resolvedAppearance={resolvedAppearance}
          unit="%"
          spanGaps={connectNulls}
          axisKind="percent"
          syncKey={syncKey}
        />
        <ChartCard
          icon={<MemoryStick size={13} />}
          title="内存"
          value={
            live
              ? `${formatBytes(live.ramUsed)} / ${formatBytes(live.ramTotal)}`
              : latestRecord
                ? `${formatBytes(latestRecord.ram)} / ${formatBytes(historyRamTotal)}`
                : "—"
          }
          note={
            live
              ? live.swapTotal
                ? `Swap ${formatBytes(live.swapUsed)} / ${formatBytes(live.swapTotal)}`
                : "Swap 无"
              : latestRecord && historySwapTotal > 0
                ? `Swap ${formatBytes(latestRecord.swap)} / ${formatBytes(historySwapTotal)}`
                : "Swap 无"
          }
          points={points}
          keys={MEMORY_KEYS}
          colors={MEMORY_COLORS}
          resolvedAppearance={resolvedAppearance}
          unit="%"
          spanGaps={connectNulls}
          axisKind="percent"
          syncKey={syncKey}
        />
        <ChartCard
          icon={<HardDrive size={13} />}
          title="磁盘"
          value={
            live
              ? `${formatBytes(live.diskUsed)} / ${formatBytes(live.diskTotal)}`
              : latestRecord
                ? `${formatBytes(latestRecord.disk)} / ${formatBytes(historyDiskTotal)}`
                : "—"
          }
          note="已用空间"
          points={points}
          keys={DISK_KEYS}
          colors={DISK_COLORS}
          resolvedAppearance={resolvedAppearance}
          unit="%"
          spanGaps={connectNulls}
          axisKind="percent"
          syncKey={syncKey}
        />
        <ChartCard
          icon={<Network size={13} />}
          title="网络"
          value={
            live
              ? `${formatTrafficRateLabel(live.netDown)} / ${formatTrafficRateLabel(live.netUp)}`
              : latestRecord
                ? `${formatTrafficRateLabel(latestRecord.net_in)} / ${formatTrafficRateLabel(latestRecord.net_out)}`
                : "—"
          }
          note={
            <span className="instance-overview-multi">
              <span className="inline-flex items-center gap-1">
                <ArrowDown size={11} />
                {live
                  ? formatBytes(live.trafficDown)
                  : latestRecord
                    ? formatBytes(latestRecord.net_total_down)
                    : "—"}
              </span>
              <span className="inline-flex items-center gap-1">
                <ArrowUp size={11} />
                {live
                  ? formatBytes(live.trafficUp)
                  : latestRecord
                    ? formatBytes(latestRecord.net_total_up)
                    : "—"}
              </span>
            </span>
          }
          points={points}
          keys={NETWORK_KEYS}
          colors={NETWORK_COLORS}
          resolvedAppearance={resolvedAppearance}
          spanGaps={connectNulls}
          axisKind="network"
          syncKey={syncKey}
        />
        <ChartCard
          icon={<Workflow size={13} />}
          title="连接数"
          value={
            live
              ? `TCP ${live.connectionsTcp} / UDP ${live.connectionsUdp}`
              : latestRecord
                ? `TCP ${Math.round(latestRecord.connections)} / UDP ${Math.round(latestRecord.connections_udp)}`
                : "—"
          }
          note="活动连接"
          points={points}
          keys={CONNECTION_KEYS}
          colors={CONNECTION_COLORS}
          resolvedAppearance={resolvedAppearance}
          spanGaps={connectNulls}
          axisKind="count"
          syncKey={syncKey}
        />
        <ChartCard
          icon={<Gauge size={13} />}
          title="进程"
          value={
            live
              ? live.process.toString()
              : latestRecord
                ? Math.round(latestRecord.process).toString()
                : "—"
          }
          note="进程总数"
          points={points}
          keys={PROCESS_KEYS}
          colors={PROCESS_COLORS}
          resolvedAppearance={resolvedAppearance}
          spanGaps={connectNulls}
          axisKind="count"
          syncKey={syncKey}
        />
        <ChartCard
          icon={<Activity size={13} />}
          title="系统负载"
          value={
            live
              ? live.load1.toFixed(2)
              : latestRecord
                ? latestRecord.load.toFixed(2)
                : "—"
          }
          note={
            live
              ? `${live.load1.toFixed(2)} | ${live.load5.toFixed(2)} | ${live.load15.toFixed(2)}`
              : "1 分钟平均"
          }
          points={points}
          keys={LOAD_KEYS}
          colors={LOAD_COLORS}
          resolvedAppearance={resolvedAppearance}
          spanGaps={connectNulls}
          axisKind="load"
          syncKey={syncKey}
        />
      </div>
    </InstancePanel>
  );
}
