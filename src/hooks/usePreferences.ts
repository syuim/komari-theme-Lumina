import { useCallback, useEffect, useSyncExternalStore } from "react";
import { usePublicConfig } from "@/hooks/usePublicConfig";

type Appearance = "system" | "light" | "dark";
type ResolvedAppearance = "light" | "dark";
const APPEARANCE_STORAGE_KEY = "appearance";
const APPEARANCE_DEFAULT_STORAGE_KEY = "appearance_default";
const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

interface PrefsState {
  appearance: Appearance;
  resolvedAppearance: ResolvedAppearance;
}

const DEFAULTS: PrefsState = {
  appearance: "system",
  resolvedAppearance: "dark",
};

let themeFlipTimer: number | null = null;
let hasExplicitAppearancePreference = false;
let appliedDefaultAppearance: Appearance | null = null;
let systemAppearanceMediaQuery: MediaQueryList | null = null;

function isAppearance(value: unknown): value is Appearance {
  return value === "system" || value === "light" || value === "dark";
}

function normalizeAppearance(value: unknown, fallback: Appearance = DEFAULTS.appearance): Appearance {
  return isAppearance(value) ? value : fallback;
}

function getSystemAppearanceMediaQuery() {
  if (typeof window === "undefined" || !window.matchMedia) return null;
  systemAppearanceMediaQuery ??= window.matchMedia(SYSTEM_DARK_QUERY);
  return systemAppearanceMediaQuery;
}

function resolveAppearance(a: Appearance): ResolvedAppearance {
  if (a === "system") {
    return getSystemAppearanceMediaQuery()?.matches ? "dark" : "light";
  }
  return a;
}

function parseStoredAppearance(raw: string | null): Appearance | null {
  if (raw == null) {
    return null;
  }

  if (isAppearance(raw)) {
    return raw;
  }

  try {
    const parsed = JSON.parse(raw);
    return isAppearance(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readStoredAppearance() {
  const parsed = parseStoredAppearance(localStorage.getItem(APPEARANCE_STORAGE_KEY));
  const fallback =
    parseStoredAppearance(localStorage.getItem(APPEARANCE_DEFAULT_STORAGE_KEY)) ??
    DEFAULTS.appearance;
  return {
    appearance: parsed ?? fallback,
    hasExplicitPreference: parsed != null,
  };
}

function persistAppearance(value: Appearance) {
  // Store as JSON string for compatibility with older Lumina bundles that parsed this key.
  localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(value));
}

function persistDefaultAppearance(value: Appearance) {
  localStorage.setItem(APPEARANCE_DEFAULT_STORAGE_KEY, JSON.stringify(value));
}

const listeners = new Set<() => void>();
let snapshot: PrefsState = { ...DEFAULTS };

function emit() {
  for (const l of listeners) l();
}

function markThemeFlip() {
  const root = document.documentElement;
  root.classList.add("theme-flip");
  if (themeFlipTimer != null) {
    window.clearTimeout(themeFlipTimer);
  }
  themeFlipTimer = window.setTimeout(() => {
    root.classList.remove("theme-flip");
    themeFlipTimer = null;
  }, 140);
}

function applyResolvedAppearance(resolvedAppearance: ResolvedAppearance) {
  const root = document.documentElement;
  root.dataset.appearance = resolvedAppearance;
  root.style.colorScheme = resolvedAppearance;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) {
    meta.content = resolvedAppearance === "dark" ? "#000000" : "#F5F5F7";
  }
}

let hasAppliedAppearance = false;

function commit(next: Partial<PrefsState>) {
  const merged: PrefsState = { ...snapshot, ...next };
  if (next.appearance) {
    merged.resolvedAppearance = resolveAppearance(merged.appearance);
  }
  // 外观没有实际变化时直接返回：多个订阅者重复提交同一个值不该触发全量重渲染。
  if (
    hasAppliedAppearance &&
    snapshot.appearance === merged.appearance &&
    snapshot.resolvedAppearance === merged.resolvedAppearance
  ) {
    return;
  }
  if (snapshot.resolvedAppearance !== merged.resolvedAppearance) {
    markThemeFlip();
  }
  snapshot = merged;
  hasAppliedAppearance = true;
  applyResolvedAppearance(merged.resolvedAppearance);
  emit();
}

let initialized = false;
function initIfNeeded() {
  if (initialized) return;
  initialized = true;
  const stored = readStoredAppearance();
  hasExplicitAppearancePreference = stored.hasExplicitPreference;
  if (stored.hasExplicitPreference) {
    persistAppearance(stored.appearance);
  }
  commit({ appearance: stored.appearance });
  const refreshSystemAppearance = () => {
    if (snapshot.appearance === "system") {
      commit({ appearance: "system" });
    }
  };
  const mediaQuery = getSystemAppearanceMediaQuery();
  if (mediaQuery) {
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", refreshSystemAppearance);
    } else {
      mediaQuery.addListener(refreshSystemAppearance);
    }
  }
  window.addEventListener("focus", refreshSystemAppearance);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshSystemAppearance();
  });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function getSnapshot() {
  return snapshot;
}

/**
 * 只读外观的订阅入口。首页每张卡片都要用外观做重绘 key，
 * 走这里就不会顺带订阅 react-query 并重复跑默认外观同步。
 */
export function useResolvedAppearance(): ResolvedAppearance {
  initIfNeeded();
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot).resolvedAppearance;
}

export function usePreferences() {
  initIfNeeded();
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { data: config } = usePublicConfig();

  // 管理端默认外观通过 react-query 的 ["public"] 缓存下发；未手动选择外观的用户跟随该值。
  // （历史上这里还有一条独立的裸 fetch /api/public，与本缓存重复，已移除。）
  useEffect(() => {
    if (!config) return;
    if (hasExplicitAppearancePreference) return;
    const defaultAppearance = normalizeAppearance(config.theme_settings?.defaultAppearance);
    if (appliedDefaultAppearance === defaultAppearance) return;
    appliedDefaultAppearance = defaultAppearance;
    persistDefaultAppearance(defaultAppearance);
    commit({ appearance: defaultAppearance });
  }, [config]);

  const setAppearance = useCallback((a: Appearance) => {
    hasExplicitAppearancePreference = true;
    persistAppearance(a);
    commit({ appearance: a });
  }, []);

  return {
    appearance: state.appearance,
    resolvedAppearance: state.resolvedAppearance,
    setAppearance,
  };
}
