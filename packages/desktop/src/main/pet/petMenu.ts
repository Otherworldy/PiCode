export interface PetMenuClip {
  name: string;
  url: string;
}

export interface PetMenuSource {
  idle: PetMenuClip[];
  turn: PetMenuClip[];
  moves: PetMenuClip[];
  clicks: PetMenuClip[];
  drag: PetMenuClip[];
  categories: Array<{ id: string; actions: PetMenuClip[] }>;
}

export interface PetMenuEntry {
  label: string;
  mode: "turn" | "picked";
  clip?: PetMenuClip;
  submenu?: PetMenuEntry[];
}

/** 右键菜单只列出已经加载的片段。空分组省略，点一项只播一次。 */
export function petContextMenu(source: PetMenuSource): PetMenuEntry[] {
  const groups: PetMenuEntry[] = [];
  addGroup(groups, "待机", "picked", source.idle);
  addGroup(groups, "转向", "turn", source.turn);
  addGroup(groups, "移动", "picked", source.moves);
  addGroup(groups, "点击", "picked", source.clicks);
  addGroup(groups, "拖拽", "picked", source.drag);
  for (const category of source.categories) {
    addGroup(groups, category.id.trim() || "动作", "picked", category.actions);
  }
  return groups;
}

function addGroup(
  groups: PetMenuEntry[],
  label: string,
  mode: PetMenuEntry["mode"],
  clips: readonly PetMenuClip[],
): void {
  const submenu = clips.flatMap((clip) => {
    const name = clip.name.trim();
    const url = clip.url.trim();
    if (!name || !url) return [];
    return [{ label: name, mode, clip: { name, url } }];
  });
  if (!submenu.length) return;
  groups.push({ label, mode, submenu });
}
