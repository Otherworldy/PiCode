import { Boxes, Package, Palette, Puzzle, Sparkles, Terminal } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";

export type CatalogKind = "extension" | "skill" | "theme" | "prompt";

const KIND_THEMES: Record<
  CatalogKind,
  {
    badge: string;
    icon: typeof Puzzle;
  }
> = {
  extension: {
    badge: "border-indigo-500/25 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
    icon: Puzzle,
  },
  skill: {
    badge: "border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    icon: Sparkles,
  },
  theme: {
    badge: "border-rose-500/25 bg-rose-500/10 text-rose-600 dark:text-rose-400",
    icon: Palette,
  },
  prompt: {
    badge: "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    icon: Terminal,
  },
};

const DEFAULT_THEME = {
  badge: "border-sky-500/25 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  icon: Package,
};

/**
 * 分类药丸徽标：区分 extension / skill / theme / prompt / package。
 * 图标保持中性色，仅徽标底色与文字保留分类重点色。
 */
export function PluginKindBadge({
  kind,
  label,
  className,
}: {
  kind?: string;
  label?: ReactNode;
  className?: string;
}) {
  const theme = kind && kind in KIND_THEMES ? KIND_THEMES[kind as CatalogKind] : DEFAULT_THEME;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-ui-xs font-semibold tracking-wide uppercase",
        theme.badge,
        className,
      )}
    >
      <theme.icon className="size-2.5 shrink-0 opacity-70" aria-hidden="true" />
      {label ?? kind}
    </span>
  );
}

/**
 * 中性无彩色占位图：当插件缺少 pi.image 时使用，保持灰阶与统一轮廓。
 */
export function PluginAvatarPlaceholder({ name, kind }: { name: string; kind?: string }) {
  const clean = name.replace(/^@[^/]+\//u, "").replace(/^pi-/u, "");
  const initials = clean.slice(0, 2).toUpperCase() || "PI";

  return (
    <div
      aria-hidden="true"
      className="hidden size-16 shrink-0 flex-col items-center justify-between rounded-lg border border-border bg-surface p-2 select-none sm:flex"
    >
      <div className="flex w-full items-center justify-between text-foreground-subtle">
        <Boxes className="size-3.5" />
        <span className="font-mono text-[9px] font-bold tracking-tighter">{initials}</span>
      </div>
      <div className="w-full truncate font-mono text-[9px] font-medium tracking-tight text-center text-foreground-subtlest">
        {kind ?? "plugin"}
      </div>
    </div>
  );
}

/** 官方推荐核心包的特色标签配置（图标保持中性无彩色） */
export const FEATURED_THEMES: Record<
  string,
  {
    badge: string;
    cardBorder: string;
    icon: typeof Sparkles;
    iconClass: string;
  }
> = {
  "npm:@plannotator/pi-extension": {
    badge: "border-indigo-500/30 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
    cardBorder: "hover:border-border-hover",
    icon: Puzzle,
    iconClass: "text-foreground-subtle",
  },
  "https://github.com/Otherworldy/pi-processes-bash": {
    badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    cardBorder: "hover:border-border-hover",
    icon: Terminal,
    iconClass: "text-foreground-subtle",
  },
  "git:github.com/Otherworldy/pi-ask-me": {
    badge: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    cardBorder: "hover:border-border-hover",
    icon: Sparkles,
    iconClass: "text-foreground-subtle",
  },
};
