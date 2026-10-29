import assert from "node:assert/strict";
import test from "node:test";
import { abortLiveSubagent, trackLiveSubagent, type LiveSubagentModel } from "./live-subagents.js";
import {
  createBackgroundSubagents,
  formatSubagentSettled,
  MAX_BACKGROUND_RESULT_CHARS,
  truncateSubagentText,
} from "./subagent-background.js";
import type { ZcodeSubagentProfile } from "./host-capabilities.js";

const profile: ZcodeSubagentProfile = {
  name: "scout",
  description: "look around",
  systemPrompt: "look around",
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const model: LiveSubagentModel = { provider: "acme", model: "small", thought: "low" };

function registerLive(id: string, aborted: string[]) {
  return trackLiveSubagent(id, {
    abort: () => aborted.push(id),
    getModel: () => model,
    setModel: async () => true,
  });
}

test("background dispatch returns before the subagent settles", async () => {
  let finish!: (text: string) => void;
  const runner = createBackgroundSubagents({
    run: () => new Promise<string>((resolve) => (finish = resolve)),
    notify: () => undefined,
  });

  const text = runner.start(profile, "look");
  assert.match(text, /started in background/u);
  assert.match(text, /scout/u);
  // 子代理还没给答案，说明文本里不能有正文。
  assert.doesNotMatch(text, /the answer/u);
  assert.equal(runner.running, 1);

  finish("the answer");
  await flush();
  assert.equal(runner.running, 0);
});

test("a settled subagent notifies exactly once with its body", async () => {
  const notes: string[] = [];
  const runner = createBackgroundSubagents({
    run: async (_profile, _task, onStarted) => {
      onStarted("child-1");
      return "the answer";
    },
    notify: (text) => notes.push(text),
  });

  runner.start(profile, "look");
  await flush();

  assert.equal(notes.length, 1);
  assert.match(notes[0] ?? "", /scout/u);
  assert.match(notes[0] ?? "", /已完成/u);
  assert.match(notes[0] ?? "", /child-1/u);
  assert.match(notes[0] ?? "", /the answer/u);
});

test("a thrown subagent failure notifies as failed", async () => {
  const notes: string[] = [];
  const runner = createBackgroundSubagents({
    run: async () => {
      throw new Error("boom");
    },
    notify: (text) => notes.push(text),
  });

  runner.start(profile, "look");
  await flush();

  assert.equal(notes.length, 1);
  assert.match(notes[0] ?? "", /失败/u);
  assert.match(notes[0] ?? "", /boom/u);
});

test("a cancelled subagent notifies once as cancelled and never repeats", async () => {
  const notes: string[] = [];
  const aborted: string[] = [];
  let finish!: (text: string) => void;
  const runner = createBackgroundSubagents({
    run: (_profile, _task, onStarted) => {
      onStarted("child-2");
      return new Promise<string>((resolve) => (finish = resolve));
    },
    notify: (text) => notes.push(text),
  });

  const release = registerLive("child-2", aborted);
  runner.start(profile, "look");
  await flush();

  // 面板 Stop 直接走 abortLiveSubagent，不经过 runner；子代理以取消文本返回。
  abortLiveSubagent("child-2");
  assert.deepEqual(aborted, ["child-2"]);
  finish("subagent cancelled");
  await flush();
  abortLiveSubagent("child-2");
  await flush();

  assert.equal(notes.length, 1);
  assert.match(notes[0] ?? "", /已取消/u);
  assert.equal(runner.running, 0);
  release();
});

test("the concurrency limit rejects without starting a child", async () => {
  let started = 0;
  const runner = createBackgroundSubagents({
    run: () => {
      started += 1;
      return new Promise<string>(() => undefined);
    },
    notify: () => undefined,
    maxConcurrent: 2,
  });

  runner.start(profile, "one");
  runner.start(profile, "two");
  const rejected = runner.start(profile, "three");

  assert.match(rejected, /limit reached/u);
  assert.equal(started, 2);
  assert.equal(runner.running, 2);
});

test("abortAll only stops the dispatches of its own runner", async () => {
  const aborted: string[] = [];
  const makeRunner = (id: string) =>
    createBackgroundSubagents({
      run: (_profile, _task, onStarted) => {
        onStarted(id);
        return new Promise<string>(() => undefined);
      },
      notify: () => undefined,
    });

  const first = makeRunner("own-1");
  const second = makeRunner("other-1");
  const releaseFirst = registerLive("own-1", aborted);
  const releaseSecond = registerLive("other-1", aborted);

  first.start(profile, "one");
  second.start(profile, "two");
  await flush();

  first.abortAll();
  assert.deepEqual(aborted, ["own-1"]);
  releaseFirst();
  releaseSecond();
});

test("abortAll before onStarted cancels as soon as the child id lands", async () => {
  const aborted: string[] = [];
  const notes: string[] = [];
  let fireStarted!: (id: string) => void;
  const runner = createBackgroundSubagents({
    run: (_profile, _task, onStarted) => {
      fireStarted = onStarted;
      return new Promise<string>(() => undefined);
    },
    notify: (text) => notes.push(text),
  });

  runner.start(profile, "look");
  // 子会话还没建好就要关闭父会话。
  runner.abortAll();
  const release = registerLive("late-1", aborted);
  fireStarted("late-1");
  await flush();

  assert.deepEqual(aborted, ["late-1"]);
  // 会话已关闭，不往死会话里投结果。
  assert.equal(notes.length, 0);
  release();
});

test("abortAll stops accepting new dispatches", () => {
  const runner = createBackgroundSubagents({
    run: () => new Promise<string>(() => undefined),
    notify: () => undefined,
  });

  runner.abortAll();
  const text = runner.start(profile, "look");

  assert.match(text, /closing/u);
  assert.equal(runner.running, 0);
});

test("a resolved failure string notifies as failed", async () => {
  const notes: string[] = [];
  const runner = createBackgroundSubagents({
    // `runZcodeSubagent` 的工具缺失与模型缺失走这条返回，不抛异常。
    run: async () => "subagent failed: tools not available: web_search",
    notify: (text) => notes.push(text),
  });

  runner.start(profile, "look");
  await flush();

  assert.equal(notes.length, 1);
  assert.match(notes[0] ?? "", /失败/u);
});

test("a dispatch that never started omits the childSessionId line", async () => {
  const notes: string[] = [];
  const runner = createBackgroundSubagents({
    run: async () => "subagent failed: no model",
    notify: (text) => notes.push(text),
  });

  runner.start(profile, "look");
  await flush();

  assert.doesNotMatch(notes[0] ?? "", /childSessionId/u);
});

test("a settled dispatch frees its concurrency slot", async () => {
  let finish!: (text: string) => void;
  const runner = createBackgroundSubagents({
    run: () => new Promise<string>((resolve) => (finish = resolve)),
    notify: () => undefined,
    maxConcurrent: 1,
  });

  runner.start(profile, "one");
  assert.match(runner.start(profile, "two"), /limit reached/u);
  finish("done");
  await flush();

  assert.equal(runner.running, 0);
  assert.match(runner.start(profile, "three"), /started in background/u);
});

test("a throwing notify does not unsettle the dispatch", async () => {
  const runner = createBackgroundSubagents({
    run: async () => "done",
    notify: () => {
      throw new Error("no recipient");
    },
  });

  runner.start(profile, "look");
  await flush();

  assert.equal(runner.running, 0);
});

test("oversized results are truncated with a marker", () => {
  const long = "x".repeat(MAX_BACKGROUND_RESULT_CHARS + 64);
  const body = truncateSubagentText(long);

  assert.ok(body.length < long.length);
  assert.match(body, /已截断/u);
  // 短正文原样返回，不加标记。
  assert.equal(truncateSubagentText("  short  "), "short");
});

test("formatSubagentSettled omits the body when there is none", () => {
  const text = formatSubagentSettled({
    agent: "scout",
    childSessionId: "child-3",
    status: "cancelled",
    text: "",
  });

  assert.match(text, /已取消/u);
  assert.match(text, /child-3/u);
  assert.equal(text.endsWith("\n\n"), false);
});
