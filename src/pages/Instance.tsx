import { startTransition, useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { InstanceDetails } from "@/components/instance/InstanceDetails";
import { PingChart } from "@/components/instance/PingChart";
import { LoadChart } from "@/components/instance/LoadChart";
import {
  buildLoadTimeRangeOptions,
  buildPingTimeRangeOptions,
} from "@/components/instance/chartShared";
import { useNode } from "@/hooks/useNode";
import { usePublicConfig } from "@/hooks/usePublicConfig";
import type { PublicConfig } from "@/types/komari";

const DEFAULT_PING_HOURS = 24;
const BASE_DOCUMENT_TITLE =
  typeof document !== "undefined" ? document.title : "Komari Monitor";

function getMetricRetentionHours(config: PublicConfig | undefined) {
  const legacyHours = config?.record_preserve_time ?? 0;
  if (legacyHours > 0) return legacyHours;
  const metricRetentionDays = config?.metric_retention_days ?? 0;
  return metricRetentionDays > 0 ? metricRetentionDays * 24 : 0;
}

function getPingRetentionHours(config: PublicConfig | undefined) {
  const pingHours = config?.ping_record_preserve_time ?? 0;
  if (pingHours > 0) return pingHours;
  return getMetricRetentionHours(config);
}

export function Instance() {
  const { uuid } = useParams<{ uuid: string }>();
  const { data: config } = usePublicConfig();
  const node = useNode(uuid ?? "");
  const [chartType, setChartType] = useState<"load" | "ping">("load");
  const [loadHours, setLoadHours] = useState(0);
  const [pingHours, setPingHours] = useState(DEFAULT_PING_HOURS);

  const loadRanges = useMemo(
    () => buildLoadTimeRangeOptions(getMetricRetentionHours(config)),
    [config],
  );
  const pingRanges = useMemo(
    () => buildPingTimeRangeOptions(getPingRetentionHours(config)),
    [config],
  );
  const showPingChart = config?.theme_settings?.showPingChart !== false;
  const activeRanges = chartType === "load" ? loadRanges : pingRanges;
  const activeHours = chartType === "load" ? loadHours : pingHours;
  const nodeName = node?.name ?? "";
  const siteTitle = config?.sitename || BASE_DOCUMENT_TITLE;

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [uuid]);

  useEffect(() => {
    if (!nodeName) return;
    document.title = `${nodeName} · ${siteTitle}`;
    return () => {
      document.title = siteTitle;
    };
  }, [nodeName, siteTitle]);

  useEffect(() => {
    if (!loadRanges.some((range) => range.value === loadHours)) {
      setLoadHours(loadRanges[0]?.value ?? 0);
    }
  }, [loadHours, loadRanges]);

  useEffect(() => {
    if (pingRanges.length === 0) return;
    if (!pingRanges.some((range) => range.value === pingHours)) {
      const fallback =
        pingRanges.find((range) => range.value === DEFAULT_PING_HOURS) ??
        pingRanges[pingRanges.length - 1];
      setPingHours(fallback.value);
    }
  }, [pingHours, pingRanges]);

  useEffect(() => {
    if (!showPingChart && chartType === "ping") {
      setChartType("load");
    }
  }, [chartType, showPingChart]);

  if (!uuid) return null;

  return (
    <div className="flex flex-col gap-5 py-2">
      <Link to="/" className="instance-page-back">
        <ChevronLeft size={14} />
        返回
      </Link>
      <InstanceDetails uuid={uuid} />
      <div className="instance-chart-controls">
        <div className="instance-segmented">
          <button
            type="button"
            data-active={chartType === "load" ? "true" : "false"}
            onClick={() => {
              startTransition(() => setChartType("load"));
            }}
          >
            负载
          </button>
          {showPingChart && (
            <button
              type="button"
              data-active={chartType === "ping" ? "true" : "false"}
              onClick={() => {
                startTransition(() => setChartType("ping"));
              }}
            >
              Ping
            </button>
          )}
        </div>
        {activeRanges.length > 1 && (
          <div
            key={`${chartType}-ranges`}
            className="instance-segmented is-scrollable"
          >
            {activeRanges.map((range) => (
              <button
                key={range.value}
                type="button"
                data-active={activeHours === range.value ? "true" : "false"}
                onClick={() => {
                  startTransition(() => {
                    if (chartType === "load") setLoadHours(range.value);
                    else setPingHours(range.value);
                  });
                }}
              >
                {range.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="instance-chart-stage">
        <div
          className="instance-chart-view"
          hidden={chartType !== "load"}
          aria-hidden={chartType !== "load"}
        >
          <LoadChart uuid={uuid} hours={loadHours} active={chartType === "load"} />
        </div>
        <div
          className="instance-chart-view"
          hidden={chartType !== "ping"}
          aria-hidden={chartType !== "ping"}
        >
          {showPingChart ? (
            <PingChart
              uuid={uuid}
              hours={pingHours}
              active={chartType === "ping"}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
