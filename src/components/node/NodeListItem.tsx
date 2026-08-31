import { memo } from "react";
import { Link } from "react-router-dom";
import { Cpu, MemoryStick, HardDrive, ArrowDown, ArrowUp } from "lucide-react";
import { useNode } from "@/hooks/useNode";
import {
  formatBytesShort,
  formatExpireDays,
  formatTrafficRate,
  formatUptimeDays,
  parseTags,
  shortRateUnit,
} from "@/utils/format";
import { getExpireTextColor } from "@/utils/expireStatus";
import { Flag } from "@/components/ui/Flag";
import { clsx } from "clsx";

export const NodeListItem = memo(function NodeListItem({ uuid }: { uuid: string }) {
  const node = useNode(uuid);

  if (!node) {
    return <div className="node-list-row is-skeleton" />;
  }

  const tags = parseTags(node.tags);
  const expire = formatExpireDays(node.expired_at);
  const uptime = formatUptimeDays(node.uptime);
  const upRate = formatTrafficRate(node.netUp);
  const downRate = formatTrafficRate(node.netDown);
  const isOnline = node.online === true;
  const isOffline = node.online === false;

  return (
    <div className={clsx("node-list-row", isOffline && "is-offline")}>
      <div className="node-list-left">
        <Flag region={node.region} size={15} />
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
        {tags.length > 0 && (
          <span className="node-list-tags">
            {tags.slice(0, 3).map((tag, i) => (
              <span key={i} className="node-list-tag">
                {tag.label}
              </span>
            ))}
          </span>
        )}
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
          <span className="node-list-metric-val">{node.diskPct.toFixed(1)}%</span>
        </span>
      </div>

      <div className="node-list-right">
        <span className="node-list-traffic">
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
        </span>
        <span className="node-list-total">
          出站 {formatBytesShort(node.trafficUp)}
          <span className="node-list-total-sep">/</span>
          入站 {formatBytesShort(node.trafficDown)}
        </span>
        <span className="node-list-status">
          <span className="node-list-expire" style={{ color: getExpireTextColor(node.expired_at) }}>
            <span className="node-list-status-label">到期</span>
            {expire.value}
            {expire.unit}
          </span>
          <span className="node-list-uptime">
            在线 {isOnline ? `${uptime.value} ${uptime.unit}` : "—"}
          </span>
        </span>
      </div>
    </div>
  );
});