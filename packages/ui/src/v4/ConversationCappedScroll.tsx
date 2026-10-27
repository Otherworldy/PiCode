import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/** 离底多少像素内算「还贴着底部」。工具卡展开会让内容跳动，阈值取宽一点。 */
const STICK_THRESHOLD_PX = 32;

/**
 * 限高滚动容器：超过 `min(400px, 50vh)` 在块内滚动，能滚的方向上给 24px 渐隐。
 * 工具链和压缩摘要共用：长内容不应该把后面的内容推到几屏之外。
 *
 * 正文不进来：正文是阅读主体，套进滚动框会让人先在框里滚一遍才能继续读。
 */
export function ConversationCappedScroll({
  running = false,
  children,
}: {
  /** 这块还在跑。只有运行中才自动吸底，静态内容保持读者自己的滚动位置。 */
  running?: boolean;
  children: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // 只有读者自己离开底部才停止吸底。内容增长、工具卡展开都不算。
  const stickToBottom = useRef(true);
  const lastScrollTop = useRef(0);
  // 上一轮的 max。读者停在底部、内容刚好长高时，top 还停在旧底部而 max 已经变大；
  // 只看新 max 会把他判成「已经离开底部」，从此不再跟随。
  const lastMax = useRef(0);
  // 滚动条按需出现：没滚过、或者还在跟随底部时，不留一根粗条占着右边。
  const scrolledOnce = useRef(false);
  const [edges, setEdges] = useState({ up: false, down: false });
  const [scrollbarVisible, setScrollbarVisible] = useState(false);

  /**
   * `source` 决定要不要做「上滚」判断：
   * - `scroll`：读者自己滚的，`top` 变小就是上滚。
   * - `content`：内容高度变化（流式输出、工具卡展开/收起）也会改 `scrollTop`，
   *   尤其收起时 top 被 clamp 变小，会被误读成上滚。这时只认「是否在底部」。
   * - `awayFromBottom`：滚轮/按键已经明确表达了上滚意图，此刻位置还没变，
   *   不能靠几何判断。
   */
  const sync = useCallback((source: "scroll" | "content" | "awayFromBottom" = "scroll") => {
    const element = scrollRef.current;
    if (!element) return;
    const max = Math.max(0, element.scrollHeight - element.clientHeight);
    const top = element.scrollTop;
    const previousTop = lastScrollTop.current;
    const previousMax = lastMax.current;
    lastScrollTop.current = top;
    lastMax.current = max;

    const atBottom = max - top <= STICK_THRESHOLD_PX;
    // 读者没动、内容长高了：top 仍停在上一轮确认过的底部。
    const stayedAtKnownBottom = previousMax > 0 && top >= previousMax - STICK_THRESHOLD_PX;

    if (source === "awayFromBottom") {
      stickToBottom.current = false;
    } else if (source === "scroll" && top < previousTop - 1) {
      stickToBottom.current = false;
    } else if (atBottom || stayedAtKnownBottom) {
      stickToBottom.current = true;
    }

    setEdges((previous) => {
      const next = { up: top > 1, down: max - top > 1 };
      return previous.up === next.up && previous.down === next.down ? previous : next;
    });
    // 跟随中说明读者在看最新内容，不该有滚动条；离开底部才亮出来。
    setScrollbarVisible(scrolledOnce.current && !stickToBottom.current);
  }, []);

  const markScrolled = useCallback(() => {
    scrolledOnce.current = true;
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    const content = contentRef.current;
    if (!element || !content) return;

    const follow = () => {
      if (running && stickToBottom.current) element.scrollTop = element.scrollHeight;
      sync("content");
    };

    follow();
    if (typeof ResizeObserver === "undefined") return;
    // 内容变高不会触发 scroll 事件：工具卡从收起展开、输出流式增长都走这里。
    // 吸底挂在这个回调上，不能挂在每次渲染上，否则读者根本滚不上去。
    const observer = new ResizeObserver(follow);
    observer.observe(content);
    return () => observer.disconnect();
  }, [running, sync]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    // 滚到顶了还继续上滚时 scrollTop 不变，只靠 scroll 事件判断不出来，
    // 这里提前接住意图，免得下一次内容增长又把人拽回底部。
    const onWheel = (event: WheelEvent) => {
      markScrolled();
      sync(event.deltaY < 0 ? "awayFromBottom" : "scroll");
    };
    const onKeyDown = (event: KeyboardEvent) => {
      markScrolled();
      const away = event.key === "ArrowUp" || event.key === "PageUp";
      sync(away ? "awayFromBottom" : "scroll");
    };
    const onPointerDown = () => markScrolled();
    const onTouchStart = () => markScrolled();
    element.addEventListener("wheel", onWheel, { passive: true });
    element.addEventListener("keydown", onKeyDown);
    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("touchstart", onTouchStart, { passive: true });
    return () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("keydown", onKeyDown);
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("touchstart", onTouchStart);
    };
  }, [markScrolled, sync]);

  return (
    <div
      ref={scrollRef}
      className="zcode-capped-scroll"
      data-scroll-up={edges.up ? "true" : undefined}
      data-scroll-down={edges.down ? "true" : undefined}
      data-scrollbar={scrollbarVisible ? "true" : undefined}
      onScroll={() => sync("scroll")}
    >
      <div ref={contentRef} className="flex flex-col gap-4">
        {children}
      </div>
    </div>
  );
}
