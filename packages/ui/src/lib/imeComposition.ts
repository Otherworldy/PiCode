export function isImeComposingKeyEvent(event: {
  compositionActive?: boolean;
  isComposing?: boolean;
  key?: string;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}): boolean {
  const keyCode = event.keyCode ?? event.nativeEvent?.keyCode;
  // keyCode 229 是 Chromium 的 IME 处理键。部分平台确认候选时 isComposing 已经是 false，
  // 只看 isComposing 会把这次 Enter 当成提交或导航，preventDefault 后候选写不进输入框。
  return Boolean(
    event.compositionActive ||
      event.isComposing ||
      event.nativeEvent?.isComposing ||
      event.key === "Process" ||
      event.key === "Dead" ||
      keyCode === 229,
  );
}
