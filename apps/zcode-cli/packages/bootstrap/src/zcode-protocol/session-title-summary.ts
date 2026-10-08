import { readFile } from "node:fs/promises";
import { summarizeSessionTitleContent } from "@zcode/pi-host";
import { zcodeSessionSummarizeTitleParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

export async function summarizeSessionTitle(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeSessionSummarizeTitleParamsSchema, rawParams);
  if (!context.piHost) throw new Error("session host unavailable");
  const live = context.piHost.get(params.sessionId);
  const stored = live ? null : await context.piHost.find(params.sessionId);
  const sessionFile = live?.sessionFile || stored?.sessionFile;
  if (!sessionFile) throw new Error("session not found");
  const snapshot = live?.projector.getSnapshot();
  const provider = snapshot?.config.provider.trim();
  const model = snapshot?.config.model.trim();
  const jsonl = await readFile(sessionFile, "utf8").catch(() => "");
  const title = await summarizeSessionTitleContent({
    ...(snapshot ? { rows: snapshot.rows.window } : {}),
    ...(jsonl ? { jsonl } : {}),
    ...(provider && model ? { fallbackProvider: provider, fallbackModel: model } : {}),
  });
  // 会话已经打开时先推到侧栏。没打开的会话靠随后的 rename 写任务索引。
  live?.publishCustomTitle(title);
  return { title };
}
