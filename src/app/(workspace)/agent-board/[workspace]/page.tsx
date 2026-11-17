import { AgentBoardView } from "@/components/dashboard/agent-board-view";
import { PagePermissionGate } from "@/components/dashboard/page-permission-gate";

/**
 * /agent-board/<slug> — the board of one workspace. The segment is read on the
 * client by ProjectProvider (`boardSegment`), which selects the workspace it
 * names; /agent-board itself moves here for the active workspace.
 */
export default function WorkspaceAgentBoardPage() {
  return (
    <PagePermissionGate permission="agent-board.view">
      <AgentBoardView />
    </PagePermissionGate>
  );
}
