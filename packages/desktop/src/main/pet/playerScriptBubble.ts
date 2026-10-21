import { PET_BUBBLE_LINE_HEIGHT, PET_BUBBLE_PADDING_Y } from "./petBubble.js";
import { snapBubbleHeight } from "./bubbleGeometry.js";

/** 播放页脚本的后半段：气泡、摸鱼正文滚动、气泡编辑态与鼠标交互。 */
export function renderPetPlayerBubbleScript(): string {
  return `
const guides = {
  stage: document.getElementById("guide-stage"),
  window: document.getElementById("guide-window"),
  hint: document.getElementById("guide-hint"),
  bar: document.getElementById("edit-bar"),
};
const handles = [];
for (const dir of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
  const handle = document.createElement("div");
  handle.className = "pet-handle";
  handle.dataset.dir = dir;
  handle.style.display = "none";
  document.body.appendChild(handle);
  handles.push(handle);
}
const LINE = ${PET_BUBBLE_LINE_HEIGHT};
const PADDING_Y = ${PET_BUBBLE_PADDING_Y};
const MIN_LINES = 2;
const MIN_WIDTH = 160;
const snapBubbleHeight = ${snapBubbleHeight.toString()};
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
function bubbleBox(readerMode) {
  if (!layoutCache) return null;
  if (editBase) return editBubbleBox();
  return readerMode ? layoutCache.reader : layoutCache.auto;
}
function placeBubble() {
  const box = bubbleBox(bubble.dataset.mode === "read");
  if (!box) return;
  bubble.style.left = box.left + "px";
  bubble.style.bottom = box.bottom + "px";
  bubble.style.width = box.width + "px";
  bubble.style.height = box.height + "px";
}
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
  if (pageLock || bubble.dataset.mode !== "read" || editBase) return;
  pageLock = true;
  window.pet?.send({ type: "read-page", dir: dir });
  window.setTimeout(() => { pageLock = false; }, 400);
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

/* ---------- 气泡编辑态 ---------- */
let editLabels = {
  bar: "拖动气泡移动，拖动方块缩放",
  save: "保存",
  cancel: "取消",
  bubble: "气泡 {w} × {h}",
  window: "窗口 {w} × {h}",
};
function formatSize(template, width, height) {
  return template.replace("{w}", String(width)).replace("{h}", String(height));
}
const EDIT_SAMPLE =
  "这里是摸鱼正文的显示效果，用来判断字号、宽度和高度是否合适。拖动气泡移动位置，拖动八个蓝色方块调整大小。";
let editRect = null;
let editArea = { width: 0, height: 0 };
let editDrag = null;

function editBubbleBox() {
  const left = editRect.x + editBase.left + stageWidth / 2;
  const bottom = editRect.y + editBase.bottom;
  return { left: left, bottom: bottom, width: editRect.w, height: editRect.h };
}
function paintEdit() {
  if (!editBase || !editRect) return;
  const box = editBubbleBox();
  bubble.style.left = box.left + "px";
  bubble.style.bottom = box.bottom + "px";
  bubble.style.width = box.width + "px";
  bubble.style.height = box.height + "px";
  // 手柄按气泡四角/四边摆，位置用视口坐标换算。
  const top = editArea.height - box.bottom - box.height;
  for (const handle of handles) {
    const dir = handle.dataset.dir;
    const x = box.left + (dir.includes("e") ? box.width : dir.includes("w") ? 0 : box.width / 2);
    const y = top + (dir.includes("s") ? box.height : dir.includes("n") ? 0 : box.height / 2);
    handle.style.left = x + "px";
    handle.style.top = y + "px";
    handle.style.display = "block";
  }
  // 把「保存后窗口会有多大」画出来，多出来的透明区域会吃掉桌面点击。
  const next = computeLayout(editRect);
  const stageTop = editArea.height - editBase.bottom - stageHeight;
  guides.window.style.left = editBase.left - next.stageLeft + "px";
  guides.window.style.top = stageTop - (next.height - next.stageBottom - stageHeight) + "px";
  guides.window.style.width = next.width + "px";
  guides.window.style.height = next.height + "px";
  guides.window.style.display = "block";
  guides.hint.textContent =
    formatSize(editLabels.bubble, Math.round(editRect.w), Math.round(editRect.h)) +
    "  ·  " +
    formatSize(editLabels.window, next.width, next.height);
  guides.hint.style.left = Math.max(4, Math.min(editArea.width - 180, guides.window.offsetLeft + 4)) + "px";
  guides.hint.style.top = Math.max(4, guides.window.offsetTop - 22) + "px";
  guides.hint.style.display = "block";
}
function beginBubbleEdit(command) {
  if (!layoutCache || !stageWidth || !stageHeight) return;
  if (command.labels) editLabels = command.labels;
  document.getElementById("edit-bar-text").textContent = editLabels.bar;
  document.getElementById("edit-save").textContent = editLabels.save;
  document.getElementById("edit-cancel").textContent = editLabels.cancel;
  const origin = command.origin || { x: 0, y: 0 };
  const from = command.from || { width: innerWidth, height: innerHeight };
  const area = command.area || { width: innerWidth, height: innerHeight };
  editArea = { width: area.width, height: area.height };
  editBase = {
    left: layoutCache.stageLeft + origin.x,
    bottom: layoutCache.stageBottom + (area.height - from.height - origin.y),
  };
  // layoutCache 是「正常窗口」里的坐标，换算成相对角色脚底的矩形要减掉正常窗口里的舞台位置。
  const reader = layoutCache.reader;
  editRect = {
    x: reader.left - (layoutCache.stageLeft + stageWidth / 2),
    y: reader.bottom - layoutCache.stageBottom,
    w: reader.width,
    h: snapBubbleHeight(reader.height, LINE, PADDING_Y, MIN_LINES),
  };
  document.body.classList.add("editing");
  guides.stage.style.left = editBase.left + "px";
  guides.stage.style.width = stageWidth + "px";
  guides.stage.style.height = stageHeight + "px";
  guides.stage.style.bottom = editBase.bottom + "px";
  guides.stage.style.display = "block";
  guides.bar.style.left = "12px";
  guides.bar.style.top = "12px";
  guides.bar.style.display = "flex";
  bubble.dataset.mode = "read";
  bubble.textContent = novel && novel.text ? novel.text : EDIT_SAMPLE;
  bubble.style.display = "block";
  bubble.scrollTop = 0;
  applyLayout();
  paintEdit();
}
function endBubbleEdit() {
  editBase = null;
  editRect = null;
  editDrag = null;
  document.body.classList.remove("editing");
  guides.stage.style.display = "none";
  guides.window.style.display = "none";
  guides.hint.style.display = "none";
  guides.bar.style.display = "none";
  for (const handle of handles) handle.style.display = "none";
  applyLayout();
  if (novel) paintNovel();
  else {
    bubble.dataset.mode = "";
    bubble.style.display = "none";
  }
}
function finishEdit(save) {
  if (!editBase) return;
  const rect = save
    ? {
        x: Math.round(editRect.x),
        y: Math.round(editRect.y),
        w: Math.round(editRect.w),
        h: Math.round(editRect.h),
      }
    : null;
  const wasNovel = novel;
  endBubbleEdit();
  if (save) window.pet?.send({ type: "bubble-edit-done", rect: rect });
  else window.pet?.send({ type: "bubble-edit-cancel" });
  if (!wasNovel) {
    bubble.dataset.mode = "";
    bubble.style.display = "none";
  }
}
function startEditDrag(event, mode, dir) {
  if (!editBase) return;
  event.preventDefault();
  event.stopPropagation();
  editDrag = { mode: mode, dir: dir, x: event.clientX, y: event.clientY, rect: { ...editRect } };
}
function moveEditDrag(event) {
  if (!editDrag || !editRect) return;
  const dx = event.clientX - editDrag.x;
  const dy = event.clientY - editDrag.y;
  const base = editDrag.rect;
  if (editDrag.mode === "move") {
    editRect.x = base.x + dx;
    editRect.y = base.y - dy;
    paintEdit();
    return;
  }
  let x = base.x;
  let y = base.y;
  let w = base.w;
  let h = base.h;
  if (editDrag.dir.includes("w")) {
    x = base.x + dx;
    w = base.w - dx;
  }
  if (editDrag.dir.includes("e")) w = base.w + dx;
  if (editDrag.dir.includes("n")) h = base.h - dy;
  if (editDrag.dir.includes("s")) {
    y = base.y - dy;
    h = base.h + dy;
  }
  w = Math.max(MIN_WIDTH, Math.round(w));
  h = snapBubbleHeight(h, LINE, PADDING_Y, MIN_LINES);
  if (editDrag.dir.includes("w")) x = base.x + base.w - w;
  if (editDrag.dir.includes("s")) y = base.y + base.h - h;
  editRect = { x: Math.round(x), y: Math.round(y), w: w, h: h };
  paintEdit();
}
for (const handle of handles) {
  handle.addEventListener("pointerdown", (event) => {
    startEditDrag(event, "resize", handle.dataset.dir);
  });
}
bubble.addEventListener("pointerdown", (event) => {
  if (editBase) startEditDrag(event, "move", "");
});
window.addEventListener("pointermove", (event) => {
  moveEditDrag(event);
});
window.addEventListener("pointerup", () => {
  editDrag = null;
});
window.addEventListener("keydown", (event) => {
  if (!editBase) return;
  if (event.key === "Enter") finishEdit(true);
  if (event.key === "Escape") finishEdit(false);
});
document.getElementById("edit-save").addEventListener("click", () => finishEdit(true));
document.getElementById("edit-cancel").addEventListener("click", () => finishEdit(false));

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
  if (bubble.dataset.mode !== "read" || editBase) return;
  event.preventDefault();
  event.stopPropagation();
  wheelStep(event.deltaY);
});
window.addEventListener("wheel", (event) => {
  if (!novelOpen || bubble.dataset.mode !== "read" || editBase) return;
  wheelStep(event.deltaY);
});
bubble.addEventListener("pointerdown", (event) => {
  event.stopPropagation();
  if (bubble.dataset.mode === "read" || editBase) return;
  if (state.taskId) window.pet?.send({ type: "activate" });
  hideBubble();
});
stage.addEventListener("pointerdown", (event) => {
  if (editBase || event.button !== 0) return;
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
  window.pet?.send({ type: "move", dx: dx, dy: dy });
});
window.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  if (editBase) return;
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
  if (editBase) return;
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
    if (editBase) return;
    if (novel) window.pet?.send({ type: "read-scroll", top: bubble.scrollTop || novel.top || 0 });
    hideNovel();
  }
  if (command && command.type === "tone") applyTone(command.tone);
  if (command && command.type === "bubble-edit") beginBubbleEdit(command);
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
