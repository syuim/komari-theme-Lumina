import { useEffect, useMemo, useRef, useState } from "react";
import UplotReact from "uplot-react";
import type uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { Eye, EyeOff, RefreshCw } from "lucide-react";
import { usePingRecords } from "@/hooks/useRecords";
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
  cutPeakValues,
  detectTypicalIntervalMs,
  insertMetricGapSentinels,
} from "./chartData";
import { latencyHeatColor, lossHeatColor } from "@/utils/metricTone";
import { useResolvedAppearance } from "@/hooks/usePreferences";
import { isLostPingSample, isValidPingLatency } from "@/utils/pingValues";
import type { PingRecord } from "@/types/komari";
import type { TimedMetricPoint } from "./chartData";

interface TooltipState {
  show: boolean;
  left: number;
  top: number;
  rows: Array<{ label: string; value: string; color: string }>;
  time: string;
}

function colorForTask(index: number) {
  const colors = [
    "#5d88ff",
    "#61c08f",
    "#a35cf5",
    "#f1873d",
    "#d4a54a",
  ] as const;
  return colors[index % colors.length];
}

function percentile(values: number[], ratio: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

export function PingChart({
  uuid,
  hours,
  active = true,
}: {
  uuid: string;
  hours: number;
  active?: boolean;
}) {
  const { data, isLoading, refetch } = usePingRecords(uuid, hours, active);
  const resolvedAppearance = useResolvedAppearance();
  const { ref: wrapRef, w, h } = useChartSize<HTMLDivElement>("wide");
  const [hiddenTasks, setHiddenTasks] = useState<Set<number>>(new Set());
  const [connectNulls, setConnectNulls] = useState(false);
  const [cutPeak, setCutPeak] = useState(false);
  const chartRef = useRef<uPlot.AlignedData>([[]]);
  const [tooltip, setTooltip] = useState<TooltipState>({
    show: false,
    left: 0,
    top: 0,
    rows: [],
    time: "",
  });
  const isDark = resolvedAppearance === "dark";
  const tasks = useMemo(() => [...(data?.tasks ?? [])].sort((a, b) => a.id - b.id), [data]);
  const sampleIntervals = data?.sampleIntervals;
  const taskLabels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      const label = task.name || `任务 #${task.id}`;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return new Map(
      tasks.map((task) => {
        const baseLabel = task.name || `任务 #${task.id}`;
        const label = (counts.get(baseLabel) ?? 0) > 1 ? `${baseLabel} #${task.id}` : baseLabel;
        return [task.id, label] as const;
      }),
    );
  }, [tasks]);
  const taskColors = useMemo(
    () => new Map(tasks.map((task, index) => [task.id, colorForTask(index)] as const)),
    [tasks],
  );
  const taskKeySet = useMemo(() => new Set(tasks.map((task) => String(task.id))), [tasks]);
  const taskKeys = useMemo(() => tasks.map((task) => String(task.id)), [tasks]);
  const taskIndexById = useMemo(
    () => new Map(tasks.map((task, index) => [task.id, index] as const)),
    [tasks],
  );
  const visibleTasks = useMemo(
    () => tasks.filter((task) => !hiddenTasks.has(task.id)),
    [hiddenTasks, tasks],
  );
  const visibleTaskIds = useMemo(
    () => new Set(visibleTasks.map((task) => task.id)),
    [visibleTasks],
  );

  useEffect(() => {
    setHiddenTasks(new Set());
  }, [uuid]);

  useEffect(() => {
    setHiddenTasks((prev) => {
      const validTaskIds = new Set(tasks.map((task) => task.id));
      const next = new Set([...prev].filter((taskId) => validTaskIds.has(taskId)));
      return next.size === prev.size ? prev : next;
    });
  }, [tasks]);

  const chart = useMemo(() => {
    if (!data?.records.length || !tasks.length || visibleTasks.length === 0) return null;
    const pointMap = new Map<number, TimedMetricPoint>();
    const sortedRecords = data.records
      .map((record) => ({
        record,
        time: toChartSeconds(record.time),
      }))
      .filter(({ time }) => time > 0)
      .sort((left, right) => left.time - right.time);
    const taskIntervals = tasks
      .map((task) => task.interval)
      .filter((value): value is number => typeof value === "number" && value > 0);
    const fallbackInterval = taskIntervals.length > 0
      ? Math.min(...taskIntervals)
      : detectTypicalIntervalMs(sortedRecords.map(({ time }) => time), 60);
    const tolerance = Math.min(6, Math.max(0.8, fallbackInterval * 0.25));
    const anchors: number[] = [];
    // anchors 单调不减（记录已按时间升序、仅追加当前时刻），因此可用单调指针
    // 把每次记录的首匹配扫描从 O(n) 降为摊还 O(1)，语义与原线性首匹配完全一致。
    let anchorSearchStart = 0;

    for (const { record, time } of sortedRecords) {
      if (!taskKeySet.has(String(record.task_id))) continue;
      let anchor = time;
      while (
        anchorSearchStart < anchors.length &&
        anchors[anchorSearchStart] < time - tolerance
      ) {
        anchorSearchStart += 1;
      }
      for (let index = anchorSearchStart; index < anchors.length; index += 1) {
        const existing = anchors[index];
        if (existing > time + tolerance) break;
        if (Math.abs(existing - time) <= tolerance) {
          anchor = existing;
          break;
        }
      }
      if (anchor === time) {
        anchors.push(anchor);
      }
      const current = pointMap.get(anchor) ?? { time: anchor };
      current[String(record.task_id)] = isValidPingLatency(record.value) ? record.value : null;
      pointMap.set(anchor, current);
    }

    let chartPoints = [...pointMap.values()].sort((a, b) => a.time - b.time);
    if (cutPeak && taskKeys.length > 0) {
      chartPoints = cutPeakValues(chartPoints, taskKeys);
    }
    chartPoints = insertMetricGapSentinels(chartPoints, {
      // 断档判定用「配置间隔」与「服务端实测采样间隔」中较大的那个：降采样后按真实
      // 栅格判断，原始数据下两者相等、行为不变。
      intervals: new Map(
        tasks
          .map((task) => {
            const key = String(task.id);
            const configured =
              typeof task.interval === "number" && task.interval > 0 ? task.interval : 0;
            const sampled = sampleIntervals?.[key] ?? 0;
            return [key, Math.max(configured, sampled)] as const;
          })
          .filter(([, interval]) => interval > 0),
      ),
      defaultInterval: fallbackInterval,
      matchToleranceRatio: 0.25,
    });
    const times = chartPoints.map((point) => point.time);
    const perTask = taskKeys.map((taskKey) =>
      chartPoints.map((point) => point[taskKey] ?? null),
    );

    return [times, ...perTask] as uPlot.AlignedData;
  }, [cutPeak, data, sampleIntervals, taskKeySet, taskKeys, tasks, visibleTasks.length]);

  useEffect(() => {
    if (chart) chartRef.current = chart;
  }, [chart]);

  const yRange = useMemo<[number | null, number | null]>(() => {
    if (!chart) return [null, null];
    const values = tasks
      .flatMap((task, index) =>
        visibleTaskIds.has(task.id)
          ? ((chart[index + 1] as Array<number | null | undefined>) ?? [])
          : [],
      )
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
    if (values.length === 0) return [0, 100];
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (min === max) {
      const pad = Math.max(5, min * 0.1);
      return [Math.max(0, min - pad), max + pad];
    }
    const pad = Math.max(5, (max - min) * 0.12);
    return [Math.max(0, min - pad), max + pad];
  }, [chart, tasks, visibleTaskIds]);

  const xRange = useMemo<[number, number] | null>(() => {
    const from = data?.from != null ? toChartSeconds(data.from) : 0;
    const to = data?.to != null ? toChartSeconds(data.to) : 0;
    return from > 0 && to > from ? [from, to] : null;
  }, [data?.from, data?.to]);

  const options = useMemo<uPlot.Options | null>(() => {
    if (!chart) return null;
    const grid = isDark ? "rgba(255,255,255,0.065)" : "rgba(0,0,0,0.08)";
    const text = isDark ? "#a5a5aa" : "#52525b";
    const xScale = xRange ? { time: true, range: xRange } : { time: true };
    return {
      width: w,
      height: h,
      padding: [10, 18, 8, 2],
      cursor: { drag: { x: true, y: false } },
      legend: { show: false },
      scales: {
        x: xScale,
        y: { auto: false, range: yRange },
      },
      axes: [
        {
          stroke: text,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid, size: 4 },
          gap: 5,
          size: 34,
          space: 70,
          values: createTimeAxisValues(),
        },
        {
          stroke: text,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid, size: 4 },
          gap: 5,
          size: createAxisSizer(40),
          values: (_self, splits, _axisIdx, _foundSpace, foundIncr) => {
            const decimals = decimalsForIncrement(foundIncr, 2);
            return splits.map((value) => `${value.toFixed(decimals)} ms`);
          },
        },
      ],
      series: [
        { label: "time" },
        ...tasks.map((task, index) => ({
          label: taskLabels.get(task.id) ?? `任务 #${task.id}`,
          stroke: taskColors.get(task.id) ?? colorForTask(index),
          width: 1.7,
          spanGaps: connectNulls,
          show: !hiddenTasks.has(task.id),
          points: { show: false },
        })),
      ],
      hooks: {
        init: [
          (u) => {
            u.root.addEventListener("mouseleave", () => {
              setTooltip((prev) => ({ ...prev, show: false }));
            });
          },
        ],
        setCursor: [
          (u) => {
            const idx = u.cursor.idx;
            if (idx == null || idx < 0 || !chart) {
              setTooltip((prev) => ({ ...prev, show: false }));
              return;
            }
            const currentChart = chartRef.current;
            const timestamp = currentChart[0]?.[idx];
            if (typeof timestamp !== "number") {
              setTooltip((prev) => ({ ...prev, show: false }));
              return;
            }
            const bbox = u.root.getBoundingClientRect();
            const anchorX = u.valToPos(timestamp, "x");
            const rows = visibleTasks.map((task) => {
              const taskIndex = taskIndexById.get(task.id) ?? 0;
              const value = currentChart[taskIndex + 1]?.[idx] as number | null | undefined;
              return {
                label: taskLabels.get(task.id) ?? `任务 #${task.id}`,
                value: value == null ? "—" : `${value.toFixed(1)} ms`,
                color: taskColors.get(task.id) ?? colorForTask(taskIndex),
              };
            });
            const anchorY = typeof u.cursor.top === "number" ? u.cursor.top : bbox.height * 0.5;
            const position = getChartTooltipPosition({
              containerWidth: bbox.width,
              containerHeight: bbox.height,
              anchorX,
              anchorY,
              rowCount: rows.length,
              estimatedWidth: 196,
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
    };
  }, [chart, connectNulls, h, hiddenTasks, isDark, taskColors, taskIndexById, taskLabels, tasks, visibleTasks, w, xRange, yRange]);

  const taskStats = useMemo(() => {
    const grouped = new Map<number, PingRecord[]>();
    for (const record of data?.records ?? []) {
      const bucket = grouped.get(record.task_id);
      if (bucket) bucket.push(record);
      else grouped.set(record.task_id, [record]);
    }

    for (const records of grouped.values()) {
      records.sort((a, b) => toChartSeconds(a.time) - toChartSeconds(b.time));
    }

    return tasks.map((task, index) => {
      const records = grouped.get(task.id) ?? [];
      const positives = records
        .filter((record) => isValidPingLatency(record.value))
        .map((record) => record.value);
      const latest = [...records].reverse().find((record) => isValidPingLatency(record.value))?.value ?? null;
      const avg = positives.length
        ? positives.reduce((sum, value) => sum + value, 0) / positives.length
        : null;
      const min = positives.length ? Math.min(...positives) : null;
      const max = positives.length ? Math.max(...positives) : null;
      const p50 = percentile(positives, 0.5);
      const p99 = percentile(positives, 0.99);
      const volatility = p50 && p50 > 0 && p99 ? p99 / p50 : null;
      const total = records.length;
      const lost = records.filter((record) => isLostPingSample(record.value)).length;
      const loss = total > 0 ? (lost / total) * 100 : task.loss;
      return {
        ...task,
        latest,
        avg,
        min,
        max,
        p50,
        p99,
        volatility,
        total,
        lost,
        loss,
        color: taskColors.get(task.id) ?? colorForTask(index),
      };
    });
  }, [data, taskColors, tasks]);

  const toggleTask = (taskId: number) => {
    setHiddenTasks((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const toggleAll = () => {
    setHiddenTasks((prev) => (prev.size === 0 ? new Set(tasks.map((task) => task.id)) : new Set()));
  };

  const coverageSummary = useMemo(() => {
    if (xRange) return formatChartCoverageRange(xRange[0], xRange[1]);
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;
    for (const record of data?.records ?? []) {
      const time = toChartSeconds(record.time);
      if (time <= 0) continue;
      if (time < start) start = time;
      if (time > end) end = time;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) return "—";
    return formatChartCoverageRange(start, end);
  }, [data, xRange]);
  const rangeSummary = formatRangeSummary(hours);

  if (isLoading) {
    return <section className="instance-panel instance-chart-skeleton" aria-busy />;
  }

  if (!data?.records.length) {
    return (
      <InstancePanel title="Ping 图表">
        <div className="instance-empty">暂无延迟记录</div>
      </InstancePanel>
    );
  }

  return (
    <InstancePanel
      title="Ping 图表"
      aside={<span className="instance-chart-range-chip">{rangeSummary}</span>}
    >
      <div className="instance-ping-toolbar">
        <div className="instance-chart-meta" aria-label="图表数据范围">
          <span>
            覆盖 <strong>{coverageSummary}</strong>
          </span>
          <span>
            采样 <strong>{`${data.records.length} 个点`}</strong>
          </span>
          <span className="instance-chart-hint">框选缩放 · 双击还原</span>
        </div>
        <div className="instance-ping-toolbar-actions">
          <button
            type="button"
            className="instance-toggle-button instance-switch-button"
            data-active={cutPeak ? "true" : "false"}
            onClick={() => setCutPeak((value) => !value)}
            aria-pressed={cutPeak}
            title="对尖峰值做轻度平滑，仅影响图线显示"
          >
            <span className="instance-switch-copy">削峰平滑</span>
            <span className="instance-switch-track" aria-hidden>
              <span className="instance-switch-thumb" />
            </span>
            <span className="instance-switch-state">
              {cutPeak ? "开启" : "关闭"}
            </span>
          </button>
          <button
            type="button"
            className="instance-toggle-button instance-switch-button"
            data-active={connectNulls ? "true" : "false"}
            onClick={() => setConnectNulls((value) => !value)}
            aria-pressed={connectNulls}
          >
            <span className="instance-switch-copy">断点连线</span>
            <span className="instance-switch-track" aria-hidden>
              <span className="instance-switch-thumb" />
            </span>
            <span className="instance-switch-state">
              {connectNulls ? "开启" : "关闭"}
            </span>
          </button>
          <button type="button" className="instance-toggle-button" onClick={toggleAll}>
            {hiddenTasks.size === 0 ? <EyeOff size={14} /> : <Eye size={14} />}
            {hiddenTasks.size === 0 ? "隐藏全部" : "显示全部"}
          </button>
          <button type="button" className="instance-toggle-button" onClick={() => void refetch()}>
            <RefreshCw size={14} />
            刷新
          </button>
        </div>
      </div>

      <div className="instance-ping-tasks">
        {taskStats.map((task) => {
          const visible = !hiddenTasks.has(task.id);
          return (
            <button
              key={task.id}
              type="button"
              className="instance-ping-task"
              data-visible={visible ? "true" : "false"}
              aria-pressed={visible}
              onClick={() => toggleTask(task.id)}
              style={{ borderColor: visible ? task.color : "var(--border-subtle)" }}
              title={`最小 ${task.min != null ? `${task.min.toFixed(1)} ms` : "—"} | 最大 ${task.max != null ? `${task.max.toFixed(1)} ms` : "—"} | 样本 ${task.total ?? 0} | 间隔 ${task.interval}s`}
            >
              <div className="instance-ping-task-head">
                <span className="instance-ping-task-name">{taskLabels.get(task.id) ?? `任务 #${task.id}`}</span>
                <span
                  className="instance-ping-task-primary"
                  style={{ color: task.latest != null ? latencyHeatColor(task.latest) : "var(--text-tertiary)" }}
                >
                  {task.latest != null ? `${task.latest.toFixed(1)} ms` : "—"}
                </span>
              </div>
              <div className="instance-ping-task-stats">
                <span>均值 {task.avg != null ? `${task.avg.toFixed(1)} ms` : "—"}</span>
                <span style={{ color: lossHeatColor(task.loss) }}>丢包 {task.loss.toFixed(1)}%</span>
                <span>p99 {task.p99 != null ? `${task.p99.toFixed(0)} ms` : "—"}</span>
                <span>抖动 {task.volatility != null ? task.volatility.toFixed(2) : "—"}</span>
              </div>
              <div className="instance-ping-task-meta">
                <span>min {task.min != null ? `${task.min.toFixed(0)} ms` : "—"}</span>
                <span>max {task.max != null ? `${task.max.toFixed(0)} ms` : "—"}</span>
                <span>样本 {task.total ?? 0}</span>
                <span>{task.interval}s</span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="instance-uplot-wrap is-large" ref={wrapRef}>
        {chart && options ? (
          <>
            <UplotReact options={options} data={chart} />
            {tooltip.show && (
              <div
                className="instance-chart-tooltip"
                style={{ left: tooltip.left, top: tooltip.top }}
              >
                <div className="instance-chart-tooltip-time">{tooltip.time}</div>
                {tooltip.rows.map((row) => (
                  <div key={`${row.label}-${row.color}`} className="instance-chart-tooltip-row">
                    <span className="instance-chart-tooltip-dot" style={{ background: row.color }} />
                    <span>{row.label}</span>
                    <strong>{row.value}</strong>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="instance-empty">当前已隐藏全部线路，点击上方按钮可恢复显示</div>
        )}
      </div>
    </InstancePanel>
  );
}
