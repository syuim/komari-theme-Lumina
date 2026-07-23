import { z } from "zod";
import { getRpc2Client } from "@/services/rpc2Client";
import {
  MeSchema,
  NodeInfoSchema,
  PublicConfigSchema,
  AdminClientSchema,
  VersionSchema,
  LoadRecordSchema,
  PingRecordSchema,
  PingTaskSchema,
  PingBasicInfoSchema,
  type Me,
  type NodeInfo,
  type PublicConfig,
  type AdminClient,
  type Version,
  type LoadRecordsResponse,
  type PingRecordsResponse,
  type PingTask,
  type PingBasicInfo,
} from "@/types/komari";

const ApiEnvelope = <T extends z.ZodTypeAny>(inner: T) =>
  z.object({
    status: z.string().optional(),
    message: z.string().optional(),
    data: inner,
  });

const RpcRecordsSchema = z
  .object({
    count: z.number().default(0),
    records: z.unknown().optional(),
    tasks: z.unknown().optional(),
    basic_info: z.unknown().optional(),
    from: z.union([z.string(), z.number()]).optional(),
    to: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const PublicMetricPointSchema = z
  .object({
    time: z.union([z.string(), z.number()]),
    value: z.number().nullable().optional(),
    count: z.number().default(0),
    tag: z.record(z.string(), z.string()).optional(),
    tags: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

const PublicMetricSeriesSchema = z
  .object({
    metric_key: z.string(),
    entity_id: z.string().default(""),
    tag: z.record(z.string(), z.string()).optional(),
    tags: z.record(z.string(), z.string()).optional(),
    points: z.array(PublicMetricPointSchema).default([]),
  })
  .passthrough();

const PublicQueryMetricsSchema = z
  .object({
    start: z.union([z.string(), z.number()]).optional(),
    end: z.union([z.string(), z.number()]).optional(),
    series: z.array(PublicMetricSeriesSchema).default([]),
    count: z.number().default(0),
  })
  .passthrough();

// agent 默认每分钟上报一条；服务端会按 maxCount 在整个时间窗内均匀抽样，
// 所以按图表实际渲染上限索取即可：短区间拿到分钟级细节，长区间也不会拉回几 MB。
const LOAD_RECORDS_PER_HOUR = 60;
const LOAD_MIN_POINTS = 120;
const LOAD_MAX_POINTS = 720;
const PING_RECORDS_PER_HOUR = 240;
const MAX_RPC_RECORDS = 20_000;
const OVERVIEW_PING_MAX_COUNT = 4_000;
const PING_LATENCY_METRIC = "ping.latency_ms";
const PING_LOSS_METRIC = "ping.loss";

interface RpcRecordsPayload {
  count?: number;
  records?: unknown;
  tasks?: unknown;
  basic_info?: unknown;
  from?: string | number;
  to?: string | number;
}

type PublicMetricSeries = z.input<typeof PublicMetricSeriesSchema>;
type PublicMetricPoint = z.input<typeof PublicMetricPointSchema>;

export interface PingOverviewResponse {
  count: number;
  records: PingRecordsResponse["records"];
  tasks: PingTask[];
  basicInfo: PingBasicInfo[];
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

function normalizeRpcLatestStatus(
  payload: unknown,
): Record<string, unknown> {
  const direct = z.record(z.string(), z.unknown()).safeParse(payload);
  if (direct.success) {
    return direct.data;
  }

  const wrapped = z
    .object({
      records: z.record(z.string(), z.unknown()).default({}),
    })
    .passthrough()
    .safeParse(payload);
  if (wrapped.success) {
    return wrapped.data.records;
  }

  return {};
}

function normalizeNodeListPayload(payload: unknown): NodeInfo[] {
  const arrayResult = z.array(NodeInfoSchema).safeParse(payload);
  if (arrayResult.success) {
    return arrayResult.data;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Schema mismatch on nodes: expected node array or uuid-keyed map");
  }

  return Object.entries(payload as Record<string, unknown>).map(([uuid, value]) =>
    NodeInfoSchema.parse(
      value && typeof value === "object" && !Array.isArray(value)
        ? { uuid, ...value }
        : value,
    ),
  );
}

function getLoadRecordsMaxCount(hours: number) {
  const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 1;
  return Math.min(
    LOAD_MAX_POINTS,
    Math.max(LOAD_MIN_POINTS, Math.ceil(safeHours * LOAD_RECORDS_PER_HOUR)),
  );
}

function getRecordsMaxCount(hours: number, recordsPerHour: number) {
  const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 1;
  return Math.min(
    MAX_RPC_RECORDS,
    Math.max(recordsPerHour, Math.ceil(safeHours * recordsPerHour)),
  );
}

function finiteMetricValue(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getTaskIdFromTags(...items: Array<Record<string, string> | undefined>) {
  for (const tags of items) {
    const raw = tags?.task_id;
    if (!raw) continue;
    const taskId = Number(raw);
    if (Number.isInteger(taskId) && taskId > 0) return taskId;
  }
  return null;
}

function getPointTags(series: PublicMetricSeries, point: PublicMetricPoint) {
  return point.tags ?? point.tag ?? series.tags ?? series.tag;
}

function taskAppliesToClient(task: PingTask, uuid: string) {
  if (!uuid) return true;
  return task.clients.includes(uuid);
}

function filterPingTasks(
  tasks: PingTask[],
  records: PingRecordsResponse["records"],
  uuid = "",
) {
  const recordTaskIds = new Set(records.map((record) => record.task_id));
  const filtered = tasks.filter((task) =>
    recordTaskIds.has(task.id) || taskAppliesToClient(task, uuid),
  );
  return filtered.length > 0 ? filtered : derivePingTasks(records);
}

function pingRecordsFromMetricSeries(series: PublicMetricSeries[]) {
  type Entry = {
    client: string;
    taskId: number;
    time: string | number;
    latency?: number;
    loss?: number;
  };
  const entries = new Map<string, Entry>();

  for (const item of series) {
    if (item.metric_key !== PING_LATENCY_METRIC && item.metric_key !== PING_LOSS_METRIC) {
      continue;
    }
    if (!item.entity_id) continue;

    for (const point of item.points ?? []) {
      const value = finiteMetricValue(point.value);
      if (value == null) continue;

      const tags = getPointTags(item, point);
      const taskId = getTaskIdFromTags(tags);
      if (taskId == null) continue;

      const time = point.time;
      const key = `${item.entity_id}\u0000${taskId}\u0000${String(time)}`;
      const entry = entries.get(key) ?? {
        client: item.entity_id,
        taskId,
        time,
      };
      if (item.metric_key === PING_LATENCY_METRIC) {
        entry.latency = value;
      } else {
        entry.loss = value;
      }
      entries.set(key, entry);
    }
  }

  const records: PingRecordsResponse["records"] = [];
  for (const entry of entries.values()) {
    let value: number | null = null;
    if (entry.latency != null && entry.latency >= 0) {
      value = entry.latency;
    } else if ((entry.latency != null && entry.latency < 0) || (entry.loss != null && entry.loss > 0)) {
      value = -1;
    }
    if (value == null) continue;

    records.push({
      task_id: entry.taskId,
      time: entry.time,
      value,
      client: entry.client,
    });
  }

  return records.sort((left, right) => {
    const leftTime = Date.parse(String(left.time));
    const rightTime = Date.parse(String(right.time));
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    if (left.client !== right.client) return left.client.localeCompare(right.client);
    return left.task_id - right.task_id;
  });
}

async function queryPingMetricSeries({
  hours,
  uuid,
  taskId,
  maxPoints,
}: {
  hours: number;
  uuid?: string;
  taskId?: number;
  maxPoints: number;
}) {
  return await rpcCall(
    "public:queryMetrics",
    {
      metric_keys: [PING_LATENCY_METRIC, PING_LOSS_METRIC],
      hours,
      max_points: maxPoints,
      server_downsample: true,
      fill_empty: false,
      aggregation: "avg",
      ...(uuid ? { entity_id: uuid } : {}),
      ...(taskId ? { tags: { task_id: String(taskId) } } : {}),
    },
    PublicQueryMetricsSchema,
  );
}

async function apiGet<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const resp = await fetch(path, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) {
    throw new ApiRequestError(`Request ${path} failed: ${resp.status}`, resp.status, path);
  }
  const json = (await resp.json()) as unknown;
  const envelopeResult = ApiEnvelope(schema).safeParse(json);
  if (envelopeResult.success) return envelopeResult.data.data as T;
  const rawResult = schema.safeParse(json);
  if (rawResult.success) return rawResult.data;
  throw new Error(
    `Schema mismatch on ${path}: ${envelopeResult.error.issues[0]?.message ?? ""}`,
  );
}

async function rpcCall<T>(
  method: string,
  params: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const payload = await getRpc2Client().call(method, params);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `Schema mismatch on rpc:${method}: ${parsed.error.issues[0]?.message ?? ""}`,
    );
  }
  return parsed.data;
}

function normalizeRpcLoadRecords(
  uuid: string,
  payload: RpcRecordsPayload,
): LoadRecordsResponse {
  const rawRecords = Array.isArray(payload.records)
    ? payload.records
    : payload.records &&
        typeof payload.records === "object" &&
        Array.isArray((payload.records as Record<string, unknown>)[uuid])
      ? (payload.records as Record<string, unknown>)[uuid]
      : [];
  const records = z.array(LoadRecordSchema).parse(rawRecords);
  return {
    count: payload.count || records.length,
    records,
  };
}

function derivePingTasks(records: PingRecordsResponse["records"]): PingTask[] {
  return Array.from(new Set(records.map((record) => record.task_id)))
    .sort((a, b) => a - b)
    .map((id) => ({
      id,
      interval: 60,
      name: `任务 #${id}`,
      loss: 0,
      clients: [],
      type: "icmp",
      target: "",
      weight: id,
    }));
}

function normalizeRpcPingRecords(
  payload: RpcRecordsPayload,
): PingRecordsResponse {
  const records = z.array(PingRecordSchema).parse(
    Array.isArray(payload.records) ? payload.records : [],
  );
  const parsedTasks = z.array(PingTaskSchema).safeParse(payload.tasks);
  const tasks = parsedTasks.success ? parsedTasks.data : derivePingTasks(records);
  return {
    count: payload.count || records.length,
    records,
    tasks,
    from: payload.from,
    to: payload.to,
  };
}

function normalizeRpcPingOverview(
  payload: RpcRecordsPayload,
): PingOverviewResponse {
  const records = z.array(PingRecordSchema).parse(
    Array.isArray(payload.records) ? payload.records : [],
  );
  const parsedTasks = z.array(PingTaskSchema).safeParse(payload.tasks);
  const basicInfo = z.array(PingBasicInfoSchema).safeParse(payload.basic_info);
  return {
    count: payload.count || records.length,
    records,
    tasks: parsedTasks.success ? parsedTasks.data : derivePingTasks(records),
    basicInfo: basicInfo.success ? basicInfo.data : [],
  };
}

async function getMetricPingRecords(
  uuid: string,
  hours: number,
): Promise<PingRecordsResponse> {
  const [tasks, metrics] = await Promise.all([
    getPublicPingTasks(),
    queryPingMetricSeries({
      uuid,
      hours,
      maxPoints: getRecordsMaxCount(hours, PING_RECORDS_PER_HOUR),
    }),
  ]);
  const records = pingRecordsFromMetricSeries(metrics.series ?? []);

  return {
    count: records.length,
    records,
    tasks: filterPingTasks(tasks, records, uuid),
    from: metrics.start,
    to: metrics.end,
  };
}

async function getMetricPingOverview(
  hours: number,
  taskId?: number,
): Promise<PingOverviewResponse> {
  const [tasks, metrics] = await Promise.all([
    getPublicPingTasks(),
    queryPingMetricSeries({
      hours,
      taskId,
      maxPoints: OVERVIEW_PING_MAX_COUNT,
    }),
  ]);
  const records = pingRecordsFromMetricSeries(metrics.series ?? []);
  const selectedTasks = taskId
    ? tasks.filter((task) => task.id === taskId)
    : filterPingTasks(tasks, records);

  return {
    count: records.length,
    records,
    tasks: selectedTasks.length > 0 ? selectedTasks : derivePingTasks(records),
    basicInfo: [],
  };
}

export async function getMe(): Promise<Me> {
  return (await apiGet("/api/me", MeSchema)) as Me;
}

export async function getPublic(): Promise<PublicConfig> {
  return (await apiGet("/api/public", PublicConfigSchema)) as PublicConfig;
}

export async function getVersion(): Promise<Version> {
  return (await apiGet("/api/version", VersionSchema)) as Version;
}

export async function getNodesLatestStatus(
  uuids?: string[],
): Promise<Record<string, unknown>> {
  const payload = await rpcCall(
    "common:getNodesLatestStatus",
    uuids && uuids.length > 0 ? { uuids } : {},
    z.unknown(),
  );
  return normalizeRpcLatestStatus(payload);
}

export async function getNodes(): Promise<NodeInfo[]> {
  try {
    return normalizeNodeListPayload(await apiGet("/api/nodes", z.unknown()));
  } catch {
    const payload = await rpcCall("common:getNodes", {}, z.unknown());
    return normalizeNodeListPayload(payload);
  }
}

export async function getAdminClients(): Promise<AdminClient[]> {
  return (await apiGet("/api/admin/client/list", z.array(AdminClientSchema))) as AdminClient[];
}

export async function getLoadRecords(
  uuid: string,
  hours = 6,
): Promise<LoadRecordsResponse> {
  try {
    const maxCount = getLoadRecordsMaxCount(hours);
    const payload = await rpcCall(
      "common:getRecords",
      {
        uuid,
        hours,
        type: "load",
        maxCount,
      },
      RpcRecordsSchema,
    );
    return normalizeRpcLoadRecords(uuid, payload);
  } catch {
    return (await apiGet(
      `/api/records/load?uuid=${encodeURIComponent(uuid)}&hours=${hours}`,
      z.object({
        count: z.number().default(0),
        records: z.array(LoadRecordSchema).default([]),
      }),
    )) as LoadRecordsResponse;
  }
}

export async function getPingRecords(
  uuid: string,
  hours = 6,
): Promise<PingRecordsResponse> {
  try {
    return await getMetricPingRecords(uuid, hours);
  } catch {
    // Older Komari builds do not expose public:queryMetrics; keep legacy records fallback.
  }

  try {
    const maxCount = getRecordsMaxCount(hours, PING_RECORDS_PER_HOUR);
    const payload = await rpcCall(
      "common:getRecords",
      {
        uuid,
        hours,
        type: "ping",
        maxCount,
      },
      RpcRecordsSchema,
    );
    return normalizeRpcPingRecords(payload);
  } catch {
    return (await apiGet(
      `/api/records/ping?uuid=${encodeURIComponent(uuid)}&hours=${hours}`,
      z.object({
        count: z.number().default(0),
        records: z.array(PingRecordSchema).default([]),
        tasks: z.array(PingTaskSchema).default([]),
      }),
    )) as PingRecordsResponse;
  }
}

export async function getPublicPingTasks(): Promise<PingTask[]> {
  return (await apiGet("/api/task/ping", z.array(PingTaskSchema))) as PingTask[];
}

export async function getAdminPingTasks(): Promise<PingTask[]> {
  return (await apiGet("/api/admin/ping", z.array(PingTaskSchema))) as PingTask[];
}

export async function saveThemeSettings(
  theme: string,
  settings: Record<string, unknown>,
): Promise<void> {
  const resp = await fetch(`/api/admin/theme/settings?theme=${encodeURIComponent(theme)}`, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(settings),
  });

  if (!resp.ok) {
    let message = `Request /api/admin/theme/settings failed: ${resp.status}`;
    try {
      const json = (await resp.json()) as { message?: string };
      if (json?.message) {
        message = json.message;
      }
    } catch {
      // Keep the fallback error message when the body is not JSON.
    }
    throw new ApiRequestError(message, resp.status, "/api/admin/theme/settings");
  }
}

export async function getPingOverview(
  hours = 1,
  taskId?: number,
): Promise<PingOverviewResponse> {
  try {
    return await getMetricPingOverview(hours, taskId);
  } catch {
    // Fall back to the legacy ping records API when metric series are unavailable.
  }

  try {
    const payload = await rpcCall(
      "common:getRecords",
      {
        hours,
        type: "ping",
        ...(taskId ? { task_id: taskId } : {}),
        maxCount: OVERVIEW_PING_MAX_COUNT,
      },
      RpcRecordsSchema,
    );
    return normalizeRpcPingOverview(payload);
  } catch {
    if (!taskId) {
      throw new Error("Ping overview fallback requires a concrete task_id");
    }

    const data = await apiGet(
      `/api/records/ping?task_id=${encodeURIComponent(taskId)}&hours=${hours}`,
      z.object({
        count: z.number().default(0),
        records: z.array(PingRecordSchema).default([]),
        tasks: z.array(PingTaskSchema).default([]),
        basic_info: z.array(PingBasicInfoSchema).default([]),
      }),
    );
    return {
      count: data.count,
      records: data.records,
      tasks: data.tasks,
      basicInfo: data.basic_info,
    } as PingOverviewResponse;
  }
}
