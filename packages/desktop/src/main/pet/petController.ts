/* eslint-disable max-lines -- 桌面宠物控制器管理透明窗口、下载、摸鱼阅读与音频视频媒体授权，集中收口维护避免状态割裂 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  BrowserWindow,
  Menu,
  globalShortcut,
  ipcMain,
  screen,
  type BrowserWindow as BrowserWindowType,
  type MenuItemConstructorOptions,
  type Rectangle as ParamRectangle,
} from "electron";
import {
  buildLocalMediaPreviewUrl,
  DESKTOP_PET_DISPLAY_SCALE_DEFAULT,
  DESKTOP_PET_READER_HOTKEY_DEFAULT,
  desktopPetMoodSlot,
  mergeDesktopPetMoods,
  normalizeDesktopPetCropCharacter,
  normalizeDesktopPetDisplayScale,
  normalizeDesktopPetMood,
  normalizeDesktopPetReaderBubbleRect,
  normalizeDesktopPetReaderHotkey,
  normalizeDesktopPetReaderHotkeyMode,
  normalizeDesktopPetStageCrop,
  type AppSettings,
  type DesktopPetInstalledPack,
  type DesktopPetMood,
  type DesktopPetPersistedSettings,
  type DesktopPetBubbleLayout,
  type DesktopPetReaderBubbleRect,
  type DesktopPetStageCrop,
  type TaskNotificationPayload,
} from "@zcode/shared";
import { createUpdateFetch, type UpdateNetworkSettings } from "../appUpdate/proxyFetch.js";
import { downloadPetPack, PetPackDownloadError } from "./downloadPack.js";
import {
  deleteInstalledPetPack,
  importLocalPetPack,
  listInstalledPetPacks,
  localPackId,
} from "./installedPacks.js";
import {
  downloadFailureStatus,
  getDesktopPetDownloadStatus,
  publishDesktopPetDownload,
} from "./petDownloadStatus.js";
import {
  noteHoldPress,
  pollHoldLatch,
  startReaderHoldProbe,
  type HoldLatch,
  type KeyHeldProbe,
} from "./keyHeld.js";
import { loadPetPack, petStageHeight, type PetClip, type PetPack } from "./pack.js";
import { petContextMenu, type PetMenuEntry, type PetMenuSource } from "./petMenu.js";
import { petWindowLayout, type PetWindowLayout } from "./bubbleGeometry.js";
import {
  PET_BUBBLE_GAP,
  PET_BUBBLE_HEIGHT,
  PET_BUBBLE_INSET,
  PET_BUBBLE_MARGIN,
  petBubbleEditLabels,
} from "./petBubble.js";
import { petBubbleTone, renderPetPlayerHtml, type PetBubbleTone } from "./playerHtml.js";
import {
  PET_READER_CHUNK_BYTES,
  PET_READER_MAX_BYTES,
  PET_READER_PAGE_CHARS,
  detectPetReaderEncoding,
  findPetReaderQuery,
  readPetReaderChars,
  readPetReaderTail,
  type PetReaderEncoding,
} from "./readerText.js";

const PET_COMMAND = "zcode:pet-command";
const PET_EVENT = "zcode:pet-event";
const WORK_STATUS_INDEX: Record<TaskNotificationPayload["status"], number> = {
  feedback_update: 2,
  permission_request: 3,
  elicitation_request: 3,
  completed: 4,
  failed: 5,
};

interface PetLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

interface PetManifest extends PetMenuSource {
  /** 角色画面的像素区域。窗口下沿对齐，上方留气泡条。 */
  stage: { width: number; height: number };
  /** 用户选的显示缩放，渲染端乘在角色像素上。 */
  displayScale: number;
  /** 是否把舞台裁到角色像素框。关掉时按整帧构图。 */
  crop: boolean;
  /** 窗口布局参数：角色舞台和气泡怎么摆进窗口。 */
  geometry: {
    defaultWidth: number;
    bubbleHeight: number;
    gap: number;
    inset: number;
    margin: number;
    rect: DesktopPetReaderBubbleRect | null;
    /** 手动裁剪的比例，页面按视频帧换算成像素。 */
    stageCrop: DesktopPetStageCrop | null;
  };
  size: number;
  fixed: boolean;
  weights: { idle: number; turn: number; move: number };
  workStatus: Array<Array<{ name: string; url: string }>>;
}

interface PetSettings {
  enabled: boolean;
  packDir: string;
  packUrl: string;
  bubbleTone: PetBubbleTone;
  displayScale: number;
  cropCharacter: boolean;
  readerBubbleRect: DesktopPetReaderBubbleRect | null;
  stageCrop: DesktopPetStageCrop | null;
  readerPath: string;
  readerHotkey: string;
  readerHotkeyMode: "toggle" | "hold";
}

let logger: PetLogger = { info: () => {}, warn: () => {} };
let patchSettings: (patch: Partial<AppSettings>) => void = () => {};
let appLocale: () => string = () => "en-US";
let petRootDir = "";
let preloadPath = "";
let settings: PetSettings = {
  enabled: false,
  packDir: "",
  packUrl: "",
  bubbleTone: "dark",
  displayScale: DESKTOP_PET_DISPLAY_SCALE_DEFAULT,
  cropCharacter: true,
  readerBubbleRect: null,
  stageCrop: null,
  readerPath: "",
  readerHotkey: DESKTOP_PET_READER_HOTKEY_DEFAULT,
  readerHotkeyMode: "toggle",
};
let registeredHotkey = "";
let holdProbe: KeyHeldProbe | null = null;
let holdTimer: ReturnType<typeof setInterval> | null = null;
let holdLatch: HoldLatch = { latched: false, seenDown: false, since: 0 };
const moodBySender = new Map<number, DesktopPetMood>();
let activeMood: DesktopPetMood = "idle";
let readerFile: {
  path: string;
  mtimeMs: number;
  size: number;
  encoding: PetReaderEncoding;
} | null = null;
let readerPhase: "closed" | "opening" | "open" = "closed";
let readerToken = 0;
let readerOffset = 0;
let readerSpan = 0;
let readerTop = 0;
let pendingRestore: PetSettings | null = null;
let generation = 0;
let downloadAbort: AbortController | null = null;
let downloadFlight: Promise<void> | null = null;
let stopRequested = false;
let network: UpdateNetworkSettings = {};
let petWindow: BrowserWindowType | null = null;
let mediaPaths = new Set<string>();
let installedPreviewMediaPaths = new Set<string>();
let onActivate: (() => void) | null = null;
let dismissTimer: NodeJS.Timeout | null = null;
let listenersReady = false;
let currentManifest: PetManifest | null = null;
let currentPackRoot = "";
let currentPack: PetPack | null = null;
/** 角色舞台左下角在屏幕上的位置。窗口怎么涨缩、怎么被拖，角色都按这个点落位。 */
let stageOrigin: { x: number; y: number } | null = null;
let bubbleEdit: {
  /** 编辑开始时窗口的位置和大小，取消时还原。 */
  bounds: ParamRectangle;
  resolve: (layout: DesktopPetBubbleLayout | null) => void;
} | null = null;

export { resolveDesktopPetRootDir } from "./petRoot.js";

export function bindDesktopPet(options: {
  logger: PetLogger;
  petRootDir: string;
  preloadPath: string;
  /** 写回应用设置。摸鱼气泡的位置要跟着 setting.json 走，否则重启就没了。 */
  patchSettings: (patch: Partial<AppSettings>) => void;
  /** 当前界面语言。气泡编辑态的文字要跟应用一致。 */
  locale: () => string;
}): void {
  logger = options.logger;
  petRootDir = options.petRootDir;
  preloadPath = options.preloadPath;
  patchSettings = options.patchSettings;
  appLocale = options.locale;
  if (listenersReady) return;
  listenersReady = true;
  ipcMain.on(PET_EVENT, (event, payload: unknown) => {
    if (!petWindow || event.sender !== petWindow.webContents) return;
    handlePetEvent(payload);
  });
}

export function noteDesktopPetSettings(patch: Partial<AppSettings>, full = false): void {
  noteNetwork(patch, full);
  if (
    !full &&
    !("desktopPetEnabled" in patch) &&
    !("desktopPetPackDir" in patch) &&
    !("desktopPetPackUrl" in patch) &&
    !("desktopPetBubbleTone" in patch) &&
    !("desktopPetDisplayScale" in patch) &&
    !("desktopPetCropCharacter" in patch) &&
    !("desktopPetReaderBubbleRect" in patch) &&
    !("desktopPetStageCrop" in patch) &&
    !("desktopPetReaderPath" in patch) &&
    !("desktopPetReaderHotkey" in patch) &&
    !("desktopPetReaderHotkeyMode" in patch)
  ) {
    return;
  }
  const next: PetSettings = {
    enabled: hasOwn(patch, "desktopPetEnabled")
      ? patch.desktopPetEnabled === true
      : full
        ? false
        : settings.enabled,
    packDir: readPetString(patch, "desktopPetPackDir", full, settings.packDir),
    packUrl: readPetString(patch, "desktopPetPackUrl", full, settings.packUrl),
    bubbleTone: hasOwn(patch, "desktopPetBubbleTone")
      ? petBubbleTone(patch.desktopPetBubbleTone)
      : full
        ? "dark"
        : settings.bubbleTone,
    displayScale: hasOwn(patch, "desktopPetDisplayScale")
      ? normalizeDesktopPetDisplayScale(patch.desktopPetDisplayScale)
      : full
        ? DESKTOP_PET_DISPLAY_SCALE_DEFAULT
        : settings.displayScale,
    cropCharacter: hasOwn(patch, "desktopPetCropCharacter")
      ? normalizeDesktopPetCropCharacter(patch.desktopPetCropCharacter)
      : full
        ? true
        : settings.cropCharacter,
    readerBubbleRect: hasOwn(patch, "desktopPetReaderBubbleRect")
      ? normalizeDesktopPetReaderBubbleRect(patch.desktopPetReaderBubbleRect)
      : full
        ? null
        : settings.readerBubbleRect,
    stageCrop: hasOwn(patch, "desktopPetStageCrop")
      ? normalizeDesktopPetStageCrop(patch.desktopPetStageCrop)
      : full
        ? null
        : settings.stageCrop,
    readerPath: readPetString(patch, "desktopPetReaderPath", full, settings.readerPath),
    readerHotkey: hasOwn(patch, "desktopPetReaderHotkey")
      ? normalizeDesktopPetReaderHotkey(patch.desktopPetReaderHotkey)
      : full
        ? DESKTOP_PET_READER_HOTKEY_DEFAULT
        : settings.readerHotkey,
    readerHotkeyMode: hasOwn(patch, "desktopPetReaderHotkeyMode")
      ? normalizeDesktopPetReaderHotkeyMode(patch.desktopPetReaderHotkeyMode)
      : full
        ? "toggle"
        : settings.readerHotkeyMode,
  };
  // 旧进程重写 setting.json 时会丢掉不认识的宠物字段。启动时如果读到的全是默认值，沿用 pets/settings.json。
  let chosen = next;
  if (full && isDefaultPetSettings(next)) {
    const side = readPetSettingsFile();
    if (side && !isDefaultPetSettings(side)) {
      chosen = side;
      pendingRestore = side;
    }
  }
  const packChanged =
    chosen.enabled !== settings.enabled ||
    chosen.packDir !== settings.packDir ||
    chosen.packUrl !== settings.packUrl;
  const sizeChanged = chosen.displayScale !== settings.displayScale;
  const cropChanged = chosen.cropCharacter !== settings.cropCharacter;
  const bubbleRectChanged = !sameBubbleRect(chosen.readerBubbleRect, settings.readerBubbleRect);
  const stageCropChanged = !sameStageCrop(chosen.stageCrop, settings.stageCrop);
  const toneChanged = chosen.bubbleTone !== settings.bubbleTone;
  const readerChanged =
    chosen.readerPath !== settings.readerPath ||
    chosen.readerHotkey !== settings.readerHotkey ||
    chosen.readerHotkeyMode !== settings.readerHotkeyMode;
  if (chosen.readerPath !== settings.readerPath) readerFile = null;
  settings = chosen;
  if (pendingRestore !== chosen) writePetSettingsFile(settings);
  if (readerChanged && readerPhase !== "closed") closeReader();
  // 只改气泡或摸鱼设置时不重载窗口，否则位置和正在播的动画会被重置。
  if (
    packChanged ||
    sizeChanged ||
    cropChanged ||
    bubbleRectChanged ||
    stageCropChanged ||
    !petWindow ||
    petWindow.isDestroyed()
  ) {
    scheduleApply();
    return;
  }
  if (toneChanged) sendBubbleTone();
  if (readerChanged) syncReaderHotkey();
}

export { getDesktopPetDownloadStatus };

/**
 * 把宠物窗口切到编辑态：窗口临时铺满工作区，让用户直接把气泡拖到想要的位置和大小。
 * 页面负责画手柄和引导线，保存/取消都回到这里。
 */
export function editDesktopPetBubble(): Promise<DesktopPetBubbleLayout | null> {
  if (bubbleEdit) return Promise.resolve(null);
  const win = petWindow;
  if (!win || win.isDestroyed() || !currentManifest) return Promise.resolve(null);
  const bounds = win.getBounds();
  const workArea = screen.getDisplayMatching(bounds).workArea;
  const area = {
    x: workArea.x + 12,
    y: workArea.y + 12,
    width: Math.max(320, workArea.width - 24),
    height: Math.max(240, workArea.height - 24),
  };
  return new Promise<DesktopPetBubbleLayout | null>((resolve) => {
    bubbleEdit = { bounds, resolve };
    win.setBounds(area);
    win.focus();
    win.webContents.send(PET_COMMAND, {
      type: "bubble-edit",
      origin: { x: bounds.x - area.x, y: bounds.y - area.y },
      area: { width: area.width, height: area.height },
      from: { width: bounds.width, height: bounds.height },
      labels: petBubbleEditLabels(appLocale()),
    });
  });
}

/** 结束编辑态：保存就落盘并重排窗口，取消就按原样重新铺一次。 */
function finishBubbleEdit(
  rect: DesktopPetReaderBubbleRect | null,
  stageCrop: DesktopPetStageCrop | null = null,
): void {
  const editing = bubbleEdit;
  if (!editing) return;
  bubbleEdit = null;
  if (rect || stageCrop) {
    settings = {
      ...settings,
      readerBubbleRect: rect ?? settings.readerBubbleRect,
      stageCrop: stageCrop ?? settings.stageCrop,
    };
    writePetSettingsFile(settings);
    patchSettings({
      desktopPetReaderBubbleRect: settings.readerBubbleRect,
      desktopPetStageCrop: settings.stageCrop,
    });
  }
  // 先还原编辑前的窗口，再按最新设置重排；重载页面最稳，不会留下编辑态的残留样式。
  const win = petWindow;
  if (win && !win.isDestroyed()) win.setBounds(editing.bounds);
  if (currentPack && settings.enabled) showPet(currentPack);
  editing.resolve(rect ? { rect, stageCrop: settings.stageCrop } : null);
  logger.info("[desktop-pet] bubble edit finished", rect ? "saved" : "cancelled");
}

/** 摸鱼气泡回到默认摆放。 */
export function resetDesktopPetBubble(): void {
  if (!settings.readerBubbleRect && !settings.stageCrop) return;
  settings = { ...settings, readerBubbleRect: null, stageCrop: null };
  writePetSettingsFile(settings);
  patchSettings({ desktopPetReaderBubbleRect: null, desktopPetStageCrop: null });
  if (currentPack && settings.enabled && petWindow && !petWindow.isDestroyed()) {
    showPet(currentPack);
  }
}

export function listDesktopPetInstalledPacks(): DesktopPetInstalledPack[] {
  if (!petRootDir) return [];
  const packs = listInstalledPetPacks(petRootDir);
  installedPreviewMediaPaths.clear();
  for (const pack of packs) {
    if (pack.idleClipPath) installedPreviewMediaPaths.add(canonical(pack.idleClipPath));
  }
  return packs;
}

export function importDesktopPetPack(localDir: string): {
  success: boolean;
  error?: string;
  pack?: DesktopPetInstalledPack;
} {
  if (!petRootDir) return { success: false, error: "no-pet-root" };
  const res = importLocalPetPack(petRootDir, localDir);
  if (res.success && res.pack?.idleClipPath) {
    installedPreviewMediaPaths.add(canonical(res.pack.idleClipPath));
  }
  return res;
}

export function deleteDesktopPetPack(id: string, sourceType: "download" | "local"): boolean {
  if (!petRootDir) return false;
  const ok = deleteInstalledPetPack(petRootDir, id, sourceType);
  if (!ok) return false;
  let changed = false;
  if (sourceType === "local" && settings.packDir) {
    if (localPackId(settings.packDir) === id || settings.packDir === id) {
      settings.packDir = "";
      changed = true;
    }
  } else if (sourceType === "download" && settings.packUrl) {
    settings.packUrl = "";
    changed = true;
  }
  if (changed) {
    writePetSettingsFile(settings);
    scheduleApply();
  }
  return true;
}

export function getDesktopPetSettingsSnapshot(): DesktopPetPersistedSettings {
  return { ...settings };
}

export function takeDesktopPetSettingsRestore(): DesktopPetPersistedSettings | null {
  const restored = pendingRestore;
  pendingRestore = null;
  return restored ? { ...restored } : null;
}

export async function findDesktopPetReaderText(query: string): Promise<boolean> {
  const needle = query.trim().slice(0, 80);
  if (!needle || !settings.readerPath) return false;
  const meta = await ensureReaderFile(settings.readerPath);
  if (!meta) return false;
  const found =
    (await scanReader(meta, needle, readerOffset + 1, meta.size)) ??
    (await scanReader(meta, needle, 0, readerOffset + 1));
  if (found === null) return false;
  const window = await loadReaderWindow(meta, found);
  if (!window) return false;
  readerOffset = window.offset;
  readerSpan = window.bytes;
  readerTop = 0;
  saveReaderPlace();
  if (!petWindow || petWindow.isDestroyed()) return true;
  readerToken += 1;
  readerPhase = "open";
  sendReaderPage(window.text, "start", 0);
  return true;
}

export function disposeDesktopPet(): void {
  generation += 1;
  stopRequested = false;
  downloadAbort?.abort();
  destroyPetWindow();
}

export function stopDesktopPetDownload(): void {
  if (!downloadAbort || downloadAbort.signal.aborted) return;
  stopRequested = true;
  downloadAbort.abort();
}

export function isDesktopPetWindow(win: BrowserWindowType): boolean {
  return petWindow !== null && win === petWindow;
}

export function isDesktopPetMediaPath(path: string): boolean {
  return mediaPaths.has(path) || installedPreviewMediaPaths.has(path);
}

export function tryPresentTaskOnPet(input: {
  taskId: string;
  status: TaskNotificationPayload["status"];
  title: string;
  body: string;
  onActivate: () => void;
}): boolean {
  if (!petWindow || petWindow.isDestroyed()) return false;
  const slots = currentManifest?.workStatus ?? [];
  // 槽位按编号取。包里没有这一槽就只留气泡，不用旁边的槽顶上。
  const clips = slots[WORK_STATUS_INDEX[input.status]] ?? [];
  onActivate = input.onActivate;
  petWindow.webContents.send(PET_COMMAND, {
    type: "notify",
    text: `${input.title}\n${input.body}`.trim(),
    taskId: input.taskId,
    clips,
  });
  if (dismissTimer) clearTimeout(dismissTimer);
  dismissTimer = setTimeout(() => {
    onActivate = null;
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.webContents.send(PET_COMMAND, { type: "dismiss" });
    }
  }, 10_000);
  return true;
}

function scheduleApply(): void {
  stopRequested = false;
  downloadAbort?.abort();
  const controller = new AbortController();
  downloadAbort = controller;
  const token = ++generation;
  const previous = downloadFlight;
  const next = (async () => {
    try {
      await previous;
    } catch {
      // 上一轮取消或失败后，再按最新的地址下载。
    }
    if (leftDownload(token, controller.signal)) return;
    await applySettings(token, controller.signal);
  })();
  downloadFlight = next;
}

function leftDownload(token: number, signal: AbortSignal): boolean {
  if (!signal.aborted && token === generation) return false;
  if (stopRequested && token === generation) {
    stopRequested = false;
    publishDesktopPetDownload({ phase: "stopped" });
  }
  return true;
}

function noteNetwork(patch: Partial<AppSettings>, full: boolean): void {
  if (full || hasOwn(patch, "httpProxy")) {
    network = { ...network, httpProxy: typeof patch.httpProxy === "string" ? patch.httpProxy : "" };
  }
  if (full || hasOwn(patch, "httpProxyNoProxy")) {
    network = {
      ...network,
      httpProxyNoProxy: typeof patch.httpProxyNoProxy === "string" ? patch.httpProxyNoProxy : "",
    };
  }
  if (full || hasOwn(patch, "httpProxyCaCertPath")) {
    network = {
      ...network,
      httpProxyCaCertPath:
        typeof patch.httpProxyCaCertPath === "string" ? patch.httpProxyCaCertPath : "",
    };
  }
}

async function applySettings(token: number, signal: AbortSignal): Promise<void> {
  if (!settings.packDir && !settings.packUrl) {
    publishDesktopPetDownload({ phase: "idle" });
    destroyPetWindow();
    return;
  }
  if (!settings.enabled) destroyPetWindow();
  try {
    let sourceDir = settings.packDir;
    if (!sourceDir) {
      publishDesktopPetDownload({ phase: "downloading", received: 0, total: null });
      sourceDir = await downloadPetPack(settings.packUrl, join(petRootDir, "packs"), {
        signal,
        fetch: createUpdateFetch(network),
        onProgress: (event) => {
          if (signal.aborted || token !== generation) return;
          publishDesktopPetDownload(
            event.phase === "extracting"
              ? { phase: "extracting" }
              : { phase: "downloading", received: event.received, total: event.total },
          );
        },
      });
    } else {
      publishDesktopPetDownload({ phase: "idle" });
    }
    if (leftDownload(token, signal)) return;
    if (!settings.enabled) {
      if (!settings.packUrl || settings.packDir) return;
      publishDesktopPetDownload({ phase: "ready" });
      return;
    }
    const pack = loadPetPack(sourceDir);
    if (!pack) throw new PetPackDownloadError("missing-config");
    if (leftDownload(token, signal)) return;
    showPet(pack);
    if (!settings.packDir) publishDesktopPetDownload({ phase: "ready" });
    logger.info("[desktop-pet] showing pack", pack.rootDir);
  } catch (error) {
    if (leftDownload(token, signal)) return;
    destroyPetWindow();
    publishDesktopPetDownload(downloadFailureStatus(error));
    logger.warn("[desktop-pet] pack unavailable, notifications stay on the system channel", error);
  }
}

/** 角色舞台的尺寸：手动裁剪优先，其次用量到的角色像素，最后按整帧比例。 */
function stageSizeFor(pack: PetPack): { width: number; height: number } {
  const crop = settings.stageCrop;
  if (crop) {
    const scale = settings.displayScale;
    return {
      width: Math.max(1, Math.round(crop.w * pack.size * scale)),
      height: Math.max(1, Math.round(crop.h * petStageHeight(pack.aspect, pack.size) * scale)),
    };
  }
  const cached = settings.cropCharacter ? readPetBox(pack.rootDir) : null;
  if (cached) return { width: cached.width, height: cached.height };
  const scale = settings.displayScale;
  return {
    width: Math.round(pack.size * scale),
    height: Math.round(petStageHeight(pack.aspect, pack.size) * scale),
  };
}

function layoutFor(pack: PetPack): PetWindowLayout {
  const stage = stageSizeFor(pack);
  return petWindowLayout({
    stageWidth: stage.width,
    stageHeight: stage.height,
    defaultWidth: Math.max(pack.size, stage.width),
    rect: settings.readerBubbleRect,
    bubbleHeight: PET_BUBBLE_HEIGHT,
    gap: PET_BUBBLE_GAP,
    inset: PET_BUBBLE_INSET,
    margin: PET_BUBBLE_MARGIN,
  });
}

/**
 * 按布局重排窗口。角色钉在 stageOrigin 上，所以窗口只往左/往下/往右/往上长，角色不会跟着跑。
 * 不能在这里用 getBounds() 反推角色位置：setBounds 之后读到的可能还是旧尺寸。
 */
function applyLayout(layout: PetWindowLayout): void {
  const win = petWindow;
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const anchor = stageOrigin;
  const next = anchor
    ? {
        x: Math.round(anchor.x - layout.stageLeft),
        y: Math.round(anchor.y - (layout.height - layout.stageBottom)),
        width: layout.width,
        height: layout.height,
      }
    : { x: bounds.x, y: bounds.y, width: layout.width, height: layout.height };
  if (!anchor) {
    stageOrigin = {
      x: next.x + layout.stageLeft,
      y: next.y + layout.height - layout.stageBottom,
    };
  }
  if (
    next.x === bounds.x &&
    next.y === bounds.y &&
    next.width === bounds.width &&
    next.height === bounds.height
  ) {
    return;
  }
  win.setBounds(next);
}

function sameStageCrop(
  left: DesktopPetStageCrop | null,
  right: DesktopPetStageCrop | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.x === right.x && left.y === right.y && left.w === right.w && left.h === right.h;
}

function sameBubbleRect(
  left: DesktopPetReaderBubbleRect | null,
  right: DesktopPetReaderBubbleRect | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.x === right.x && left.y === right.y && left.w === right.w && left.h === right.h;
}

function showPet(pack: PetPack): void {
  // 重载页面会丢掉气泡里的正文，阅读状态跟着作废，页码仍留在 reader-place.json。
  readerToken += 1;
  readerPhase = "closed";
  const manifest = toManifest(pack);
  currentManifest = manifest;
  currentPackRoot = pack.rootDir;
  mkdirSync(petRootDir, { recursive: true });
  const rawPlayerHtmlPath = join(petRootDir, "player.html");
  writeFileSync(
    rawPlayerHtmlPath,
    renderPetPlayerHtml(JSON.stringify(manifest), settings.bubbleTone),
  );
  const playerHtmlPath = canonical(rawPlayerHtmlPath);
  mediaPaths = new Set([playerHtmlPath, ...collectClipPaths(pack)]);
  currentPack = pack;
  const layout = layoutFor(pack);
  if (!petWindow || petWindow.isDestroyed()) {
    petWindow = new BrowserWindow({
      width: layout.width,
      height: layout.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      hasShadow: false,
      alwaysOnTop: true,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    petWindow.setAlwaysOnTop(true, "floating");
    petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    petWindow.webContents.setBackgroundThrottling(false);
    const area = screen.getPrimaryDisplay().workArea;
    const originX = area.x + area.width - layout.width - 24;
    const originY = area.y + area.height - layout.height - 24;
    petWindow.setPosition(originX, originY);
    stageOrigin = {
      x: originX + layout.stageLeft,
      y: originY + layout.height - layout.stageBottom,
    };
    petWindow.on("closed", () => {
      petWindow = null;
      currentPack = null;
      finishBubbleEdit(null);
    });
    petWindow.once("ready-to-show", () => petWindow?.showInactive());
  } else {
    applyLayout(layout);
  }
  petWindow.webContents.once("did-finish-load", () => sendMood());
  void petWindow.loadURL(buildLocalMediaPreviewUrl(playerHtmlPath));
  syncReaderHotkey();
}

export function noteDesktopPetMood(senderId: number, mood: unknown): void {
  moodBySender.set(senderId, normalizeDesktopPetMood(mood));
  publishMood();
}

export function clearDesktopPetMood(senderId: number): void {
  if (!moodBySender.delete(senderId)) return;
  publishMood();
}

function publishMood(): void {
  const merged = mergeDesktopPetMoods([...moodBySender.values()]);
  if (merged === activeMood) return;
  activeMood = merged;
  sendMood();
}

function sendMood(): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  const slots = currentManifest?.workStatus ?? [];
  const index = desktopPetMoodSlot(
    activeMood,
    slots.map((slot) => slot.length),
  );
  petWindow.webContents.send(PET_COMMAND, {
    type: "mood",
    clips: index === null ? [] : (slots[index] ?? []),
  });
}

function sendBubbleTone(): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  petWindow.webContents.send(PET_COMMAND, { type: "tone", tone: settings.bubbleTone });
}

function stopHoldWatch(): void {
  if (holdTimer) clearInterval(holdTimer);
  holdTimer = null;
  holdProbe?.stop();
  holdProbe = null;
  holdLatch = { latched: false, seenDown: false, since: 0 };
}

function unregisterReaderHotkey(): void {
  stopHoldWatch();
  if (!registeredHotkey) return;
  globalShortcut.unregister(registeredHotkey);
  registeredHotkey = "";
}

function syncReaderHotkey(): void {
  unregisterReaderHotkey();
  if (!settings.enabled || !settings.readerPath || !petWindow || petWindow.isDestroyed()) return;
  const hotkey = settings.readerHotkey || DESKTOP_PET_READER_HOTKEY_DEFAULT;
  const hold = settings.readerHotkeyMode === "hold";
  const probe = hold ? startReaderHoldProbe(hotkey) : null;
  if (hold && !probe) logger.warn("[desktop-pet] reader hold unavailable", hotkey);
  // 全局热键只有按下。点击切换再按一次关闭；按住则等采样到松开。
  const registered = globalShortcut.register(hotkey, () => {
    if (hold && probe?.alive()) pressReaderHold();
    else toggleReader();
  });
  if (!registered) {
    probe?.stop();
    logger.warn("[desktop-pet] reader hotkey unavailable", hotkey);
    return;
  }
  registeredHotkey = hotkey;
  if (!probe) return;
  holdProbe = probe;
  holdTimer = setInterval(() => {
    const next = pollHoldLatch(holdLatch, probe.down(), probe.alive(), Date.now());
    holdLatch = next.state;
    if (next.release) closeReader();
  }, 30);
}

function pressReaderHold(): void {
  holdLatch = noteHoldPress(Date.now());
  if (readerPhase !== "closed") return;
  readerPhase = "opening";
  const token = ++readerToken;
  void openReader(token, settings.readerPath);
}

function toggleReader(): void {
  if (readerPhase !== "closed") {
    closeReader();
    return;
  }
  readerPhase = "opening";
  const token = ++readerToken;
  void openReader(token, settings.readerPath);
}

function closeReader(): void {
  readerToken += 1;
  const hideBubble = readerPhase === "open";
  readerPhase = "closed";
  if (!hideBubble) return;
  saveReaderPlace();
  if (!petWindow || petWindow.isDestroyed()) return;
  petWindow.webContents.send(PET_COMMAND, { type: "read-hide" });
}

async function openReader(token: number, path: string): Promise<void> {
  const meta = await ensureReaderFile(path);
  if (token !== readerToken || readerPhase !== "opening") return;
  if (!meta) {
    readerPhase = "closed";
    return;
  }
  const place = loadReaderPlace(path);
  const window = await loadReaderWindow(meta, place.offset);
  if (token !== readerToken || readerPhase !== "opening" || !window) {
    if (readerPhase === "opening") readerPhase = "closed";
    return;
  }
  readerPhase = "open";
  readerOffset = window.offset;
  readerSpan = window.bytes;
  readerTop = window.offset === place.offset ? place.top : 0;
  saveReaderPlace();
  sendReaderPage(window.text, "keep", readerTop);
}

async function turnReaderPage(dir: number): Promise<void> {
  if (readerPhase !== "open" || !settings.readerPath) return;
  const meta = await ensureReaderFile(settings.readerPath);
  if (readerPhase !== "open" || !meta) return;
  const window =
    dir < 0
      ? await loadReaderWindowBefore(meta, readerOffset)
      : await loadReaderWindow(meta, readerOffset + readerSpan);
  if (!window || window.offset === readerOffset) return;
  readerOffset = window.offset;
  readerSpan = window.bytes;
  readerTop = 0;
  saveReaderPlace();
  sendReaderPage(window.text, dir < 0 ? "end" : "start", 0);
}

function sendReaderPage(text: string, edge: "start" | "end" | "keep", top: number): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  petWindow.webContents.send(PET_COMMAND, { type: "read", text, edge, top });
}

async function ensureReaderFile(path: string): Promise<NonNullable<typeof readerFile> | null> {
  if (!path) return null;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0 || info.size > PET_READER_MAX_BYTES) {
      logger.warn("[desktop-pet] reader file unavailable");
      return null;
    }
    if (readerFile?.path === path && readerFile.mtimeMs === info.mtimeMs) {
      readerFile.size = info.size;
      return readerFile;
    }
    const sample = await readFileRange(path, 0, Math.min(info.size, PET_READER_CHUNK_BYTES));
    readerFile = {
      path,
      mtimeMs: info.mtimeMs,
      size: info.size,
      encoding: detectPetReaderEncoding(sample),
    };
    return readerFile;
  } catch {
    logger.warn("[desktop-pet] reader file unavailable");
    return null;
  }
}

async function loadReaderWindow(
  meta: NonNullable<typeof readerFile>,
  offset: number,
): Promise<{ text: string; offset: number; bytes: number } | null> {
  let start = Math.max(0, Math.min(offset, meta.size));
  if (start === 0 && meta.encoding === "utf-8" && meta.size >= 3) {
    const bom = await readFileRange(meta.path, 0, 3);
    if (bom[0] === 0xef && bom[1] === 0xbb && bom[2] === 0xbf) start = 3;
  }
  if (start >= meta.size) return null;
  const bytes = await readFileRange(
    meta.path,
    start,
    Math.min(PET_READER_PAGE_CHARS * 4, meta.size - start),
  );
  const window = readPetReaderChars(bytes, meta.encoding, PET_READER_PAGE_CHARS);
  if (!window.byteLength) return null;
  return { text: window.text, offset: start, bytes: window.byteLength };
}

async function loadReaderWindowBefore(
  meta: NonNullable<typeof readerFile>,
  offset: number,
): Promise<{ text: string; offset: number; bytes: number } | null> {
  if (offset <= 0) return null;
  const budget = PET_READER_PAGE_CHARS * 4;
  const start = Math.max(0, offset - budget);
  const bytes = await readFileRange(meta.path, start, offset - start);
  const tail = readPetReaderTail(bytes, meta.encoding, PET_READER_PAGE_CHARS);
  const nextOffset = start + tail.start;
  if (!tail.text || nextOffset >= offset) return null;
  const window = readPetReaderChars(
    bytes.subarray(tail.start),
    meta.encoding,
    PET_READER_PAGE_CHARS,
  );
  return { text: tail.text, offset: nextOffset, bytes: window.byteLength };
}

async function scanReader(
  meta: NonNullable<typeof readerFile>,
  query: string,
  from: number,
  until: number,
): Promise<number | null> {
  const overlap = Math.min(PET_READER_CHUNK_BYTES, Math.max(query.length * 4, 64));
  let position = Math.max(0, from);
  let pending = Buffer.alloc(0);
  while (position < until) {
    const chunk = await readFileRange(
      meta.path,
      position,
      Math.min(PET_READER_CHUNK_BYTES, until - position),
    );
    if (!chunk.length && !pending.length) break;
    const view = Buffer.concat([pending, chunk]);
    const found = findPetReaderQuery(view, meta.encoding, query);
    const viewStart = position - pending.length;
    if (found >= 0 && viewStart + found >= from && viewStart + found < until) {
      return viewStart + found;
    }
    if (!chunk.length) break;
    pending = view.subarray(Math.max(0, view.length - overlap));
    position += chunk.length;
  }
  return null;
}

async function readFileRange(path: string, offset: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function rememberReaderTop(top: unknown): void {
  if (typeof top !== "number" || !Number.isFinite(top)) return;
  readerTop = Math.max(0, Math.min(1_000_000, top));
}

function readerPlaceFile(): string {
  return join(petRootDir, "reader-place.json");
}

function loadReaderPlace(path: string): { offset: number; top: number } {
  try {
    const parsed = JSON.parse(readFileSync(readerPlaceFile(), "utf8")) as {
      path?: unknown;
      offset?: unknown;
      top?: unknown;
    };
    if (parsed.path !== path) return { offset: 0, top: 0 };
    const offset =
      typeof parsed.offset === "number" && parsed.offset >= 0 ? Math.floor(parsed.offset) : 0;
    const top = typeof parsed.top === "number" && parsed.top >= 0 ? parsed.top : 0;
    return { offset, top };
  } catch {
    return { offset: 0, top: 0 };
  }
}

function saveReaderPlace(): void {
  if (!settings.readerPath || !petRootDir) return;
  try {
    mkdirSync(petRootDir, { recursive: true });
    writeFileSync(
      readerPlaceFile(),
      JSON.stringify({ path: settings.readerPath, offset: readerOffset, top: readerTop }),
    );
  } catch {
    // 记不住位置就从页首继续，不影响关闭。
  }
}

function petSettingsFile(): string {
  return join(petRootDir, "settings.json");
}

function petBoxFile(): string {
  return join(petRootDir, "box.json");
}

/**
 * 每个包只量一次角色像素框。窗口尺寸必须第一次就对，所以把结果缓存到磁盘，
 * 下次启动不用等渲染端再报一遍。
 */
function readPetBox(rootDir: string): { width: number; height: number } | null {
  if (!petRootDir) return null;
  try {
    const parsed = JSON.parse(readFileSync(petBoxFile(), "utf8")) as Record<
      string,
      { width?: unknown; height?: unknown }
    >;
    const entry = parsed[canonical(rootDir)];
    const width = typeof entry?.width === "number" ? entry.width : 0;
    const height = typeof entry?.height === "number" ? entry.height : 0;
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

function writePetBox(rootDir: string, box: { width: number; height: number }): void {
  if (!petRootDir) return;
  let all: Record<string, { width: number; height: number }> = {};
  try {
    all = JSON.parse(readFileSync(petBoxFile(), "utf8")) as typeof all;
  } catch {
    all = {};
  }
  all[canonical(rootDir)] = box;
  try {
    mkdirSync(petRootDir, { recursive: true });
    writeFileSync(petBoxFile(), JSON.stringify(all));
  } catch {
    logger.warn("[desktop-pet] box cache unavailable");
  }
}

function isDefaultPetSettings(value: PetSettings): boolean {
  return (
    !value.enabled &&
    !value.packDir &&
    !value.packUrl &&
    value.bubbleTone === "dark" &&
    value.displayScale === DESKTOP_PET_DISPLAY_SCALE_DEFAULT &&
    value.cropCharacter &&
    value.readerBubbleRect === null &&
    value.stageCrop === null &&
    !value.readerPath &&
    value.readerHotkey === DESKTOP_PET_READER_HOTKEY_DEFAULT &&
    value.readerHotkeyMode === "toggle"
  );
}

function readPetSettingsFile(): PetSettings | null {
  if (!petRootDir) return null;
  try {
    const parsed = JSON.parse(readFileSync(petSettingsFile(), "utf8")) as {
      enabled?: unknown;
      packDir?: unknown;
      packUrl?: unknown;
      bubbleTone?: unknown;
      displayScale?: unknown;
      cropCharacter?: unknown;
      readerBubbleRect?: unknown;
      stageCrop?: unknown;
      readerPath?: unknown;
      readerHotkey?: unknown;
      readerHotkeyMode?: unknown;
    };
    // 旧文件把缺省键写成 F1，而且没有方式字段。升级后改成 F9，避免设置页还停在旧缺省。
    const legacyDefault = parsed.readerHotkeyMode == null && parsed.readerHotkey === "F1";
    const value: PetSettings = {
      enabled: parsed.enabled === true,
      packDir: typeof parsed.packDir === "string" ? parsed.packDir : "",
      packUrl: typeof parsed.packUrl === "string" ? parsed.packUrl : "",
      bubbleTone: parsed.bubbleTone === "light" ? "light" : "dark",
      displayScale: normalizeDesktopPetDisplayScale(parsed.displayScale),
      cropCharacter: normalizeDesktopPetCropCharacter(parsed.cropCharacter),
      readerBubbleRect: normalizeDesktopPetReaderBubbleRect(parsed.readerBubbleRect),
      stageCrop: normalizeDesktopPetStageCrop(parsed.stageCrop),
      readerPath: typeof parsed.readerPath === "string" ? parsed.readerPath : "",
      readerHotkey: normalizeDesktopPetReaderHotkey(
        legacyDefault ? undefined : parsed.readerHotkey,
      ),
      readerHotkeyMode: normalizeDesktopPetReaderHotkeyMode(parsed.readerHotkeyMode),
    };
    if (legacyDefault) writePetSettingsFile(value);
    return value;
  } catch {
    return null;
  }
}

function writePetSettingsFile(value: PetSettings): void {
  if (!petRootDir) return;
  try {
    mkdirSync(petRootDir, { recursive: true });
    writeFileSync(petSettingsFile(), JSON.stringify(value));
  } catch {
    logger.warn("[desktop-pet] settings file unavailable");
  }
}

function destroyPetWindow(): void {
  onActivate = null;
  currentManifest = null;
  currentPack = null;
  stageOrigin = null;
  // 编辑态挂在设置页的 IPC 调用上，窗口没了必须把它解开，否则设置页会一直转。
  const editing = bubbleEdit;
  bubbleEdit = null;
  editing?.resolve(null);
  closeReader();
  if (dismissTimer) clearTimeout(dismissTimer);
  dismissTimer = null;
  mediaPaths = new Set();
  unregisterReaderHotkey();
  if (petWindow && !petWindow.isDestroyed()) petWindow.destroy();
  petWindow = null;
}

function handlePetEvent(payload: unknown): void {
  if (!payload || typeof payload !== "object" || !petWindow) return;
  const event = payload as {
    type?: string;
    dx?: number;
    dy?: number;
    dir?: number;
    top?: number;
    width?: number;
    height?: number;
    rect?: unknown;
    stageCrop?: unknown;
  };
  if (event.type === "read-hide") {
    rememberReaderTop(event.top);
    closeReader();
    return;
  }
  if (event.type === "read-scroll") {
    rememberReaderTop(event.top);
    saveReaderPlace();
    return;
  }
  if (event.type === "read-page") {
    void turnReaderPage(event.dir === -1 ? -1 : 1);
    return;
  }
  if (event.type === "activate") {
    const activate = onActivate;
    onActivate = null;
    activate?.();
    return;
  }
  if (event.type === "menu") {
    popupPetMenu();
    return;
  }
  if (event.type === "box") {
    rememberPetBox(event.width, event.height);
    return;
  }
  if (event.type === "bubble-edit-done") {
    finishBubbleEdit(
      normalizeDesktopPetReaderBubbleRect(event.rect),
      normalizeDesktopPetStageCrop(event.stageCrop),
    );
    return;
  }
  if (event.type === "bubble-edit-cancel") {
    finishBubbleEdit(null);
    return;
  }
  if (event.type !== "move") return;
  if (typeof event.dx !== "number" || typeof event.dy !== "number") return;
  if (!Number.isFinite(event.dx) || !Number.isFinite(event.dy)) return;
  const dx = Math.max(-200, Math.min(200, event.dx));
  const dy = Math.max(-200, Math.min(200, event.dy));
  const [x = 0, y = 0] = petWindow.getPosition();
  const nextX = Math.round(x + dx);
  const nextY = Math.round(y + dy);
  petWindow.setPosition(nextX, nextY);
  if (stageOrigin) stageOrigin = { x: stageOrigin.x + (nextX - x), y: stageOrigin.y + (nextY - y) };
}

function hasOwn(patch: Partial<AppSettings>, key: keyof AppSettings): boolean {
  return Object.prototype.hasOwnProperty.call(patch, key);
}

/** 渲染端量到角色像素框后报上来：写缓存，并按新的舞台尺寸重排窗口。 */
function rememberPetBox(width: unknown, height: unknown): void {
  if (!petWindow || petWindow.isDestroyed() || !settings.cropCharacter || bubbleEdit) return;
  const boxWidth = typeof width === "number" && Number.isFinite(width) ? Math.round(width) : 0;
  const boxHeight = typeof height === "number" && Number.isFinite(height) ? Math.round(height) : 0;
  if (boxWidth <= 0 || boxHeight <= 0 || boxHeight > 4000) return;
  if (currentPackRoot) {
    const cached = readPetBox(currentPackRoot);
    if (!cached || cached.width !== boxWidth || cached.height !== boxHeight) {
      writePetBox(currentPackRoot, { width: boxWidth, height: boxHeight });
    }
  }
  const pack = currentPack;
  if (!pack) return;
  // 角色本身钉在屏幕上：窗口按气泡范围涨缩，只有多出来的透明区域变。
  applyLayout(
    petWindowLayout({
      stageWidth: boxWidth,
      stageHeight: boxHeight,
      defaultWidth: Math.max(pack.size, boxWidth),
      rect: settings.readerBubbleRect,
      bubbleHeight: PET_BUBBLE_HEIGHT,
      gap: PET_BUBBLE_GAP,
      inset: PET_BUBBLE_INSET,
      margin: PET_BUBBLE_MARGIN,
    }),
  );
}

function readPetString(
  patch: Partial<AppSettings>,
  key: "desktopPetPackDir" | "desktopPetPackUrl" | "desktopPetReaderPath",
  full: boolean,
  previous: string,
): string {
  if (!hasOwn(patch, key)) return full ? "" : previous;
  const value = patch[key];
  return typeof value === "string" ? value.trim() : "";
}

function popupPetMenu(): void {
  if (!petWindow || petWindow.isDestroyed() || !currentManifest) return;
  const template = toMenuTemplate(petContextMenu(currentManifest));
  if (!template.length) return;
  Menu.buildFromTemplate(template).popup({ window: petWindow });
}

function toMenuTemplate(entries: readonly PetMenuEntry[]): MenuItemConstructorOptions[] {
  return entries.map((entry) => {
    if (entry.submenu) return { label: entry.label, submenu: toMenuTemplate(entry.submenu) };
    return {
      label: entry.label,
      click: () => {
        if (!entry.clip || !petWindow || petWindow.isDestroyed()) return;
        petWindow.webContents.send(PET_COMMAND, {
          type: "play",
          clip: entry.clip,
          mode: entry.mode,
        });
      },
    };
  });
}

function toManifest(pack: PetPack): PetManifest {
  const clip = (item: PetClip) => ({
    name: item.name,
    url: buildLocalMediaPreviewUrl(canonical(item.filePath)),
  });
  const stage = stageSizeFor(pack);
  return {
    stage: { width: pack.size, height: petStageHeight(pack.aspect, pack.size) },
    displayScale: settings.displayScale,
    crop: settings.cropCharacter,
    geometry: {
      defaultWidth: Math.max(pack.size, stage.width),
      bubbleHeight: PET_BUBBLE_HEIGHT,
      gap: PET_BUBBLE_GAP,
      inset: PET_BUBBLE_INSET,
      margin: PET_BUBBLE_MARGIN,
      rect: settings.readerBubbleRect,
      stageCrop: settings.stageCrop,
    },
    size: pack.size,
    fixed: pack.fixed,
    weights: pack.weights,
    idle: pack.idle.map(clip),
    turn: pack.turn.map(clip),
    drag: pack.drag.map(clip),
    clicks: pack.clicks.map(clip),
    moves: pack.moves.map(clip),
    categories: pack.categories.map((category) => ({
      id: category.id,
      weight: category.weight,
      noMirror: category.noMirror,
      actions: category.actions.map(clip),
    })),
    workStatus: pack.workStatus.map((slot) => slot.map(clip)),
  };
}

function collectClipPaths(pack: PetPack): string[] {
  const clips: PetClip[] = [
    ...pack.idle,
    ...pack.turn,
    ...pack.drag,
    ...pack.clicks,
    ...pack.moves,
    ...pack.categories.flatMap((category) => category.actions),
    ...pack.workStatus.flat(),
  ];
  return clips.map((item) => canonical(item.filePath));
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
