import { petBubbleTone, petBubbleTop, type PetBubbleTone } from "./petBubble.js";
import { PET_PLAYER_CSS } from "./playerCss.js";
import { renderPetPlayerBubbleScript } from "./playerScriptBubble.js";
import { renderPetPlayerMotionScript } from "./playerScriptMotion.js";

export { petBubbleTone, petBubbleTop };
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
<div id="frame"><div id="stage"><video id="pet" muted playsinline></video></div></div>
<script id="pet-manifest" type="application/json">${safeJson}</script>
<script>${renderPetPlayerMotionScript()}${renderPetPlayerBubbleScript()}</script>
</body>
</html>`;
}
