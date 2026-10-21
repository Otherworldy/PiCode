import { petBubbleTone, petBubbleTop, type PetBubbleTone } from "./petBubble.js";
import { PET_PLAYER_CSS } from "./playerCss.js";

export { petBubbleTone, petBubbleTop };
export type { PetBubbleTone };

export function renderPetPlayerHtml(manifestJson: string, tone: PetBubbleTone = "dark"): string {
  const safeJson = manifestJson.replace(/</g, "\\u003c");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>${PET_PLAYER_CSS}</style>
</head>
<body>
<div id="bubble" data-tone="${tone}" data-mode=""></div>
<div id="frame"><div id="stage"><video id="pet" muted playsinline></video></div></div>
<script id="pet-manifest" type="application/json">${safeJson}</script>
<script>
const manifest = JSON.parse(document.getElementById("pet-manifest").textContent);
const video = document.getElementById("pet");
const frame = document.getElementById("frame");
const stage = document.getElementById("stage");
const bubble = document.getElementById("bubble");
// 裁到角色像素框时：点、拖、右键只在角色矩形里生效，不包含视频自带的透明留白。
// 框要到拿到具体帧才知道，所以每换一段片段重新量一次；量不出来就先铺满整块。
// 设置里关掉裁剪后不会再量，舞台就是整帧。
const cropToCharacter = manifest.crop !== false;
let charBox = null;
const scale = manifest.displayScale > 0 ? manifest.displayScale : 1;
function layout(box) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  const base = (manifest.stage.width || vw) / vw;
  const s = base * scale;
  const crop = box || { x: 0, y: 0, w: vw, h: vh };
  charBox = crop;
  stage.style.width = Math.round(crop.w * s) + "px";
  stage.style.height = Math.round(crop.h * s) + "px";
  video.style.left = -Math.round(crop.x * s) + "px";
  video.style.top = -Math.round(crop.y * s) + "px";
  video.style.width = Math.round(vw * s) + "px";
  video.style.height = Math.round(vh * s) + "px";
}
const probeCanvas = document.createElement("canvas");
function measureBox() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const sampleW = 96;
  const sampleH = Math.max(1, Math.round((vh * sampleW) / vw));
  probeCanvas.width = sampleW;
  probeCanvas.height = sampleH;
  const ctx = probeCanvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, sampleW, sampleH);
  let data;
  try {
    ctx.drawImage(video, 0, 0, sampleW, sampleH);
    data = ctx.getImageData(0, 0, sampleW, sampleH).data;
  } catch {
    return null;
  }
  let minX = sampleW, minY = sampleH, maxX = -1, maxY = -1;
  for (let y = 0; y < sampleH; y += 1) {
    for (let x = 0; x < sampleW; x += 1) {
      if (data[(y * sampleW + x) * 4 + 3] > 24) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const sx = vw / sampleW;
  const sy = vh / sampleH;
  const x = Math.max(0, Math.floor(minX * sx));
  const y = Math.max(0, Math.floor(minY * sy));
  const w = Math.min(vw - x, Math.ceil((maxX + 1) * sx) - x);
  const h = Math.min(vh - y, Math.ceil((maxY + 1) * sy) - y);
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}
const state = { facing: "left", mode: "chain", current: "", work: [], mood: [], taskId: "" };
let dismissTimer = 0;
let drag = null;

function poolPick(pool) {
  if (!pool || !pool.length) return null;
  const filtered = pool.filter((clip) => clip.name !== state.current);
  const source = filtered.length ? filtered : pool;
  return source[Math.floor(Math.random() * source.length)];
}
function pickCategory() {
  const filled = manifest.categories.filter((category) => category.actions.length);
  const mirrored = filled.filter((category) => !(category.noMirror && state.facing === "right"));
  const eligible = mirrored.length ? mirrored : filled;
  if (!eligible.length) return null;
  const total = eligible.reduce((sum, category) => sum + category.weight, 0) || 1;
  let cursor = Math.random() * total;
  for (const category of eligible) {
    cursor -= category.weight;
    if (cursor <= 0) return poolPick(category.actions);
  }
  return poolPick(eligible[eligible.length - 1].actions);
}
function resumeLoop() {
  if (state.work.length) {
    play(poolPick(state.work), "work");
    return;
  }
  if (state.mood.length) {
    play(poolPick(state.mood), "mood");
    return;
  }
  const next = nextChain();
  play(next.clip, next.kind);
}
function nextChain() {
  const weights = manifest.weights;
  const turn = manifest.fixed ? 0 : weights.turn;
  const move = manifest.fixed ? 0 : weights.move;
  const roll = Math.random();
  let kind = "action";
  if (roll < weights.idle / 100) kind = "idle";
  else if (roll < (weights.idle + turn) / 100) kind = "turn";
  else if (roll < (weights.idle + turn + move) / 100) kind = "move";
  let clip = null;
  if (kind === "idle") clip = poolPick(manifest.idle);
  else if (kind === "turn") clip = poolPick(manifest.turn);
  else if (kind === "move") clip = poolPick(manifest.moves);
  else clip = pickCategory();
  if (!clip) return { clip: poolPick(manifest.idle), kind: "chain" };
  return { clip, kind: kind === "turn" ? "turn" : "chain" };
}
function applyFacing() {
  const mirror = state.facing === "right" ? " scaleX(-1)" : "";
  stage.style.transform = "translateX(-50%)" + mirror;
}
function play(clip, mode) {
  if (!clip) {
    const fallback = nextChain();
    if (!fallback.clip) return;
    play(fallback.clip, fallback.kind);
    return;
  }
  state.mode = mode;
  state.current = clip.name;
  applyFacing();
  if (video.getAttribute("src") === clip.url) {
    video.currentTime = 0;
    video.play().catch(() => {});
    return;
  }
  video.src = clip.url;
  video.play().catch(() => {});
}
video.addEventListener("loadedmetadata", () => layout(null));
let boxClip = "";
let boxTimer = 0;
function syncBox() {
  if (!cropToCharacter || boxClip === state.current) return;
  boxClip = state.current;
  window.clearTimeout(boxTimer);
  // 新片段第一帧可能还在淡入，量两次取并集，避免把角色裁掉一块。
  const first = measureBox();
  if (first) layout(first);
  boxTimer = window.setTimeout(() => {
    const next = measureBox();
    const box = unionBox(first, next);
    if (box) {
      layout(box);
      window.pet?.send({ type: "box", width: stage.offsetWidth, height: stage.offsetHeight });
    }
  }, 220);
}
function unionBox(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.w, b.x + b.w);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: right - x, h: bottom - y };
}
video.addEventListener("playing", () => {
  syncBox();
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => placeBubble());
  else placeBubble();
});
video.addEventListener("ended", () => {
  if (state.mode === "turn") state.facing = state.facing === "left" ? "right" : "left";
  if (state.mode === "work") {
    play(poolPick(state.work) || state.work[0], "work");
    return;
  }
  if (state.mode === "drag") {
    video.currentTime = 0;
    video.play().catch(() => {});
    return;
  }
  if (state.mode === "mood") {
    play(poolPick(state.mood) || state.mood[0], "mood");
    return;
  }
  resumeLoop();
});
const petBubbleTop = ${petBubbleTop.toString()};
const probe = document.createElement("canvas");
function opaqueRow() {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return -1;
  const sampleW = 64;
  const sampleH = Math.max(1, Math.round((height * sampleW) / width));
  probe.width = sampleW;
  probe.height = sampleH;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  if (!ctx) return -1;
  ctx.clearRect(0, 0, sampleW, sampleH);
  try {
    ctx.drawImage(video, 0, 0, sampleW, sampleH);
    const data = ctx.getImageData(0, 0, sampleW, sampleH).data;
    for (let y = 0; y < sampleH; y++) {
      for (let x = 0; x < sampleW; x++) {
        if (data[(y * sampleW + x) * 4 + 3] > 24) return Math.round((y / sampleH) * height);
      }
    }
  } catch {
    return -1;
  }
  return -1;
}
function placeBubble() {
  if (bubble.style.display === "none") return;
  const rect = stage.getBoundingClientRect();
  const row = opaqueRow();
  const box = charBox;
  const ratio =
    row < 0 || !box || box.h <= 0 ? -1 : Math.max(0, (row - box.y) / box.h);
  bubble.style.top = petBubbleTop({
    stageTop: rect.top,
    stageHeight: rect.height,
    rowRatio: ratio,
    bubbleHeight: bubble.offsetHeight,
  }) + "px";
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
  if (novel.edge === "end") bubble.scrollTop = bubble.scrollHeight;
  else bubble.scrollTop = novel.top || 0;
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
  const atTop = bubble.scrollTop <= 0;
  const atBottom = bubble.scrollTop + bubble.clientHeight >= bubble.scrollHeight - 1;
  if (event.deltaY > 0 && atBottom) requestReaderPage(1);
  else if (event.deltaY < 0 && atTop) requestReaderPage(-1);
});
window.addEventListener("wheel", (event) => {
  if (!novelOpen || bubble.dataset.mode !== "read" || event.target === bubble) return;
  const before = bubble.scrollTop;
  bubble.scrollTop += event.deltaY;
  if (bubble.scrollTop === before) requestReaderPage(event.deltaY > 0 ? 1 : -1);
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
</script>
</body>
</html>`;
}
