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
  const [edges, setEdges] = useState({ up: false, down: false });

  const sync = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const max = Math.max(0, element.scrollHeight - element.clientHeight);
    const top = element.scrollTop;
    // 内容变高时 top 不动、max 变大；读者上滚时 top 变小。只认后者。
    // 若只看「离底多远」，流式输出每帧都会把刚滚出去的人再拽回底部。
    if (top < lastScrollTop.current - 1) {
      stickToBottom.current = false;
    } else if (max - top <= STICK_THRESHOLD_PX) {
      stickToBottom.current = true;
    }
    lastScrollTop.current = top;
    setEdges((previous) => {
      const next = { up: top > 1, down: max - top > 1 };
      return previous.up === next.up && previous.down === next.down ? previous : next;
    });
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    const content = contentRef.current;
    if (!element || !content) return;

    const follow = () => {
      if (running && stickToBottom.current) element.scrollTop = element.scrollHeight;
      sync();
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
      if (event.deltaY < 0) stickToBottom.current = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowUp" || event.key === "PageUp") stickToBottom.current = false;
    };
    element.addEventListener("wheel", onWheel, { passive: true });
    element.addEventListener("keydown", onKeyDown);
    return () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <div
      ref={scrollRef}
      className="zcode-capped-scroll"
      data-scroll-up={edges.up ? "true" : undefined}
      data-scroll-down={edges.down ? "true" : undefined}
      onScroll={sync}
    >
      <div ref={contentRef} className="flex flex-col gap-4">
        {children}
      </div>
    </div>
  );
}
