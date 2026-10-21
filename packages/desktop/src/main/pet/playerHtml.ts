import { petBubbleTone, type PetBubbleTone } from "./petBubble.js";
import { PET_PLAYER_CSS } from "./playerCss.js";
import { renderPetPlayerBubbleScript } from "./playerScriptBubble.js";
import { renderPetPlayerMotionScript } from "./playerScriptMotion.js";

export { petBubbleTone };
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
<div id="stage"><video id="pet" muted playsinline></video></div>
<div id="guide-stage"></div>
<div id="guide-window"></div>
<div id="guide-hint"></div>
<div id="edit-bar">
  <span id="edit-bar-text">拖动气泡移动，拖动方块缩放</span>
  <button id="edit-save" data-primary="true">保存</button>
  <button id="edit-cancel">取消</button>
</div>
<script id="pet-manifest" type="application/json">${safeJson}</script>
<script>${renderPetPlayerMotionScript()}${renderPetPlayerBubbleScript()}</script>
</body>
</html>`;
}
