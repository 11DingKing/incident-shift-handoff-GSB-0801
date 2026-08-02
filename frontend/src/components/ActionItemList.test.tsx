import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActionItemList } from "./ActionItemList";
import { api } from "../api";
import { ToastProvider } from "../toast";
import type { ActionItem } from "../types";

const item: ActionItem = {
  id: "act-1",
  incident_id: "inc-1",
  title: "复核东侧绕行路线",
  detail: "",
  status: "in_progress",
  responsible_party: "交通协调组",
  occurred_at: "2026-07-29T10:05:00+08:00",
  version: 1,
  created_at: "2026-07-29T10:05:00+08:00",
  updated_at: "2026-07-29T10:05:00+08:00",
};

function renderList(onChanged = vi.fn()) {
  return render(
    <ToastProvider>
      <ActionItemList
        incidentId="inc-1"
        items={[item]}
        actor="接班人"
        acknowledgedIds={new Set()}
        signedVersions={{}}
        onChanged={onChanged}
      />
    </ToastProvider>
  );
}

describe("ActionItemList", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("遇到 409 时展示字段级冲突而不是静默覆盖", async () => {
    vi.spyOn(api, "patchActionItem").mockRejectedValue({
      status: 409,
      conflict: {
        error: "optimistic_lock_conflict",
        message: "版本冲突",
        currentVersion: 2,
        conflicts: [
          {
            field: "status",
            base: "in_progress",
            current: "done",
            attempted: "blocked",
          },
        ],
        current: { ...item, version: 2, status: "done" },
      },
    });
    const onChanged = vi.fn().mockResolvedValue(undefined);

    const user = userEvent.setup();
    renderList(onChanged);

    const select = screen.getByLabelText("复核东侧绕行路线 状态");
    await user.selectOptions(select, "blocked");

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText(/字段级冲突/)).toBeInTheDocument();
    expect(screen.getAllByText("status").length).toBeGreaterThan(0);
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.getByText("受阻")).toBeInTheDocument();
    expect(
      screen.getByText(/服务器当前版本：v2/)
    ).toBeInTheDocument();
  });

  it("更新成功后调用 onChanged 以触发实时收敛", async () => {
    vi.spyOn(api, "patchActionItem").mockResolvedValue({
      action_item: { ...item, version: 2, status: "done" },
    });
    const onChanged = vi.fn().mockResolvedValue(undefined);

    const user = userEvent.setup();
    renderList(onChanged);

    await user.selectOptions(
      screen.getByLabelText("复核东侧绕行路线 状态"),
      "done"
    );

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalled();
    });
  });
});
