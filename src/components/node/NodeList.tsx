import { useVisibleNodeUuids } from "@/hooks/useNode";
import { useHomepagePingOverview } from "@/hooks/usePingMini";
import { NodeListItem } from "./NodeListItem";

export function NodeList() {
  const uuids = useVisibleNodeUuids();
  useHomepagePingOverview();

  if (uuids.length === 0) {
    return (
      <div className="flex h-[40vh] flex-col items-center justify-center gap-2 text-[var(--text-tertiary)]">
        <span className="text-[15px]">尚未连接到任何节点</span>
        <span className="text-[12px]">等待后端推送或前往管理后台添加</span>
      </div>
    );
  }

  return (
    <div className="node-list">
      {uuids.map((uuid) => (
        <NodeListItem key={uuid} uuid={uuid} />
      ))}
    </div>
  );
}