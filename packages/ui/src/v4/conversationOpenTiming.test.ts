import assert from "node:assert/strict";
import test from "node:test";
import {
  markFirstFrameStart,
  takeFirstFrameDuration,
  type FirstFrameClock,
} from "./conversationOpenTiming.js";

const idle: FirstFrameClock = { sessionKey: null, startedAt: null, logged: false };

test("first frame timing starts when rows arrive and is taken once", () => {
  const waiting = markFirstFrameStart(idle, "sess", 0, 10);
  assert.deepEqual(waiting, { sessionKey: "sess", startedAt: null, logged: false });
  const started = markFirstFrameStart(waiting, "sess", 4, 20);
  assert.equal(started.startedAt, 20);
  assert.equal(takeFirstFrameDuration(waiting, "sess", 0, 30), null);
  const taken = takeFirstFrameDuration(started, "sess", 4, 35);
  assert.equal(taken?.firstFrameRenderMs, 15);
  assert.equal(taken?.clock.logged, true);
  const again = markFirstFrameStart(taken!.clock, "sess", 8, 40);
  assert.equal(again, taken?.clock);
  assert.equal(takeFirstFrameDuration(again, "sess", 8, 50), null);
});

test("first frame timing restarts for another session and ignores drafts", () => {
  const started = markFirstFrameStart(idle, "sess", 2, 10);
  const taken = takeFirstFrameDuration(started, "sess", 2, 12);
  const next = markFirstFrameStart(taken!.clock, "other", 1, 30);
  assert.equal(next.sessionKey, "other");
  assert.equal(next.logged, false);
  assert.equal(next.startedAt, 30);
  assert.equal(markFirstFrameStart(idle, "draft", 3, 1), idle);
  assert.equal(takeFirstFrameDuration(started, "draft", 3, 5), null);
});
