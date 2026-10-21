import {
  PET_BUBBLE_HEIGHT,
  PET_BUBBLE_LINE_HEIGHT,
  PET_BUBBLE_PADDING_Y,
  PET_BUBBLE_SPACE,
} from "./petBubble.js";

/**
 * 宠物透明窗口的页面样式。舞台是裁到角色像素框的矩形，视频按这个框做偏移裁剪。
 * 气泡正文区高度是行高的整数倍，滚动按整行走，不会露半行。
 */
export const PET_PLAYER_CSS = `
  html, body { margin: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; }
  #bubble {
    position: absolute; left: 8px; right: 8px; top: ${PET_BUBBLE_SPACE}px; z-index: 2;
    box-sizing: border-box; max-height: ${PET_BUBBLE_HEIGHT}px;
    overflow: hidden; padding: ${PET_BUBBLE_PADDING_Y}px 8px; border-radius: 10px;
    background: rgba(20, 20, 20, 0.88); color: white;
    font: 12px/${PET_BUBBLE_LINE_HEIGHT}px sans-serif;
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
  #stage { position: absolute; bottom: 0; left: 50%; transform: translateX(-50%); overflow: hidden; }
  #frame { position: absolute; left: 0; right: 0; bottom: 0; top: ${PET_BUBBLE_SPACE}px; }
  video { display: block; position: absolute; background: transparent; transform-origin: 0 0; }
  video.squish { animation: squish 180ms ease; }
  @keyframes squish { 40% { transform: scale(1.06, 0.92); } }
`;
