// 回放导出桶。
//
// 下游浏览器端回放页面要在**静态数据**上装配会话详情页：只读 SessionPane、
// 以及它需要的 Provider 与数据层缝。这些组件本来只在包内被 App 使用、不在 index 导出；
// 这里集中放出一份，不改任何组件行为。
//
// 纪律：只 re-export，不定义任何东西。
export { SessionPane, type SessionPaneProps } from "./v4/SessionPane.js";
export {
  V4ConversationContext,
  type V4ConversationContextValue,
} from "./v4/V4ConversationContext.js";
export { SessionDataLayer, type SessionLease } from "./v4/sessionDataLayer.js";
export type { ConversationTransport, ConversationAttachmentReadParams } from "./v4/transport.js";
export { TooltipProvider } from "./components/ui/tooltip.js";
export { ServiceProvider } from "./hooks/useServices.js";
export { PlatformProvider } from "./hooks/usePlatform.js";
export { StoreProvider, useZCodeStore } from "./store/StoreProvider.js";
export { TabStoreProvider } from "./store/TabStoreProvider.js";
export { DiffsWorkerPoolProvider } from "./root/DiffsWorkerPoolProvider.js";
export { ZCodeIntlProvider, useZCodeIntl } from "./i18n/IntlProvider.js";
export { Button } from "./components/ui/button.js";
export { cn } from "./components/lib/utils.js";
