import { PET_BUBBLE_LINE_HEIGHT } from "./petBubble.js";

/** 播放页脚本的后半段：气泡、摸鱼正文滚动与鼠标交互。 */
export function renderPetPlayerBubbleScript(): string {
  return `
let novelOpen = false;
let novel = null;
let pageLock = false;
function paintNovel() {
  if (!novel) return;
  bubble.dataset.mode = "read";
  bubble.textContent = novel.text;
  bubble.style.display = novel.text ? "block" : "none";
  placeBubble();
  // 始终停在整行上，避免一开头就露半行。
  if (novel.edge === "end") bubble.scrollTop = bubble.scrollHeight;
  else bubble.scrollTop = Math.round((novel.top || 0) / LINE) * LINE;
  pageLock = false;
}
function showNovel(text, edge, top) {
  novelOpen = true;
  const nextEdge = edge === "end" || edge === "keep" ? edge : "start";
  const nextTop = nextEdge === "keep" ? top || (novel && novel.top) || 0 : 0;
  novel = { text: text || "", edge: nextEdge, top: nextTop };
  if (bubble.dataset.mode === "task") return;
  paintNovel();
}
function hideNovel() {
  novelOpen = false;
  if (bubble.dataset.mode !== "read") return;
  bubble.dataset.mode = "";
  bubble.style.display = "none";
}
function requestReaderPage(dir) {
  if (pageLock || bubble.dataset.mode !== "read") return;
  pageLock = true;
  window.pet?.send({ type: "read-page", dir: dir });
  window.setTimeout(() => { pageLock = false; }, 400);
}
const LINE = ${PET_BUBBLE_LINE_HEIGHT};
let wheelAcc = 0;
function novelMaxScroll() {
  return Math.max(0, bubble.scrollHeight - bubble.clientHeight);
}
// 滚一格正好一行，且总是停在行边界上：不会露半行，也不会一下冲掉整屏。
// 已经到头才翻页。
function stepNovel(dir) {
  const max = novelMaxScroll();
  const cur = bubble.scrollTop;
  const next =
    dir > 0
      ? Math.min(max, (Math.floor(cur / LINE) + 1) * LINE)
      : Math.max(0, (Math.ceil(cur / LINE) - 1) * LINE);
  if (next === cur) {
    requestReaderPage(dir);
    return;
  }
  bubble.scrollTop = next;
}
// 触控板的 deltaY 只有几像素，攒够大半行再走一格，否则一下就翻掉好几行。
function wheelStep(deltaY) {
  if (!deltaY) return;
  wheelAcc = Math.sign(wheelAcc) === Math.sign(deltaY) ? wheelAcc + deltaY : deltaY;
  if (Math.abs(wheelAcc) < LINE * 0.75) return;
  const dir = wheelAcc > 0 ? 1 : -1;
  wheelAcc = 0;
  stepNovel(dir);
}
function showBubble(text, taskId, clips) {
  state.taskId = taskId || "";
  state.work = clips || [];
  bubble.dataset.mode = "task";
  bubble.textContent = text;
  bubble.style.display = text ? "block" : "none";
  placeBubble();
  window.clearTimeout(dismissTimer);
  dismissTimer = window.setTimeout(hideBubble, 10000);
  if (state.work.length) play(poolPick(state.work), "work");
}
function hideBubble() {
  state.taskId = "";
  state.work = [];
  if (state.mode === "work") resumeLoop();
  if (novelOpen && novel) {
    novel.edge = "keep";
    paintNovel();
    return;
  }
  bubble.dataset.mode = "";
  bubble.style.display = "none";
}
let scrollTimer = 0;
bubble.addEventListener("scroll", () => {
  if (bubble.dataset.mode !== "read" || !novel) return;
  novel.top = bubble.scrollTop;
  window.clearTimeout(scrollTimer);
  scrollTimer = window.setTimeout(() => {
    window.pet?.send({ type: "read-scroll", top: novel.top });
  }, 300);
});
bubble.addEventListener("wheel", (event) => {
  if (bubble.dataset.mode !== "read") return;
  event.preventDefault();
  event.stopPropagation();
  wheelStep(event.deltaY);
});
window.addEventListener("wheel", (event) => {
  if (!novelOpen || bubble.dataset.mode !== "read") return;
  wheelStep(event.deltaY);
});
bubble.addEventListener("pointerdown", (event) => {
  event.stopPropagation();
  if (bubble.dataset.mode === "read") return;
  if (state.taskId) window.pet?.send({ type: "activate" });
  hideBubble();
});
stage.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  drag = { x: event.screenX, y: event.screenY, moved: false };
  const clip = poolPick(manifest.drag);
  if (clip) play(clip, "drag");
});
window.addEventListener("pointermove", (event) => {
  if (!drag) return;
  const dx = event.screenX - drag.x;
  const dy = event.screenY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  drag.x = event.screenX;
  drag.y = event.screenY;
  window.pet?.send({ type: "move", dx, dy });
});
window.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  if (bubble.contains(event.target)) return;
  window.pet?.send({ type: "menu" });
});
window.addEventListener("pointerup", () => {
  if (!drag) return;
  const moved = drag.moved;
  drag = null;
  if (moved) {
    resumeLoop();
    return;
  }
  video.classList.remove("squish");
  void video.offsetWidth;
  video.classList.add("squish");
  const clip = poolPick(manifest.clicks) || poolPick(manifest.idle);
  if (clip) play(clip, "click");
});
function applyTone(tone) {
  bubble.dataset.tone = tone === "light" ? "light" : "dark";
}
window.pet?.onCommand((command) => {
  if (command && command.type === "notify") showBubble(command.text, command.taskId, command.clips);
  if (command && command.type === "dismiss") hideBubble();
  if (command && command.type === "read") showNovel(command.text, command.edge, command.top);
  if (command && command.type === "read-hide") {
    if (novel) window.pet?.send({ type: "read-scroll", top: bubble.scrollTop || novel.top || 0 });
    hideNovel();
  }
  if (command && command.type === "tone") applyTone(command.tone);
  if (command && command.type === "mood") {
    state.mood = command.clips || [];
    if (state.mode === "work" || state.mode === "drag" || state.mode === "click" || state.mode === "picked" || state.mode === "turn") return;
    resumeLoop();
  }
  if (command && command.type === "play" && command.clip) {
    drag = null;
    play(command.clip, command.mode === "turn" ? "turn" : "picked");
  }
});
applyFacing();
const first = nextChain();
play(first.clip, first.kind);
`;
}
