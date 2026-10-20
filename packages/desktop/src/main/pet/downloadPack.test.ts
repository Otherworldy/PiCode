import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { downloadPetPack, type PetPackDownloadProgress } from "./downloadPack.js";

const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("downloadPetPack", () => {
  it("rejects an address that is not http(s)", async () => {
    const dir = await makeDir();
    await expect(downloadPetPack("notaurl", dir)).rejects.toMatchObject({ reason: "invalid-url" });
    await expect(downloadPetPack("file:///C:/pet.zip", dir)).rejects.toMatchObject({
      reason: "invalid-url",
    });
  });

  it("reports received bytes and a server error", async () => {
    const body = Buffer.from("not-a-zip");
    const url = await listen((response) => {
      response.writeHead(200, { "content-length": String(body.length) });
      response.end(body);
    });
    const dir = await makeDir();
    const events: PetPackDownloadProgress[] = [];
    const error = await downloadPetPack(url, dir, {
      onProgress: (event) => events.push(event),
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: "missing-config" });
    expect(events).toContainEqual({
      phase: "downloading",
      received: body.length,
      total: body.length,
    });
  });

  it("uses the fetch it is given, so a proxy can replace the default one", async () => {
    const body = Buffer.from("not-a-zip");
    const url = await listen((response) => {
      response.writeHead(200, { "content-length": String(body.length) });
      response.end(body);
    });
    const dir = await makeDir();
    const seen: string[] = [];
    const customFetch: typeof fetch = async (input, init) => {
      seen.push(String(input));
      return fetch(input, init);
    };
    await downloadPetPack(url, dir, { fetch: customFetch }).catch(() => undefined);
    expect(seen).toEqual([url]);
  });

  it("stops when the download is aborted", async () => {
    const url = await listen(() => {
      // 一直不回包，用来确认停止能打断请求。
    });
    const dir = await makeDir();
    const controller = new AbortController();
    const pending = downloadPetPack(url, dir, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps the http status when the server rejects the file", async () => {
    const url = await listen((response) => {
      response.writeHead(404);
      response.end();
    });
    const dir = await makeDir();
    await expect(downloadPetPack(url, dir)).rejects.toMatchObject({ reason: "http", status: 404 });
  });
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pet-pack-"));
  dirs.push(dir);
  return dir;
}

function listen(respond: (response: import("node:http").ServerResponse) => void): Promise<string> {
  const server = createServer((_request, response) => respond(response));
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve(`http://127.0.0.1:${address.port}/pet.zip`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
