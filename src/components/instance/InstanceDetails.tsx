import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useNode, useNodeStoreStatus } from "@/hooks/useNode";
import {
  formatBillingCycle,
  formatBytes,
  formatExpireDays,
  formatOfflineDuration,
  formatPriceLabel,
  formatUptimeDays,
  parseTags,
} from "@/utils/format";
import { getExpireTextColor } from "@/utils/expireStatus";
import { Flag } from "@/components/ui/Flag";

const NODE_LOOKUP_TIMEOUT_MS = 6000;

function buildSubtitle(parts: Array<string | null | undefined>) {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

export function InstanceDetails({ uuid }: { uuid: string }) {
  const node = useNode(uuid);
  const { lastSuccessAt } = useNodeStoreStatus();
  const [lookupTimedOut, setLookupTimedOut] = useState(false);

  useEffect(() => {
    setLookupTimedOut(false);
    const timer = window.setTimeout(
      () => setLookupTimedOut(true),
      NODE_LOOKUP_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [uuid]);

  const tags = useMemo(() => parseTags(node?.tags), [node?.tags]);

  if (!node) {
    if (lastSuccessAt > 0 || lookupTimedOut) {
      return (
        <section className="instance-panel">
          <div className="instance-empty instance-empty-stack">
            <span>未找到该节点，它可能已被移除或未公开。</span>
            <Link to="/" className="instance-toggle-button">
              返回节点列表
            </Link>
          </div>
        </section>
      );
    }
    return <section className="instance-panel instance-details-skeleton" aria-busy />;
  }

  const isOnline = node.online === true;
  const isOffline = node.online === false;
  const uptime = formatUptimeDays(node.uptime);
  const offlineFor = isOffline ? formatOfflineDuration(node.updatedAt) : null;
  const expire = formatExpireDays(node.expired_at);
  const trafficUsed = node.trafficUp + node.trafficDown;
  const trafficFraction =
    node.traffic_limit > 0
      ? Math.max(0, Math.min(1, trafficUsed / node.traffic_limit))
      : 0;
  const lastUpdated =
    node.updatedAt > 0
      ? new Intl.DateTimeFormat("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }).format(node.updatedAt)
      : "—";
  const subtitle =
    buildSubtitle([node.os, node.arch, node.virtualization]) || "暂无系统信息";
  const priceLabel = formatPriceLabel(node.price, node.billing_cycle, node.currency);
  const hasServiceInfo = Boolean(
    node.group || node.region || node.expired_at || priceLabel || node.public_remark || tags.length,
  );

  return (
    <section className="instance-panel">
      <header className="instance-hero-header">
        <div className="instance-hero-title-block">
          <div className="instance-hero-title-row">
            <Flag region={node.region} size={20} />
            <h1 className="instance-hero-title" title={node.name || uuid}>
              {node.name || uuid}
            </h1>
          </div>
          <p className="instance-hero-subtitle">{subtitle}</p>
        </div>
        <div className="instance-hero-actions">
          {tags.slice(0, 3).map((tag) => (
            <span key={tag.label} className="instance-hero-tag">
              {tag.label}
            </span>
          ))}
          <span
            className="instance-state-chip"
            data-online={isOnline ? "true" : "false"}
          >
            {isOnline ? "在线" : isOffline ? "离线" : "未知"}
          </span>
        </div>
      </header>

      {isOffline && (
        <p className="instance-panel-notice">
          {`节点当前离线（${offlineFor?.full ?? "离线时长未知"}），以下展示最近一次上报的缓存数据。`}
        </p>
      )}

      <div className="instance-info-groups">
        <div className="instance-info-group">
          <div className="instance-info-group-title">系统</div>
          <InfoRow
            label="CPU"
            value={`${node.cpu_name || "—"}${node.cpu_cores > 0 ? ` (x${node.cpu_cores})` : ""}`}
          />
          <InfoRow label="操作系统" value={node.os || "—"} />
          {node.kernel_version ? (
            <InfoRow label="内核" value={node.kernel_version} />
          ) : null}
          <InfoRow label="架构" value={node.arch || "—"} />
          <InfoRow label="虚拟化" value={node.virtualization || "—"} />
          {node.gpu_name ? <InfoRow label="显卡" value={node.gpu_name} /> : null}
        </div>

        <div className="instance-info-group">
          <div className="instance-info-group-title">资源</div>
          <InfoRow label="内存" value={`${formatBytes(node.ramUsed)} / ${formatBytes(node.ramTotal)}`} />
          <InfoRow
            label="Swap"
            value={
              node.swapTotal > 0
                ? `${formatBytes(node.swapUsed)} / ${formatBytes(node.swapTotal)}`
                : "无"
            }
          />
          <InfoRow label="磁盘" value={`${formatBytes(node.diskUsed)} / ${formatBytes(node.diskTotal)}`} />
          <InfoRow
            label="负载"
            value={`${node.load1.toFixed(2)} | ${node.load5.toFixed(2)} | ${node.load15.toFixed(2)}`}
          />
          <InfoRow label="进程" value={node.process > 0 ? `${node.process}` : "—"} />
          <InfoRow
            label="运行时长"
            value={uptime.unit ? `${uptime.value} ${uptime.unit}` : uptime.value}
          />
        </div>

        <div className="instance-info-group">
          <div className="instance-info-group-title">网络</div>
          <InfoRow
            label={isOnline ? "实时网络" : "缓存网络"}
            value={`↑ ${formatBytes(node.netUp)}/s · ↓ ${formatBytes(node.netDown)}/s`}
          />
          <InfoRow
            label="连接数"
            value={`TCP ${node.connectionsTcp} · UDP ${node.connectionsUdp}`}
          />
          <InfoRow label={isOnline ? "最近更新" : "最后上报"} value={lastUpdated} />
          <div className="instance-info-item is-stack">
            <span className="instance-info-label">总流量</span>
            <div className="instance-info-traffic">
              <span className="instance-info-value">{`↑ ${formatBytes(node.trafficUp)} · ↓ ${formatBytes(node.trafficDown)}`}</span>
              {node.traffic_limit > 0 && (
                <>
                  <div className="instance-progress-track" aria-hidden>
                    <span
                      className="instance-progress-fill"
                      style={{ width: `${trafficFraction * 100}%` }}
                    />
                  </div>
                  <span className="instance-info-note">
                    {`${formatBytes(trafficUsed)} / ${formatBytes(node.traffic_limit)}`}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {hasServiceInfo && (
          <div className="instance-info-group">
            <div className="instance-info-group-title">服务</div>
            {node.group ? <InfoRow label="分组" value={node.group} /> : null}
            {node.region ? <InfoRow label="地区" value={node.region} /> : null}
            {node.expired_at ? (
              <InfoRow
                label="到期"
                value={
                  <span style={{ color: getExpireTextColor(node.expired_at) }}>
                    {expire.unit ? `${expire.value} ${expire.unit}` : expire.value}
                    {node.auto_renewal ? " · 自动续费" : ""}
                  </span>
                }
              />
            ) : null}
            {priceLabel ? (
              <InfoRow
                label="价格"
                value={`${priceLabel}${formatBillingCycle(node.billing_cycle) ? ` / ${formatBillingCycle(node.billing_cycle)}` : ""}`}
              />
            ) : null}
            {node.public_remark ? (
              <InfoRow label="备注" value={node.public_remark} />
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

function InfoRow({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="instance-info-item">
      <span className="instance-info-label">{label}</span>
      <div className="instance-info-value">{value}</div>
    </div>
  );
}
