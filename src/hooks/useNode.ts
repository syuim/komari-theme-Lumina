import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  ensureStarted,
  getNodeSnapshot,
  getNodeTrafficTrendSnapshot,
  getStoreStatusSnapshot,
  getVisibleNodeUuidsSnapshot,
  subscribe,
  subscribeToNode,
} from "@/services/wsStore";
import type { NodeDisplay, TrafficTrendSample } from "@/types/komari";

const EMPTY_TRAFFIC_TREND_SNAPSHOT: { up: TrafficTrendSample[]; down: TrafficTrendSample[] } = {
  up: [],
  down: [],
};

function useEnsured(enabled = true) {
  useEffect(() => {
    if (enabled) ensureStarted();
  }, [enabled]);
}

const noopUnsubscribe = () => undefined;

export function useNode(uuid: string, enabled = true): NodeDisplay | undefined {
  useEnsured(enabled);
  // subscribe 身份必须稳定：useSyncExternalStore 会在其变化时退订再订阅，
  // 内联箭头会导致组件每次 render 都重订阅一次。
  const subscribeFn = useCallback(
    (cb: () => void) => (enabled ? subscribeToNode(uuid, cb) : noopUnsubscribe),
    [uuid, enabled],
  );
  const getSnapshotFn = useCallback(
    () => (enabled ? getNodeSnapshot(uuid) : undefined),
    [uuid, enabled],
  );
  return useSyncExternalStore(subscribeFn, getSnapshotFn, getSnapshotFn);
}

export function useNodeTrafficTrend(
  uuid: string,
  enabled = true,
): { up: TrafficTrendSample[]; down: TrafficTrendSample[] } {
  useEnsured(enabled);
  const subscribeFn = useCallback(
    (cb: () => void) => (enabled ? subscribeToNode(uuid, cb) : noopUnsubscribe),
    [uuid, enabled],
  );
  const getSnapshotFn = useCallback(
    () => (enabled ? getNodeTrafficTrendSnapshot(uuid) : EMPTY_TRAFFIC_TREND_SNAPSHOT),
    [uuid, enabled],
  );
  return useSyncExternalStore(subscribeFn, getSnapshotFn, getSnapshotFn);
}

export function useVisibleNodeUuids(): string[] {
  useEnsured();
  return useSyncExternalStore(
    subscribe,
    getVisibleNodeUuidsSnapshot,
    getVisibleNodeUuidsSnapshot,
  );
}

export function useNodeStoreStatus() {
  useEnsured();
  // 订阅派生快照而非整个 state：state 每 2 秒换一次身份，
  // 直接订阅会让顶栏之类的消费者跟着空转重渲染。
  return useSyncExternalStore(
    subscribe,
    getStoreStatusSnapshot,
    getStoreStatusSnapshot,
  );
}
