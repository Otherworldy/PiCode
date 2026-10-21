type DateTimeFormatterKind = "monthDayTime" | "yearMonthDayTime";

const MESSAGE_TIME_LABEL_CACHE_LIMIT = 4_000;
const messageTimeLabelCache = new Map<string, string>();
const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getDayCacheKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function getDateTimeFormatter(locale: string, kind: DateTimeFormatterKind): Intl.DateTimeFormat {
  const cacheKey = `${locale}:${kind}`;
  const cached = dateTimeFormatterCache.get(cacheKey);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat(
    locale,
    kind === "monthDayTime"
      ? // 用 short 而不是 numeric：中文下 numeric 会输出 10/20，
        // short 才是「10月20日 19:45」；英文对应紧凑的 Oct 20。
        { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
      : {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        },
  );
  dateTimeFormatterCache.set(cacheKey, formatter);
  return formatter;
}

function cacheMessageTimeLabel(cacheKey: string, label: string): string {
  if (messageTimeLabelCache.size >= MESSAGE_TIME_LABEL_CACHE_LIMIT) {
    messageTimeLabelCache.clear();
  }
  messageTimeLabelCache.set(cacheKey, label);
  return label;
}

/**
 * 消息时间戳：今年显示「10月20日 19:45」，跨年补上年份。
 * 不再按「今天只显示时分」压缩：轮尾的用量数字要和日期一起读才有意义，
 * 单看 07:56 分不清是哪天的这一轮。
 */
export function formatMessageTimeLabel(
  timestamp: number,
  locale: string,
  nowTimestamp = Date.now(),
): string | null {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;

  const messageDate = new Date(timestamp);
  const now = new Date(nowTimestamp);
  if (Number.isNaN(messageDate.getTime()) || Number.isNaN(now.getTime())) return null;

  const cacheKey = `${locale}:${timestamp}:${getDayCacheKey(now)}`;
  const cached = messageTimeLabelCache.get(cacheKey);
  if (cached !== undefined) return cached;

  return cacheMessageTimeLabel(
    cacheKey,
    getDateTimeFormatter(
      locale,
      messageDate.getFullYear() === now.getFullYear() ? "monthDayTime" : "yearMonthDayTime",
    ).format(messageDate),
  );
}
