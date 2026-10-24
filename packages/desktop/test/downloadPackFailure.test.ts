import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PetPackDownloadError, writeResponseBody } from "../src/main/pet/downloadPack.js";

/**
 * writeResponseBody 的失败路径。原实现的 output 流在 finally 的 finished() 之前没有
 * error 消费者，写盘错误会以 uncaughtException 打死 main 进程。
 */

function bodyResponse(
  bytes: Uint8Array,
  init?: { status?: number; contentLength?: number },
): Response {
  const headers = new Headers();
  if (init?.contentLength !== undefined) {
    headers.set("content-length", String(init.contentLength));
  }
  return new Response(bytes, { status: init?.status ?? 200, headers });
}

const URL_UNDER_TEST = "https://example.test/pet.zip";

test("写盘失败（路径被目录占用）映射为 network，不抛出未捕获异常", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pet-pack-write-fail-"));
  const zipPath = join(dir, "pack.zip");
  // 用同名目录占住目标：createWriteStream 打开失败，pipeline 必须把它收进 catch。
  await mkdir(zipPath);
  const fetchImpl = (async () => bodyResponse(new Uint8Array([1, 2, 3]))) as typeof fetch;

  await assert.rejects(
    () => writeResponseBody(URL_UNDER_TEST, zipPath, { fetch: fetchImpl }),
    (error: unknown) => error instanceof PetPackDownloadError && error.reason === "network",
  );

  await rm(dir, { recursive: true, force: true });
});

test("正常写入：字节完整且 onProgress 的 received 单调递增到最后一段", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pet-pack-write-ok-"));
  const zipPath = join(dir, "pack.zip");
  const body = new Uint8Array(64 * 1024);
  for (let index = 0; index < body.length; index += 1) {
    body[index] = index % 251;
  }
  const progress: number[] = [];
  const fetchImpl = (async () =>
    bodyResponse(body, { contentLength: body.length })) as typeof fetch;

  await writeResponseBody(URL_UNDER_TEST, zipPath, {
    fetch: fetchImpl,
    onProgress: (event) => {
      if (event.phase === "downloading") progress.push(event.received);
    },
  });

  const written = new Uint8Array(await readFile(zipPath));
  assert.equal(written.length, body.length);
  assert.deepEqual(written, body);
  assert.ok(progress.length > 0, "应当至少报告一次进度");
  assert.equal(progress.at(-1), body.length);
  for (let index = 1; index < progress.length; index += 1) {
    assert.ok(progress[index]! > progress[index - 1]!, "received 必须单调递增");
  }

  await rm(dir, { recursive: true, force: true });
});

test("content-length 超过上限时直接 too-large，不创建输出文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pet-pack-too-large-"));
  const zipPath = join(dir, "pack.zip");
  const fetchImpl = (async () =>
    bodyResponse(new Uint8Array([1]), {
      contentLength: 2 * 1024 * 1024 * 1024,
    })) as typeof fetch;

  await assert.rejects(
    () => writeResponseBody(URL_UNDER_TEST, zipPath, { fetch: fetchImpl }),
    (error: unknown) => error instanceof PetPackDownloadError && error.reason === "too-large",
  );
  await assert.rejects(
    () => readFile(zipPath),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );

  await rm(dir, { recursive: true, force: true });
});

test("响应体缺失映射为 http 并带上状态码", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pet-pack-no-body-"));
  const zipPath = join(dir, "pack.zip");
  const fetchImpl = (async () => new Response(null, { status: 204 })) as typeof fetch;

  await assert.rejects(
    () => writeResponseBody(URL_UNDER_TEST, zipPath, { fetch: fetchImpl }),
    (error: unknown) =>
      error instanceof PetPackDownloadError && error.reason === "http" && error.status === 204,
  );

  await rm(dir, { recursive: true, force: true });
});

test("已 abort 的 signal 原样抛出 AbortError，不映射成 network", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pet-pack-abort-"));
  const zipPath = join(dir, "pack.zip");
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = (async () => {
    throw new DOMException("The operation was aborted", "AbortError");
  }) as typeof fetch;

  await assert.rejects(
    () =>
      writeResponseBody(URL_UNDER_TEST, zipPath, {
        fetch: fetchImpl,
        signal: controller.signal,
      }),
    (error: unknown) => (error as Error).name === "AbortError",
  );

  await rm(dir, { recursive: true, force: true });
});
