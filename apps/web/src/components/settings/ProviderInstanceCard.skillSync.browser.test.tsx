import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ComponentProps, ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { ProviderInstanceCard } from "./ProviderInstanceCard";

vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsSection: ({
    title,
    children,
  }: {
    readonly title: ReactNode;
    readonly children?: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    status,
    children,
  }: {
    readonly title: ReactNode;
    readonly status?: ReactNode;
    readonly children?: ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      {status}
      {children}
    </div>
  ),
  SettingResetButton: () => <span />,
}));

vi.mock(import("../../state/managedPolicy"), async (original) => ({
  ...(await original()),
  useManagedPolicy: () => undefined,
}));

const instanceId = ProviderInstanceId.make("claude-work");
const instance: ProviderInstanceConfig = {
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude work",
  enabled: true,
};
const liveProvider: ServerProvider = {
  instanceId,
  driver: instance.driver,
  displayName: "Claude work",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-23T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  skillSyncIssues: [
    {
      cwd: "/project-a",
      target: "/project-a/.claude/skills",
      conflicts: ["review", "deploy"],
    },
    {
      cwd: "/project-b",
      target: "/project-b/.claude/skills",
      conflicts: ["infra"],
    },
  ],
};

function cardProps(mode: "list" | "editor"): ComponentProps<typeof ProviderInstanceCard> {
  return {
    instanceId,
    instance,
    driverOption: undefined,
    liveProvider,
    mode,
    onUpdate: vi.fn(async () => true),
    hiddenModels: [],
    favoriteModels: [],
    modelOrder: [],
    onHiddenModelsChange: vi.fn(),
    onFavoriteModelsChange: vi.fn(),
    onToggleFavorite: vi.fn(),
    onModelOrderChange: vi.fn(),
  };
}

describe("ProviderInstanceCard skill sync issues", () => {
  it("shows the total conflict count in list mode", async () => {
    await using screen = await render(<ProviderInstanceCard {...cardProps("list")} />);

    await expect
      .element(screen.getByText("3 conflicting skill copies left untouched"))
      .toBeVisible();
  });

  it("shows every conflicting skill and target in editor mode", async () => {
    await using screen = await render(<ProviderInstanceCard {...cardProps("editor")} />);

    await expect
      .element(screen.getByText("Conflicting skill copies were left untouched"))
      .toBeVisible();
    await expect.element(screen.getByText("review, deploy")).toBeVisible();
    await expect.element(screen.getByText("/project-a/.claude/skills")).toBeVisible();
    await expect.element(screen.getByText("infra")).toBeVisible();
    await expect.element(screen.getByText("/project-b/.claude/skills")).toBeVisible();
  });
});
