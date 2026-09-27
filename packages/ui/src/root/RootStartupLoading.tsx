import type { ReactNode } from "react";
import piLogoUrl from "@/assets/pi_logo.svg";

interface RootStartupLoadingProps {
  label: string;
  children?: ReactNode;
  busy?: boolean;
}

export function RootStartupLoading({ label, children, busy = true }: RootStartupLoadingProps) {
  return (
    <div
      // Web 端全局 html/body/#root 为 Electron 透明背景让路，React 接管后会替换 HTML 启动壳。
      // 这里必须由阻塞态自身承接主题背景，否则远控链接会在 Root 恢复期间继续露出浏览器白底。
      className="flex h-full min-h-dvh flex-col items-center justify-center gap-6 bg-background text-foreground"
      role="status"
      aria-busy={busy}
      aria-label={label}
      data-testid="root-startup-loading"
    >
      <ZCodeStartupLogoBadge />
      {children}
    </div>
  );
}

/** 启动与引导共用品牌标志，透明底，不再套深色底板。 */
export function ZCodeStartupLogoBadge({ animated: _animated = true }: { animated?: boolean }) {
  return <img src={piLogoUrl} alt="" className="size-16" draggable={false} />;
}
