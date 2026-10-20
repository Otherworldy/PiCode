import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// 抽选规则对齐 dsh-pet（Copyright (c) 2026 PC2005-cloud, MIT）。
// 这里只消费它的 animations 配置，不带走余额、碎碎念或抛掷物理。

export interface PetClip {
  name: string;
  filePath: string;
}

export interface PetCategory {
  id: string;
  weight: number;
  noMirror: boolean;
  actions: PetClip[];
}

export interface PetPack {
  rootDir: string;
  /** 配置里第一只宠物的名字。没有就空着，调用方自己决定怎么显示。 */
  name: string;
  size: number;
  fixed: boolean;
  weights: { idle: number; turn: number; move: number };
  idle: PetClip[];
  turn: PetClip[];
  drag: PetClip[];
  clicks: PetClip[];
  moves: PetClip[];
  categories: PetCategory[];
  /** 工作状态档位，下标与 dsh 一致。某一档素材缺失时留空，避免后面的档位前移。 */
  workStatus: PetClip[][];
}

export function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      index += 1;
      while (index + 1 < text.length && text[index + 1] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      continue;
    }
    out += char;
  }
  return out;
}

export function findPetPackDir(startDir: string): string | null {
  if (configFileIn(startDir)) return startDir;
  let entries: string[] = [];
  try {
    entries = readdirSync(startDir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const child = join(startDir, entry);
    try {
      if (statSync(child).isDirectory() && configFileIn(child)) return child;
    } catch {
      // 跳过读不到的子目录。
    }
  }
  return null;
}

export function loadPetPack(startDir: string): PetPack | null {
  const rootDir = findPetPackDir(startDir);
  if (!rootDir) return null;
  const configPath = configFileIn(rootDir);
  if (!configPath) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const animations = record.animations;
  if (!animations || typeof animations !== "object") return null;
  const clips = clipResolver(configPath);
  const anim = animations as Record<string, unknown>;
  const pet = Array.isArray(record.pets) ? record.pets[0] : undefined;
  const petRecord = pet && typeof pet === "object" ? (pet as Record<string, unknown>) : {};
  const weights = record.animationWeights;
  const weightRecord =
    weights && typeof weights === "object" ? (weights as Record<string, unknown>) : {};
  const events =
    anim.events && typeof anim.events === "object" ? (anim.events as Record<string, unknown>) : {};
  const pack: PetPack = {
    rootDir,
    name: typeof petRecord.name === "string" ? petRecord.name.trim() : "",
    size: clampSize(petRecord.size),
    fixed: petRecord.fixedEnabled === true,
    weights: {
      idle: numberOr(weightRecord.idle, 10),
      turn: numberOr(weightRecord.turn, 5),
      move: numberOr(weightRecord.move, 5),
    },
    idle: resolveNames(anim.idle, clips),
    turn: resolveNames(anim.turn, clips),
    drag: resolveNames(anim.drag, clips),
    clicks: resolveNames(anim.clicks, clips),
    moves: resolveMoveNames(anim.moves, clips),
    categories: resolveCategories(anim.categories, clips),
    workStatus: resolveWorkStatus(events.workStatus, clips),
  };
  if (!pack.idle.length && !pack.categories.some((category) => category.actions.length)) {
    return null;
  }
  return pack;
}

export type PetRollKind = "idle" | "turn" | "move" | "action";

export function rollKind(roll: number, weights: PetPack["weights"], fixed: boolean): PetRollKind {
  const turn = fixed ? 0 : weights.turn;
  const move = fixed ? 0 : weights.move;
  if (roll < weights.idle / 100) return "idle";
  if (roll < (weights.idle + turn) / 100) return "turn";
  if (roll < (weights.idle + turn + move) / 100) return "move";
  return "action";
}

export function pickClip(pool: readonly PetClip[], exclude?: string): PetClip | null {
  if (!pool.length) return null;
  const filtered = exclude ? pool.filter((clip) => clip.name !== exclude) : pool;
  const source = filtered.length ? filtered : pool;
  return source[Math.floor(Math.random() * source.length)] ?? null;
}

export function pickCategoryClip(
  categories: readonly PetCategory[],
  facing: "left" | "right",
  exclude?: string,
): PetClip | null {
  const filled = categories.filter((category) => category.actions.length);
  const mirrored = filled.filter((category) => !(category.noMirror && facing === "right"));
  const eligible = mirrored.length ? mirrored : filled;
  if (!eligible.length) return null;
  const total = eligible.reduce((sum, category) => sum + category.weight, 0) || 1;
  let cursor = Math.random() * total;
  for (const category of eligible) {
    cursor -= category.weight;
    if (cursor <= 0) return pickClip(category.actions, exclude);
  }
  return pickClip(eligible[eligible.length - 1]?.actions ?? [], exclude);
}

function configFileIn(dir: string): string | null {
  const preferred = ["config.jsonc", "config.json"];
  for (const name of preferred) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const match = entries.find((entry) => /-config\.jsonc?$/i.test(entry));
  return match ? join(dir, match) : null;
}

function clipResolver(configPath: string): (name: string) => PetClip | null {
  const dir = dirname(configPath);
  const stem = basename(configPath).replace(/-config\.jsonc?$/i, "");
  const parents = [dir, dirname(dir)];
  const candidates = [
    join(dir, "webm"),
    join(dir, "main-animation", "webm"),
    join(dir, `${stem}-animation`),
    join(dir, `${stem}-animation`, "webm"),
    join(dir, "animation", "webm"),
    ...parents.flatMap((parent) => [join(parent, "webm"), join(parent, "assets", "webm")]),
  ];
  const dirs = candidates.filter((path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  });
  return (name) => {
    for (const folder of dirs) {
      const filePath = resolve(folder, `${name}.webm`);
      if (existsSync(filePath)) return { name, filePath };
    }
    return null;
  };
}

function resolveNames(value: unknown, resolveClip: (name: string) => PetClip | null): PetClip[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "string" || !item.trim()) return [];
    const clip = resolveClip(item.trim());
    return clip ? [clip] : [];
  });
}

function resolveMoveNames(
  value: unknown,
  resolveClip: (name: string) => PetClip | null,
): PetClip[] {
  if (!value || typeof value !== "object") return [];
  const actions = (value as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return [];
  return actions.flatMap((item) => {
    const name =
      typeof item === "string"
        ? item
        : item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string"
          ? (item as { name: string }).name
          : "";
    const clip = name.trim() ? resolveClip(name.trim()) : null;
    return clip ? [clip] : [];
  });
}

function resolveCategories(
  value: unknown,
  resolveClip: (name: string) => PetClip | null,
): PetCategory[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const actions = resolveNames(record.actions, resolveClip);
    if (!actions.length) return [];
    return [
      {
        id: typeof record.id === "string" && record.id.trim() ? record.id : "action",
        weight: numberOr(record.weight, 1),
        noMirror: record.noMirror === true,
        actions,
      },
    ];
  });
}

function resolveWorkStatus(
  value: unknown,
  resolveClip: (name: string) => PetClip | null,
): PetClip[][] {
  if (!Array.isArray(value)) return [];
  return value.map((slot) => {
    if (typeof slot === "string") {
      const clip = resolveClip(slot);
      return clip ? [clip] : [];
    }
    return resolveNames(slot, resolveClip);
  });
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampSize(value: unknown): number {
  const size = typeof value === "number" && Number.isFinite(value) ? value : 240;
  return Math.min(320, Math.max(160, Math.round(size)));
}
