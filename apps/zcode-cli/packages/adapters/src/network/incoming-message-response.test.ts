import assert from "node:assert/strict";
import http from "node:http";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { responseFromNodeMessage } from "./incoming-message-response.js";

describe("responseFromNodeMessage", () => {
  it("does not throw when Node returns 204", async () => {
    const message = await getStatus(204);
    assert.throws(
      () => new Response(Readable.toWeb(Readable.from([]) as Readable), { status: 204 }),
      /Invalid response status code 204/,
    );
    const response = responseFromNodeMessage(message);
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
  });

  it("keeps a normal body", async () => {
    const response = responseFromNodeMessage(await getStatus(200, "ok"));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
  });
});

function getStatus(status: number, body = ""): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(status);
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("server did not bind"));
        return;
      }
      const request = http.get(`http://127.0.0.1:${address.port}/`, (message) => {
        server.close();
        resolve(message);
      });
      request.on("error", (error) => {
        server.close();
        reject(error);
      });
    });
  });
}
