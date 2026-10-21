export interface PetWindowLayout {
  width: number;
  height: number;
  /** 角色舞台左边相对窗口左边的位置。 */
  stageLeft: number;
  /** 角色舞台底边相对窗口底边的位置。 */
  stageBottom: number;
  /** 缺省气泡（消息提醒用）在窗口里的位置。 */
  auto: { left: number; bottom: number; width: number; height: number };
  /** 摸鱼气泡在窗口里的位置：有自定义就用自定义，否则跟缺省气泡一致。 */
  reader: { left: number; bottom: number; width: number; height: number };
}

/**
 * 宠物窗口的布局：把角色舞台和气泡摆进同一个透明窗口。
 *
 * 坐标系原点在角色脚底中心，宽度向右、高度向上，单位都是页面像素。
 * 气泡跟着角色走，所以换宠物、换缩放后摆放关系不变。
 *
 * 这个函数会被 toString() 内联到播放页，所以不能引用模块常量，参数都要显式传进来。
 */
export function petWindowLayout(input: {
  stageWidth: number;
  stageHeight: number;
  /** 缺省气泡的宽度基准：通常取宠物包的 size，保证正文有足够书写宽度。 */
  defaultWidth: number;
  /** 用户自定义的气泡矩形。给 null 时从头顶上方自动摆放。 */
  rect: { x: number; y: number; w: number; h: number } | null;
  /** 缺省气泡高度（含内边距）。 */
  bubbleHeight: number;
  /** 缺省摆放时气泡底边离角色顶边的间隙。 */
  gap: number;
  /** 缺省摆放时气泡左右留白。 */
  inset: number;
  /** 窗口四边的透明边。 */
  margin: number;
}): PetWindowLayout {
  const stageWidth = Math.max(1, input.stageWidth);
  const stageHeight = Math.max(1, input.stageHeight);
  const defaultWidth = Math.max(1, input.defaultWidth);
  const autoWidth = Math.max(120, defaultWidth - input.inset * 2);
  const auto = {
    x: -defaultWidth / 2 + input.inset,
    y: stageHeight + input.gap,
    w: autoWidth,
    h: Math.max(1, input.bubbleHeight),
  };
  const reader = input.rect ? { ...input.rect } : auto;
  const boxes = [{ x: -stageWidth / 2, y: 0, w: stageWidth, h: stageHeight }, auto, reader];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    maxX = Math.max(maxX, box.x + box.w);
    minY = Math.min(minY, box.y);
    maxY = Math.max(maxY, box.y + box.h);
  }
  const margin = Math.max(0, input.margin);
  minX -= margin;
  maxX += margin;
  minY -= margin;
  maxY += margin;
  return {
    width: Math.round(maxX - minX),
    height: Math.round(maxY - minY),
    stageLeft: Math.round(-stageWidth / 2 - minX),
    stageBottom: Math.round(-minY),
    auto: {
      left: Math.round(auto.x - minX),
      bottom: Math.round(auto.y - minY),
      width: Math.round(auto.w),
      height: Math.round(auto.h),
    },
    reader: {
      left: Math.round(reader.x - minX),
      bottom: Math.round(reader.y - minY),
      width: Math.round(reader.w),
      height: Math.round(reader.h),
    },
  };
}

/** 气泡高度按整行吸附，正文区不会露出半行。 */
export function snapBubbleHeight(
  height: number,
  lineHeight: number,
  paddingY: number,
  minLines: number,
): number {
  if (!Number.isFinite(height) || lineHeight <= 0) return paddingY * 2 + lineHeight * minLines;
  const lines = Math.max(minLines, Math.round((height - paddingY * 2) / lineHeight));
  return paddingY * 2 + lines * lineHeight;
}
