import type { ReactNode } from "react";
import { AlertDialogHost } from "@/AlertDialogHost.js";
import { AppUpdateInstallOverlay } from "@/AppUpdateInstallOverlay.js";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";
import { CuaPermissionObservationAttachment } from "@/cua-permission/CuaPermissionObservationAttachment.js";
import { PluginUiFollowUpDialogHost } from "@/plugin-ui/index.js";

export function RootShell({ children }: { children: ReactNode }) {
  // Web 远控在手机浏览器里不能用固定 100vh，
  // 地址栏收放会让底部输入区被裁到视口外；根节点改用动态视口高度。
  return (
    <div className="relative h-dvh">
      {children}
      <CuaPermissionObservationAttachment />
      <AlertDialogHost />
      <ConfirmDialogHost />
      <PluginUiFollowUpDialogHost />
      {/* 静默安装前窗口马上就要关，等待态必须挂在根节点，任何页面都能看到。 */}
      <AppUpdateInstallOverlay />
    </div>
  );
}
