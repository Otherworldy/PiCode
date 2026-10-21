import { PET_BUBBLE_GAP, PET_BUBBLE_MARGIN, petBubbleTop } from "./petBubble.js";

/** 播放页脚本的前半段：加载、动作链、像素框测量与舞台布局。 */
export function renderPetPlayerMotionScript(): string {
  return `
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
    gap: ${PET_BUBBLE_GAP},
    minTop: ${PET_BUBBLE_MARGIN},
  }) + "px";
}
`;
}
