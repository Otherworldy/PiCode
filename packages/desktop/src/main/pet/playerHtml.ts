/** 气泡顶边。画面上方透明时下移到可见像素之上，避免停在窗口顶边。 */
export function petBubbleTop(input: {
  stageTop: number;
  stageWidth: number;
  stageHeight: number;
  videoWidth: number;
  videoHeight: number;
  opaqueRow: number;
  bubbleHeight: number;
}): number {
  const gap = 6;
  if (
    input.opaqueRow < 0 ||
    input.videoWidth <= 0 ||
    input.videoHeight <= 0 ||
    input.stageWidth <= 0 ||
    input.stageHeight <= 0
  ) {
    return 8;
  }
  const scale = Math.min(
    input.stageWidth / input.videoWidth,
    input.stageHeight / input.videoHeight,
  );
  const drawnHeight = input.videoHeight * scale;
  const offsetY = (input.stageHeight - drawnHeight) / 2;
  const head = input.stageTop + offsetY + (input.opaqueRow / input.videoHeight) * drawnHeight;
  return Math.max(4, head - input.bubbleHeight - gap);
}

export type PetBubbleTone = "dark" | "light";

export function petBubbleTone(value: unknown): PetBubbleTone {
  return value === "light" ? "light" : "dark";
}

export function renderPetPlayerHtml(manifestJson: string, tone: PetBubbleTone = "dark"): string {
  const safeJson = manifestJson.replace(/</g, "\\u003c");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; }
  #bubble {
    position: absolute; left: 8px; right: 8px; top: 8px; z-index: 2;
    max-height: 72px; overflow: hidden; padding: 6px 8px; border-radius: 10px;
    background: rgba(20, 20, 20, 0.88); color: white; font: 12px/1.35 sans-serif;
    cursor: pointer; display: none;
  }
  #bubble[data-tone="light"] {
    background: rgba(255, 255, 255, 0.96); color: #1a1a1a;
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.18);
  }
  #bubble[data-mode="read"] {
    overflow-y: auto; white-space: pre-wrap; word-break: break-word; scrollbar-width: none;
  }
  #bubble[data-mode="read"]::-webkit-scrollbar { width: 0; height: 0; }
  #stage { position: absolute; left: 0; right: 0; bottom: 0; top: 64px; }
  video { width: 100%; height: 100%; object-fit: contain; background: transparent; pointer-events: auto; }
  video.squish { animation: squish 180ms ease; }
  @keyframes squish { 40% { transform: scale(1.06, 0.92); } }
</style>
</head>
<body>
<div id="bubble" data-tone="${tone}" data-mode=""></div>
<div id="stage"><video id="pet" muted playsinline></video></div>
<script id="pet-manifest" type="application/json">${safeJson}</script>
<script>
const manifest = JSON.parse(document.getElementById("pet-manifest").textContent);
const video = document.getElementById("pet");
const stage = document.getElementById("stage");
const bubble = document.getElementById("bubble");
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
  stage.style.transform = state.facing === "right" ? "scaleX(-1)" : "";
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
video.addEventListener("playing", () => {
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
  bubble.style.top = petBubbleTop({
    stageTop: rect.top,
    stageWidth: rect.width,
    stageHeight: rect.height,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    opaqueRow: opaqueRow(),
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
