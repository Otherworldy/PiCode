import assert from "node:assert/strict";
import test from "node:test";
import type { GitFileChange } from "@zcode/shared";
import {
  GitCommitMessageGenerator,
  pickGeneratedCommitMessage,
} from "../src/git/gitCommitMessageGenerator.js";

const file: GitFileChange = {
  path: "a.ts",
  repoRelativePath: "a.ts",
  workspaceRelativePath: "a.ts",
  kind: "modified",
  section: "unstaged",
  added: 1,
  removed: 0,
  isStaged: false,
  isUntracked: false,
  isConflicted: false,
};

test("pickGeneratedCommitMessage keeps the conventional line and its body", () => {
  assert.equal(
    pickGeneratedCommitMessage("说明如下：\n\nfeat：修复提交信息生成\n\n跳过旧模型。\n"),
    "feat: 修复提交信息生成\n\n跳过旧模型。",
  );
});

test("generator accepts a wrapped conventional commit", async () => {
  const generator = new GitCommitMessageGenerator({
    currentModelProvider: {
      async readCurrentModel() {
        return { providerId: "zai", modelId: "glm" };
      },
    },
    textGenerator: {
      async generateText() {
        return {
          text: "```text\nfeat: generate commit messages with the Pi model\n```",
          selection: { providerId: "zai", modelId: "glm" },
        };
      },
    },
  });
  const result = await generator.generate({
    workspacePath: "/work",
    branchName: "todo-12",
    files: [file],
    diffs: [],
  });
  assert.equal(result.message, "feat: generate commit messages with the Pi model");
  assert.equal(result.providerId, "zai");
});
