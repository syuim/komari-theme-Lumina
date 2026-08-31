import { memo } from "react";
import { Link } from "react-router-dom";
import { Cpu, MemoryStick, HardDrive, ArrowDown, ArrowUp } from "lucide-react";
import { useNode } from "@/hooks/useNode";
import {
  formatBytesShort,
  formatTrafficRate,
  formatUptimeDays,
  shortRateUnit,
} from "@/utils/format";
import { Flag } from "@/components/ui/Flag";
import { clsx } from "clsx";

function trafficBarColor(pct: number): string {
  if (pct > 90) return "var(--status-offline)";
  if (pct > 75) return "#eab308";
  return "var(--progress-cpu)";
}

export const NodeListItem = memo(function NodeListItem({ uuid }: { uuid: string }) {
  const node = useNode(uuid);

  if (!node) {
    return <div className="node-list-row is-skeleton" />;
  }

  const uptime = formatUptimeDays(node.uptime);
  const upRate = formatTrafficRate(node.netUp);
  const downRate = formatTrafficRate(node.netDown);
  const isOnline = node.online === true;
  const isOffline = node.online === false;

  const trafficTotal = node.trafficUp + node.trafficDown;
  const trafficPct =
    node.traffic_limit > 0 ? Math.min(100, (trafficTotal / node.traffic_limit) * 100) : 0;
  const barColor = trafficBarColor(trafficPct);

  return (
    <div className={clsx("node-list-row", isOffline && "is-offline")}>
      <div className="node-list-left">
        <Flag region={node.region} size={14} />
        <Link to={`/instance/${node.uuid}`} className="node-list-name" title={node.name}>
          {node.name}
        </Link>
        <span
          className={clsx("node-list-dot", isOffline && "is-offline")}
          style={{
            background:
              node.online == null
                ? "var(--text-tertiary)"
                : isOnline
                  ? "var(--status-online)"
                  : "var(--status-offline)",
            boxShadow: `0 0 0 3px color-mix(in srgb, ${
              node.online == null
                ? "var(--text-tertiary)"
                : isOnline
                  ? "var(--status-online)"
                  : "var(--status-offline)"
            } 20%, transparent)`,
          }}
          title={node.online == null ? "状态同步中" : isOnline ? "在线" : "离线"}
        />
      </div>

      <div className="node-list-metrics">
        <span className="node-list-metric">
          <Cpu size={11} strokeWidth={2} />
          <span className="node-list-metric-track">
            <span
              className="node-list-metric-fill"
              style={{ width: `${Math.min(node.cpuPct, 100)}%`, background: "var(--progress-cpu)" }}
            />
          </span>
          <span className="node-list-metric-detail">{node.cpu_cores}核</span>
          <span className="node-list-metric-val">{node.cpuPct.toFixed(1)}%</span>
        </span>
        <span className="node-list-metric">
          <MemoryStick size={11} strokeWidth={2} />
          <span className="node-list-metric-track">
            <span
              className="node-list-metric-fill"
              style={{ width: `${Math.min(node.ramPct, 100)}%`, background: "var(--progress-memory)" }}
            />
          </span>
          <span className="node-list-metric-detail">{formatBytesShort(node.ramUsed)}/{formatBytesShort(node.ramTotal)}</span>
          <span className="node-list-metric-val">{node.ramPct.toFixed(1)}%</span>
        </span>
        <span className="node-list-metric">
          <HardDrive size={11} strokeWidth={2} />
          <span className="node-list-metric-track">
            <span
              className="node-list-metric-fill"
              style={{ width: `${Math.min(node.diskPct, 100)}%`, background: "var(--progress-disk)" }}
            />
          </span>
          <span className="node-list-metric-detail">{formatBytesShort(node.diskUsed)}/{formatBytesShort(node.diskTotal)}</span>
          <span className="node-list-metric-val">{node.diskPct.toFixed(1)}%</span>
        </span>
      </div>

      <div className="node-list-traffic-block">
        <span className="node-list-rate" style={{ color: "var(--progress-cpu)" }}>
          <ArrowUp size={12} strokeWidth={2.4} />
          {upRate.value}
          <span className="node-list-rate-unit">{shortRateUnit(upRate.unit)}</span>
        </span>
        <span className="node-list-rate" style={{ color: "var(--status-success)" }}>
          <ArrowDown size={12} strokeWidth={2.4} />
          {downRate.value}
          <span className="node-list-rate-unit">{shortRateUnit(downRate.unit)}</span>
        </span>
        {node.traffic_limit > 0 && (
          <span className="node-list-traffic-bar">
            <span className="node-list-traffic-track">
              <span
                className="node-list-traffic-fill"
                style={{ width: `${trafficPct}%`, background: barColor }}
              />
            </span>
            <span className="node-list-traffic-pct" style={{ color: barColor }}>
              {trafficPct.toFixed(1)}%
            </span>
          </span>
        )}
      </div>

      <div className="node-list-status">
        <span className="node-list-online" title={isOnline ? "在线" : "离线"}>
          {isOnline ? `${uptime.value}${uptime.unit}` : "离线"}
        </span>
      </div>
    </div>
  );
});