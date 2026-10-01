import assert from "node:assert/strict";
import test from "node:test";
import { PiToV4Projector } from "./projector.js";
import {
  contextEventsOf,
  deleteSessionBranch,
  readSessionTree,
  resolveSessionEntry,
  withoutBranch,
  type SessionTreeSource,
} from "./session-tree.js";

const entries = [
  {
    id: "u1",
    parentId: null,
    type: "message",
    message: { role: "user", content: "hi", id: "msg-u" },
  },
  {
    id: "a1",
    parentId: "u1",
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "yo" }] },
  },
  {
    id: "a2",
    parentId: "u1",
    type: "message",
    message: { role: "assistant", content: "side" },
  },
];

function source(leafId: string): SessionTreeSource {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    getLeafId: () => leafId,
    getBranch: () => (leafId === "a1" ? [{ id: "u1" }, { id: "a1" }] : [{ id: "u1" }, { id: "a2" }]),
    getTree: () => [
      {
        entry: entries[0]!,
        label: "start",
        children: [
          { entry: entries[1]!, children: [] },
          { entry: entries[2]!, children: [] },
        ],
      },
    ],
    getEntry: (id) => byId.get(id),
    getEntries: () => entries,
    buildContextEntries: () => [
      entries[0],
      {
        type: "branch_summary",
        id: "b1",
        parentId: "u1",
        summary: "dropped the rest",
      },
    ],
    appendLabelChange: () => "label",
  };
}

test("withoutBranch drops the side path and keeps the active one", () => {
  const kept = withoutBranch(
    [
      { id: "header", type: "session" },
      { id: "u", type: "message", parentId: null },
      { id: "main", type: "message", parentId: "u" },
      { id: "side", type: "message", parentId: "u" },
      { id: "side-leaf", type: "message", parentId: "side" },
      { id: "mark", type: "label", parentId: "main", targetId: "side" },
    ],
    "side-leaf",
    "main",
  );
  assert.deepEqual(
    kept.map((entry) => entry.id),
    ["header", "u", "main"],
  );
});

test("withoutBranch refuses the current branch", () => {
  assert.throws(
    () =>
      withoutBranch(
        [
          { id: "u", type: "message", parentId: null },
          { id: "main", type: "message", parentId: "u" },
        ],
        "main",
        "main",
      ),
    /current branch/u,
  );
});

test("deleteSessionBranch rewrites the file and does not rebuild context", () => {
  const file = [
    { id: "header", type: "session" },
    { id: "u", type: "message", parentId: null },
    { id: "main", type: "message", parentId: "u" },
    { id: "side", type: "message", parentId: "u" },
  ];
  let rewritten = false;
  const manager = {
    fileEntries: file,
    leafId: "main" as string | null,
    byId: new Map(file.map((entry) => [entry.id, entry])),
    _buildIndex(this: { fileEntries: typeof file; byId: Map<string, (typeof file)[number]> }) {
      this.byId = new Map(this.fileEntries.map((entry) => [entry.id, entry]));
    },
    _rewriteFile() {
      rewritten = true;
    },
    buildSessionContext() {
      throw new Error("should not rebuild context");
    },
  };
  deleteSessionBranch({ sessionManager: manager }, "side");
  assert.equal(rewritten, true);
  assert.equal(manager.leafId, "main");
  assert.deepEqual(
    manager.fileEntries.map((entry) => entry.id),
    ["header", "u", "main"],
  );
});

test("readSessionTree walks a chain deeper than the call stack", () => {
  const depth = 12_000;
  let root: { entry: (typeof entries)[number]; children: unknown[]; label?: string } | undefined;
  let parent: { children: unknown[] } | undefined;
  const chain = [];
  for (let index = 0; index < depth; index += 1) {
    const entry = {
      id: `n${index}`,
      parentId: index === 0 ? null : `n${index - 1}`,
      type: "message",
      message: { role: "user" as const, content: "x" },
    };
    chain.push(entry);
    const node = { entry, children: [] as unknown[] };
    if (!root) root = node;
    else parent?.children.push(node);
    parent = node;
  }
  const nodes = readSessionTree({
    getLeafId: () => `n${depth - 1}`,
    getBranch: () => chain.map((entry) => ({ id: entry.id })),
    getTree: () => [root!],
    getEntry: () => undefined,
    getEntries: () => chain,
    buildContextEntries: () => [],
    appendLabelChange: () => "",
  });
  assert.equal(nodes.length, depth);
  assert.equal(nodes[0]?.depth, 0);
  assert.equal(nodes[1]?.id, "n1");
  assert.equal(nodes.at(-1)?.id, `n${depth - 1}`);
  assert.equal(nodes.at(-1)?.depth, depth - 1);
  assert.equal(nodes.at(-1)?.leaf, true);
  assert.equal(nodes.at(-1)?.active, true);
});

test("readSessionTree marks the active path and leaf", () => {
  const nodes = readSessionTree(source("a1"));
  assert.deepEqual(
    nodes.map((node) => [node.id, node.active, node.leaf, node.role, node.label ?? ""]),
    [
      ["u1", true, false, "user", "start"],
      ["a1", true, true, "assistant", ""],
      ["a2", false, false, "assistant", ""],
    ],
  );
  assert.equal(nodes[1]?.preview, "yo");
});

test("resolveSessionEntry matches entry id, message id, then text", () => {
  const tree = source("a1");
  assert.equal(resolveSessionEntry(tree, "a2"), "a2");
  assert.equal(resolveSessionEntry(tree, "msg-u"), "u1");
  assert.equal(resolveSessionEntry(tree, "row:1", { text: "side", role: "assistant" }), "a2");
  assert.equal(resolveSessionEntry(tree, "missing", { text: "nope" }), undefined);
});

test("context events keep a branch summary on the active path", () => {
  const events = contextEventsOf(source("a1"));
  assert.ok(events.some((event) => event.type === "branch_summary"));
  const projector = new PiToV4Projector("s1", "e1");
  for (const event of events) projector.apply(event);
  const marker = projector.getSnapshot().rows.window.find((row) => row.kind === "timelineMarker");
  assert.equal(
    marker && marker.kind === "timelineMarker" && marker.marker.type === "branchSummary"
      ? marker.marker.summary
      : "",
    "dropped the rest",
  );
});
