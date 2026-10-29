import { PET_BUBBLE_LINE_HEIGHT, PET_BUBBLE_PADDING_Y } from "./petBubble.js";

/**
 * 宠物透明窗口的页面样式。角色舞台和气泡都按窗口布局定位，位置由 JS 写进 style。
 * 气泡正文区高度在编辑保存时按行高吸附，滚动按整行走，不会露半行。
 */
export const PET_PLAYER_CSS = `
  html, body { margin: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; }
  #bubble {
    position: absolute; z-index: 2;
    box-sizing: border-box; overflow: hidden; padding: ${PET_BUBBLE_PADDING_Y}px 8px;
    border-radius: 10px;
    background: rgba(20, 20, 20, 0.88); color: white;
    font: 12px/${PET_BUBBLE_LINE_HEIGHT}px sans-serif;
    /* 摸鱼正文自己的排版，由页面按设置写到这三个变量上。 */
    --pet-reader-font: 12px;
    --pet-reader-line: ${PET_BUBBLE_LINE_HEIGHT}px;
    --pet-reader-gap: 0px;
    cursor: pointer; display: none;
  }
  #bubble[data-tone="light"] {
    background: rgba(255, 255, 255, 0.96); color: #1a1a1a;
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.18);
  }
  #bubble[data-mode="read"] {
    overflow-y: auto; white-space: pre-wrap; word-break: break-word; scrollbar-width: none;
    font-size: var(--pet-reader-font); line-height: var(--pet-reader-line);
    letter-spacing: var(--pet-reader-gap);
  }
  #bubble[data-mode="read"]::-webkit-scrollbar { width: 0; height: 0; }
  #stage { position: absolute; overflow: hidden; }
  video { display: block; position: absolute; background: transparent; transform-origin: 0 0; }
  video.squish { animation: squish 180ms ease; }
  @keyframes squish { 40% { transform: scale(1.06, 0.92); } }

  /* 编辑态：把角色和气泡的关系画出来，窗口本身是透明的。 */
  #crop-box {
    position: absolute; z-index: 1; display: none;
    border: 1px dashed rgba(255, 255, 255, 0.85); border-radius: 6px;
    /* 框外压暗，方便看清裁掉的是哪一块。 */
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.45);
    cursor: move;
  }
  #guide-window {
    position: absolute; z-index: 1; display: none;
    border: 1px dashed rgba(96, 165, 250, 0.9); border-radius: 4px; pointer-events: none;
  }
  #guide-hint {
    position: absolute; z-index: 1; display: none;
    font: 11px/${PET_BUBBLE_LINE_HEIGHT}px sans-serif; color: #dbeafe;
    background: rgba(30, 41, 59, 0.92); border-radius: 4px; padding: 2px 6px;
    pointer-events: none; white-space: nowrap;
  }
  body.editing #bubble { cursor: move; }
  body.editing #bubble::after {
    content: ""; position: absolute; inset: 0; border: 1px solid rgba(96, 165, 250, 0.9);
    border-radius: 10px; pointer-events: none;
  }
  .pet-handle {
    position: absolute; z-index: 3; width: 10px; height: 10px; margin: -5px 0 0 -5px;
    border: 1px solid rgba(255, 255, 255, 0.9); background: rgba(96, 165, 250, 0.95);
    border-radius: 2px; box-sizing: border-box;
  }
  .pet-handle[data-dir="n"], .pet-handle[data-dir="s"] { cursor: ns-resize; }
  .pet-handle[data-dir="e"], .pet-handle[data-dir="w"] { cursor: ew-resize; }
  .pet-handle[data-dir="ne"], .pet-handle[data-dir="sw"] { cursor: nesw-resize; }
  .pet-handle[data-dir="nw"], .pet-handle[data-dir="se"] { cursor: nwse-resize; }
  .pet-handle[data-kind="crop"] {
    border-color: rgba(15, 23, 42, 0.9); background: rgba(248, 250, 252, 0.95);
  }
  #edit-bar {
    position: absolute; z-index: 4; display: none; gap: 8px; align-items: center;
    padding: 6px 10px; border-radius: 8px; background: rgba(15, 23, 42, 0.94);
    color: #e2e8f0; font: 12px/${PET_BUBBLE_LINE_HEIGHT}px sans-serif; white-space: nowrap;
  }
  #edit-bar button {
    font: 12px/${PET_BUBBLE_LINE_HEIGHT}px sans-serif; padding: 4px 10px; border-radius: 6px;
    border: 1px solid rgba(148, 163, 184, 0.55); background: transparent; color: inherit;
    cursor: pointer;
  }
  #edit-bar button[data-primary="true"] { background: #2563eb; border-color: #2563eb; color: white; }
`;
