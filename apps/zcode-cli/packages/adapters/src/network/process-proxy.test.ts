import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ZCODE_HTTP_PROXY_ENV_KEY, ZCODE_NO_PROXY_ENV_KEY } from "@zcode/shared";
import { createNetworkProxyFetch, installProcessProxyFetch } from "./proxy-fetch.js";

const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

describe("installProcessProxyFetch", () => {
  const previousFetch = globalThis.fetch;
  const touched = new Map<string, string | undefined>();

  afterEach(() => {
    globalThis.fetch = previousFetch;
    for (const [key, value] of touched) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    touched.clear();
  });

  it("writes the settings proxy onto a child env without replacing fetch", () => {
    const env: Record<string, string | undefined> = {
      [ZCODE_HTTP_PROXY_ENV_KEY]: "127.0.0.1:7890",
      [ZCODE_NO_PROXY_ENV_KEY]: "localhost,.example.test",
      KEEP: "1",
    };
    installProcessProxyFetch(env);
    assert.equal(env.http_proxy ?? env.HTTP_PROXY, "http://127.0.0.1:7890");
    assert.equal(env.https_proxy ?? env.HTTPS_PROXY, "http://127.0.0.1:7890");
    assert.equal(env.no_proxy ?? env.NO_PROXY, "localhost,.example.test");
    assert.equal(env.KEEP, "1");
    assert.equal(globalThis.fetch, previousFetch);
  });

  it("lets a no-proxy host skip the proxy and sends other hosts through it", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("direct");
    }) as typeof fetch;
    const fetch = createNetworkProxyFetch({
      fetch: globalThis.fetch,
      httpProxy: "http://127.0.0.1:9",
      noProxy: "localhost,.example.test",
    });

    const direct = await fetch("https://api.example.test/v1");
    assert.equal(await direct.text(), "direct");
    assert.deepEqual(seen, ["https://api.example.test/v1"]);

    await assert.rejects(fetch("https://api.example.com/v1"));
    assert.deepEqual(seen, ["https://api.example.test/v1"]);
  });

  it("installs one process fetch and keeps the proxy across a second call", () => {
    remember("ZCODE_HTTP_PROXY", "http://127.0.0.1:7890");
    remember("ZCODE_NO_PROXY", "localhost");
    for (const key of [...PROXY_KEYS, "NO_PROXY", "no_proxy"]) remember(key);
    process.env.ZCODE_HTTP_PROXY = "http://127.0.0.1:7890";
    process.env.ZCODE_NO_PROXY = "localhost";

    installProcessProxyFetch(process.env);
    const installed = globalThis.fetch;
    assert.notEqual(installed, previousFetch);
    assert.equal(process.env.HTTP_PROXY, "http://127.0.0.1:7890");
    assert.equal(process.env.NO_PROXY, "localhost");

    installProcessProxyFetch(process.env);
    assert.equal(globalThis.fetch, installed);
  });

  function remember(key: string, value = process.env[key]): void {
    if (!touched.has(key)) touched.set(key, value);
  }
});
