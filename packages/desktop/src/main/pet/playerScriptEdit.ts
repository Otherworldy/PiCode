/** 播放页脚本的第三段：气泡与舞台的拖拽编辑态。 */
export function renderPetPlayerEditScript(): string {
  return `
/* ---------- 气泡 / 舞台编辑态 ---------- */
let editLabels = {
  bar: "拖动气泡移动，拖动白框裁剪舞台",
  save: "保存",
  cancel: "取消",
  bubble: "气泡 {w} × {h}",
  stage: "舞台 {w} × {h}",
  window: "窗口 {w} × {h}",
};
function formatSize(template, width, height) {
  return template.replace("{w}", String(width)).replace("{h}", String(height));
}
const EDIT_SAMPLE =
  "这里是摸鱼正文的显示效果，用来判断字号、宽度和高度是否合适。拖动气泡移动位置，拖动蓝色方块调整大小；拖动白框裁剪角色舞台。";
let editBubble = null;
let editCrop = null;
let editCropStart = null;
let editFrame = { left: 0, bottom: 0, width: 0, height: 0 };
let editArea = { width: 0, height: 0 };
let editDrag = null;

function videoScale() {
  const vw = video.videoWidth || 1;
  return ((manifest.stage.width || vw) / vw) * scale;
}
// 裁剪框在窗口里的矩形。舞台就是这块裁剪，所以它的左下角就是角色落点。
function cropScreen() {
  const vh = video.videoHeight || 1;
  const s = videoScale();
  return {
    left: editFrame.left + editCrop.x * s,
    bottom: editFrame.bottom + (vh - editCrop.y - editCrop.h) * s,
    width: editCrop.w * s,
    height: editCrop.h * s,
  };
}
function editBubbleBox() {
  return {
    left: editBubble.left,
    bottom: editBubble.bottom,
    width: editBubble.w,
    height: editBubble.h,
  };
}
function paintHandles(list, box) {
  const top = editArea.height - box.bottom - box.height;
  for (const handle of list) {
    const dir = handle.dataset.dir;
    const x = box.left + (dir.includes("e") ? box.width : dir.includes("w") ? 0 : box.width / 2);
    const y = top + (dir.includes("s") ? box.height : dir.includes("n") ? 0 : box.height / 2);
    handle.style.left = x + "px";
    handle.style.top = y + "px";
    handle.style.display = "block";
  }
}
function paintEdit() {
  if (!editBase || !editBubble || !editCrop) return;
  const box = editBubbleBox();
  bubble.style.left = box.left + "px";
  bubble.style.bottom = box.bottom + "px";
  bubble.style.width = box.width + "px";
  bubble.style.height = box.height + "px";
  paintHandles(bubbleHandles, box);

  const crop = cropScreen();
  guides.crop.style.left = crop.left + "px";
  guides.crop.style.bottom = crop.bottom + "px";
  guides.crop.style.width = crop.width + "px";
  guides.crop.style.height = crop.height + "px";
  guides.crop.style.display = "block";
  paintHandles(cropHandles, crop);

  // 保存后的窗口：舞台换成新裁剪，气泡按新舞台换算，再把窗口范围画出来。
  const rect = {
    x: box.left - (crop.left + crop.width / 2),
    y: box.bottom - crop.bottom,
    w: box.width,
    h: box.height,
  };
  const next = petWindowLayout({
    stageWidth: Math.max(1, Math.round(crop.width)),
    stageHeight: Math.max(1, Math.round(crop.height)),
    defaultWidth: Math.max(geometry.defaultWidth || manifest.size || 320, Math.round(crop.width)),
    rect: rect,
    bubbleHeight: geometry.bubbleHeight || 76,
    gap: geometry.gap == null ? 6 : geometry.gap,
    inset: geometry.inset == null ? 8 : geometry.inset,
    margin: geometry.margin == null ? 4 : geometry.margin,
  });
  const stageTop = editArea.height - crop.bottom - crop.height;
  guides.window.style.left = crop.left - next.stageLeft + "px";
  guides.window.style.top = stageTop - (next.height - next.stageBottom - crop.height) + "px";
  guides.window.style.width = next.width + "px";
  guides.window.style.height = next.height + "px";
  guides.window.style.display = "block";
  guides.hint.textContent =
    formatSize(editLabels.bubble, Math.round(box.width), Math.round(box.height)) +
    "  ·  " +
    formatSize(editLabels.stage, Math.round(crop.width), Math.round(crop.height)) +
    "  ·  " +
    formatSize(editLabels.window, next.width, next.height);
  guides.hint.style.left =
    Math.max(4, Math.min(editArea.width - 280, guides.window.offsetLeft + 4)) + "px";
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
  // 编辑态里角色原来的位置：舞台就是当前裁剪框，它的左下角是基线。
  editBase = {
    left: layoutCache.stageLeft + origin.x,
    bottom: layoutCache.stageBottom + (area.height - from.height - origin.y),
  };
  // 编辑态不该让正文自己往下跑。
  syncAutoPage();
  // 整帧按当前缩放固定铺开，裁剪框在帧里拖。
  const s = videoScale();
  const vw = video.videoWidth || stageWidth;
  const vh = video.videoHeight || stageHeight;
  const crop = stageCrop
    ? {
        x: Math.round(stageCrop.x * vw),
        y: Math.round(stageCrop.y * vh),
        w: Math.max(1, Math.round(stageCrop.w * vw)),
        h: Math.max(1, Math.round(stageCrop.h * vh)),
      }
    : charBox || { x: 0, y: 0, w: vw, h: vh };
  editCrop = { ...crop };
  editCropStart = { ...crop };
  editFrame = {
    left: editBase.left - crop.x * s,
    bottom: editBase.bottom - (vh - crop.y - crop.h) * s,
    width: vw * s,
    height: vh * s,
  };
  const reader = layoutCache.reader;
  const shiftX = origin.x;
  const shiftBottom = area.height - from.height - origin.y;
  editBubble = {
    left: reader.left + shiftX,
    bottom: reader.bottom + shiftBottom,
    w: reader.width,
    h: Math.max(
      PADDING_Y * 2 + LINE * MIN_LINES,
      snapBubbleHeight(reader.height, LINE, PADDING_Y, MIN_LINES),
    ),
  };

  document.body.classList.add("editing");
  stage.style.left = editFrame.left + editFrame.width / 2 + "px";
  stage.style.bottom = editFrame.bottom + "px";
  stage.style.width = Math.round(editFrame.width) + "px";
  stage.style.height = Math.round(editFrame.height) + "px";
  video.style.left = "0px";
  video.style.top = "0px";
  video.style.width = Math.round(editFrame.width) + "px";
  video.style.height = Math.round(editFrame.height) + "px";

  guides.bar.style.left = "12px";
  guides.bar.style.top = "12px";
  guides.bar.style.display = "flex";
  bubble.dataset.mode = "read";
  bubble.textContent = novel && novel.text ? novel.text : EDIT_SAMPLE;
  bubble.style.display = "block";
  bubble.scrollTop = 0;
  paintEdit();
}
function endBubbleEdit() {
  editBase = null;
  syncAutoPage();
  editBubble = null;
  editCrop = null;
  editCropStart = null;
  editDrag = null;
  document.body.classList.remove("editing");
  guides.crop.style.display = "none";
  guides.window.style.display = "none";
  guides.hint.style.display = "none";
  guides.bar.style.display = "none";
  for (const handle of bubbleHandles) handle.style.display = "none";
  for (const handle of cropHandles) handle.style.display = "none";
  applyLayout();
  if (novel) paintNovel();
  else {
    bubble.dataset.mode = "";
    bubble.style.display = "none";
  }
}
function finishEdit(save) {
  if (!editBase) return;
  let payload = null;
  if (save) {
    const crop = cropScreen();
    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    // 没动过裁剪框就不写裁剪：自动裁剪是按每段动作量的，写死会把别的动作切掉。
    const cropChanged =
      editCropStart.x !== editCrop.x ||
      editCropStart.y !== editCrop.y ||
      editCropStart.w !== editCrop.w ||
      editCropStart.h !== editCrop.h;
    payload = {
      rect: {
        x: Math.round(editBubble.left - (crop.left + crop.width / 2)),
        y: Math.round(editBubble.bottom - crop.bottom),
        w: Math.round(editBubble.w),
        h: Math.round(editBubble.h),
      },
      stageCrop: cropChanged
        ? {
            x: editCrop.x / vw,
            y: editCrop.y / vh,
            w: editCrop.w / vw,
            h: editCrop.h / vh,
          }
        : null,
    };
  }
  const wasNovel = novel;
  endBubbleEdit();
  if (payload) {
    window.pet?.send({ type: "bubble-edit-done", rect: payload.rect, stageCrop: payload.stageCrop });
  } else {
    window.pet?.send({ type: "bubble-edit-cancel" });
  }
  if (!wasNovel) {
    bubble.dataset.mode = "";
    bubble.style.display = "none";
  }
}
function startEditDrag(event, target, dir) {
  if (!editBase) return;
  event.preventDefault();
  event.stopPropagation();
  editDrag = {
    target: target,
    dir: dir,
    x: event.clientX,
    y: event.clientY,
    bubble: { ...editBubble },
    crop: { ...editCrop },
  };
}
function resizeCrop(dir, dx, dy, base) {
  const s = videoScale();
  const vw = video.videoWidth || 1;
  const vh = video.videoHeight || 1;
  let x = base.x;
  let y = base.y;
  let w = base.w;
  let h = base.h;
  if (dir.includes("w")) {
    x = base.x + dx / s;
    w = base.w - dx / s;
  }
  if (dir.includes("e")) w = base.w + dx / s;
  if (dir.includes("n")) h = base.h - dy / s;
  if (dir.includes("s")) {
    y = base.y - dy / s;
    h = base.h + dy / s;
  }
  w = Math.max(Math.max(8, vw * 0.08), w);
  h = Math.max(Math.max(8, vh * 0.08), h);
  if (dir.includes("w")) x = base.x + base.w - w;
  if (dir.includes("s")) y = base.y + base.h - h;
  x = Math.min(Math.max(0, x), vw - w);
  y = Math.min(Math.max(0, y), vh - h);
  w = Math.min(w, vw - x);
  h = Math.min(h, vh - y);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}
function moveEditDrag(event) {
  if (!editDrag) return;
  const dx = event.clientX - editDrag.x;
  const dy = event.clientY - editDrag.y;
  if (editDrag.target === "crop") {
    if (editDrag.dir) {
      editCrop = resizeCrop(editDrag.dir, dx, dy, editDrag.crop);
    } else {
      const s = videoScale();
      const vw = video.videoWidth || 1;
      const vh = video.videoHeight || 1;
      editCrop = {
        ...editCrop,
        x: Math.round(Math.min(Math.max(0, editDrag.crop.x + dx / s), vw - editCrop.w)),
        y: Math.round(Math.min(Math.max(0, editDrag.crop.y - dy / s), vh - editCrop.h)),
      };
    }
    paintEdit();
    return;
  }
  const base = editDrag.bubble;
  if (!editDrag.dir) {
    editBubble = { ...editBubble, left: base.left + dx, bottom: base.bottom - dy };
    paintEdit();
    return;
  }
  let left = base.left;
  let bottom = base.bottom;
  let w = base.w;
  let h = base.h;
  if (editDrag.dir.includes("w")) {
    left = base.left + dx;
    w = base.w - dx;
  }
  if (editDrag.dir.includes("e")) w = base.w + dx;
  if (editDrag.dir.includes("n")) h = base.h - dy;
  if (editDrag.dir.includes("s")) {
    bottom = base.bottom - dy;
    h = base.h + dy;
  }
  w = Math.max(MIN_WIDTH, Math.round(w));
  h = snapBubbleHeight(h, LINE, PADDING_Y, MIN_LINES);
  if (editDrag.dir.includes("w")) left = base.left + base.w - w;
  if (editDrag.dir.includes("s")) bottom = base.bottom + base.h - h;
  editBubble = { left: Math.round(left), bottom: Math.round(bottom), w: w, h: h };
  paintEdit();
}
for (const handle of bubbleHandles) {
  handle.addEventListener("pointerdown", (event) => {
    startEditDrag(event, "bubble", handle.dataset.dir);
  });
}
for (const handle of cropHandles) {
  handle.addEventListener("pointerdown", (event) => {
    startEditDrag(event, "crop", handle.dataset.dir);
  });
}
guides.crop.addEventListener("pointerdown", (event) => startEditDrag(event, "crop", ""));
bubble.addEventListener("pointerdown", (event) => {
  if (editBase) startEditDrag(event, "bubble", "");
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

`;
}
