import { lazy, Suspense, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { LayoutGrid, List } from "lucide-react";
import { clsx } from "clsx";
import { NodeGrid } from "@/components/node/NodeGrid";
import { NodeList } from "@/components/node/NodeList";
import { Spinner } from "@/components/ui/Spinner";
import { useAuth } from "@/hooks/useAuth";

const ThemeManage = lazy(() =>
  import("@/pages/ThemeManage").then((module) => ({ default: module.ThemeManage })),
);

export function Home() {
  const [searchParams] = useSearchParams();
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const {
    data: me,
    isPending: authPending,
    isFetching: authFetching,
    error: authError,
    refetch: refetchAuth,
  } = useAuth();
  const isThemeManageView = searchParams.get("view") === "theme-manage";

  if (isThemeManageView) {
    if (me?.logged_in) {
      return (
        <Suspense
          fallback={
            <div className="flex min-h-[60vh] items-center justify-center">
              <Spinner size={24} />
            </div>
          }
        >
          <ThemeManage />
        </Suspense>
      );
    }

    if (authPending || (!me && authFetching)) {
      return (
        <div className="flex min-h-[60vh] items-center justify-center">
          <Spinner size={24} />
        </div>
      );
    }

    if (authError) {
      return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
          <div className="space-y-2">
            <div className="text-[15px] font-semibold text-[var(--text-primary)]">
              无法确认当前登录状态
            </div>
            <p className="max-w-[32rem] text-[13px] text-[var(--text-secondary)]">
              {authError instanceof Error ? authError.message : "请稍后重试。"}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => {
                void refetchAuth();
              }}
              className="control-button px-4 py-2 text-[13px] font-medium"
            >
              重试
            </button>
            <Link to="/" className="control-button px-4 py-2 text-[13px] font-medium">
              返回首页
            </Link>
          </div>
        </div>
      );
    }

    return <Navigate to="/" replace />;
  }

  return (
    <div className="py-2">
      <div className="mb-3 flex items-center justify-end px-2">
        <div className="control-group">
          <button
            type="button"
            className={clsx("control-toggle", viewMode === "grid" && "is-active")}
            onClick={() => setViewMode("grid")}
            title="卡片视图"
          >
            <LayoutGrid size={15} strokeWidth={2} />
          </button>
          <button
            type="button"
            className={clsx("control-toggle", viewMode === "list" && "is-active")}
            onClick={() => setViewMode("list")}
            title="列表视图"
          >
            <List size={15} strokeWidth={2} />
          </button>
        </div>
      </div>
      {viewMode === "grid" ? <NodeGrid /> : <NodeList />}
    </div>
  );
}
