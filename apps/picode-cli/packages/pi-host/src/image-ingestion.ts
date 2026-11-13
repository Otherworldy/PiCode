import type { ImageContent, JsonValue, TextContent } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { piCoding } from "./pi-sdk.js";

type ResizeImage = ReturnType<typeof piCoding>["resizeImage"];
type ResizeOptions = NonNullable<Parameters<ResizeImage>[2]>;
type Content = TextContent | ImageContent;

function mergeReadDimensionNote(
  content: Content[],
  result: NonNullable<Awaited<ReturnType<ResizeImage>>>,
): boolean {
  const previous = content.at(-1);
  if (previous?.type !== "text" || !previous.text.startsWith("Read image file [")) return false;
  const note = previous.text.match(
    /\[Image: original (\d+)x(\d+), displayed at (\d+)x(\d+)\. Multiply coordinates by [\d.]+ to map to original image\.\]/,
  );
  if (
    !note ||
    Number(note[3]) !== result.originalWidth ||
    Number(note[4]) !== result.originalHeight
  )
    return false;
  const hint = piCoding().formatDimensionNote({
    ...result,
    originalWidth: Number(note[1]),
    originalHeight: Number(note[2]),
  });
  if (!hint) return false;
  // Read 先按 SDK 规则缩过图；合并两段比例，避免模型把中间尺寸当成源文件坐标。
  content[content.length - 1] = { ...previous, text: previous.text.replace(note[0], hint) };
  return true;
}

const IMAGE_PROFILE = {
  maxWidth: 2000,
  maxHeight: 2000,
  maxBytes: 512 * 1024,
  jpegQuality: 80,
};

export interface ImageProcessingDiagnostic {
  imageCount: number;
  inputBase64Bytes: number;
  outputBase64Bytes: number;
  failedImages: number;
  durationMs: number;
}

export interface SessionImageDiagnostic extends ImageProcessingDiagnostic {
  sessionId: string;
  parentSessionId?: string;
  source: "input" | "tool_result";
  toolName?: string;
  toolCallId?: string;
  parentToolCallId?: string;
}

export async function normalizeIncomingImages(
  content: Content[],
  options: {
    enabled: boolean;
    resizeOptions?: ResizeOptions;
    resize?: ResizeImage;
    onDiagnostic?: (diagnostic: ImageProcessingDiagnostic) => void;
  },
): Promise<Content[]> {
  if (!options.enabled || !content.some((block) => block.type === "image")) return content;
  const started = performance.now();
  const profile = { ...IMAGE_PROFILE };
  for (const key of Object.keys(profile) as Array<keyof typeof profile>) {
    profile[key] = Math.min(profile[key], options.resizeOptions?.[key] ?? profile[key]);
  }
  const normalized: Content[] = [];
  let changed = false;
  const diagnostic: ImageProcessingDiagnostic = {
    imageCount: 0,
    inputBase64Bytes: 0,
    outputBase64Bytes: 0,
    failedImages: 0,
    durationMs: 0,
  };
  for (const block of content) {
    if (block.type !== "image") {
      normalized.push(block);
      continue;
    }
    diagnostic.imageCount++;
    diagnostic.inputBase64Bytes += Buffer.byteLength(block.data, "utf8");
    let processed: Awaited<ReturnType<ResizeImage>> = null;
    try {
      processed = await (options.resize ?? piCoding().resizeImage)(
        Buffer.from(block.data, "base64"),
        block.mimeType,
        profile,
      );
    } catch {
      // 编码后端失败不能丢掉工具已产出的图片；保留原块并用数值诊断暴露缺口。
    }
    diagnostic.outputBase64Bytes += Buffer.byteLength(processed?.data ?? block.data, "utf8");
    if (!processed) {
      diagnostic.failedImages++;
      normalized.push(block);
      continue;
    }
    if (processed.data === block.data && processed.mimeType === block.mimeType) {
      normalized.push(block);
      continue;
    }
    changed = true;
    const resized =
      processed.width !== processed.originalWidth || processed.height !== processed.originalHeight;
    const merged = resized && mergeReadDimensionNote(normalized, processed);
    normalized.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
    const hint = resized && !merged ? piCoding().formatDimensionNote(processed) : undefined;
    if (hint) normalized.push({ type: "text", text: hint });
  }
  diagnostic.durationMs = performance.now() - started;
  try {
    options.onDiagnostic?.(diagnostic);
  } catch {
    // 诊断只观察，不让日志回调故障改变图片准入结果。
  }
  return changed ? normalized : content;
}

export function refreshStructuredImage(
  structured: JsonValue | undefined,
  original: Content[],
  normalized: Content[],
): JsonValue | undefined {
  // 编码转换不改变自定义结构的含义；显式交回它，避免 Pi 按 content 变更将其删除。
  if (!structured || typeof structured !== "object" || !("type" in structured)) return structured;
  const before = original.find((block) => block.type === "image");
  const after = normalized.find((block) => block.type === "image");
  if (
    !before ||
    !after ||
    structured.type !== "image" ||
    structured.data !== before.data ||
    structured.mimeType !== before.mimeType
  )
    return structured;
  // Read 的 structuredContent 是 codemode 的返回值，不能因换编码失效或保留旧的大图。
  return {
    ...structured,
    data: after.data,
    mimeType: after.mimeType,
    ...(typeof structured.note === "string"
      ? { note: normalized.find((block) => block.type === "text")?.text ?? structured.note }
      : {}),
  };
}

export function createImageIngestionExtension(options: {
  autoResize: () => boolean;
  parentSessionId?: string;
  onDiagnostic?: (diagnostic: SessionImageDiagnostic) => void;
}): InlineExtension {
  return {
    name: "picode-image-ingestion",
    hidden: true,
    factory(pi) {
      // Pi 的 steer/follow-up 只经过 input；在同一个入口补齐，避免忙时图片绕过压缩。
      pi.on("input", async (event, ctx) => {
        if (!event.images?.length) return;
        const content = await normalizeIncomingImages(event.images, {
          enabled: options.autoResize(),
          resizeOptions: ctx.model?.inputLimits?.images?.resize,
          onDiagnostic: (diagnostic) =>
            options.onDiagnostic?.({
              ...diagnostic,
              sessionId: ctx.sessionManager.getSessionId(),
              parentSessionId: options.parentSessionId,
              source: "input",
            }),
        });
        if (content === event.images) return;
        const hints = content.filter((block): block is TextContent => block.type === "text");
        return {
          action: "transform",
          text: [event.text, ...hints.map((block) => block.text)].filter(Boolean).join("\n"),
          images: content.filter((block): block is ImageContent => block.type === "image"),
        };
      });
      pi.on("tool_result", async (event, ctx) => {
        const content = await normalizeIncomingImages(event.content, {
          enabled: options.autoResize(),
          resizeOptions: ctx.model?.inputLimits?.images?.resize,
          onDiagnostic: (diagnostic) =>
            options.onDiagnostic?.({
              ...diagnostic,
              sessionId: ctx.sessionManager.getSessionId(),
              parentSessionId: options.parentSessionId,
              source: "tool_result",
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              parentToolCallId: event.parentToolCallId,
            }),
        });
        return content === event.content
          ? undefined
          : {
              content,
              structuredContent: refreshStructuredImage(
                event.structuredContent,
                event.content,
                content,
              ),
            };
      });
    },
  };
}
