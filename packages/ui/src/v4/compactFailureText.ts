/** 把 Pi compact 的英文原因换成界面文案。认不出的原因原样返回，避免吞掉模型错误。 */
export function compactFailureText(
  message: string,
  format: (id: string) => string,
): string {
  const text = message.replace(/^Compaction failed:\s*/i, "").trim();
  if (/nothing to compact/i.test(text)) {
    return format("chat.contextCompaction.tooSmall");
  }
  if (/already compacted/i.test(text)) {
    return format("chat.contextCompaction.alreadyCompacted");
  }
  return text || format("chat.contextCompaction.failed");
}
