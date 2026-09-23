import assert from "node:assert/strict";
import test from "node:test";
import {
  parseFindEntries,
  quotePosixArg,
  remotePosixPath,
  sshDestinationArgs,
} from "@zcode/shared/node";
import { readProcessSshRemoteSpec, rewriteRemoteCommand } from "./ssh-remote.js";

test("ssh destination prefers the config alias and never adds a port", () => {
  assert.deepEqual(
    sshDestinationArgs({
      alias: "56idc-jp",
      host: "203.0.113.10",
      port: 22,
      username: "root",
      remotePath: "/srv/app",
    }),
    ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "56idc-jp"],
  );
});

test("ssh destination uses user and port when there is no alias", () => {
  assert.deepEqual(
    sshDestinationArgs({
      host: "203.0.113.10",
      port: 2201,
      username: "deploy",
      remotePath: "/srv/app",
    }),
    ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-p", "2201", "deploy@203.0.113.10"],
  );
});

test("windows resolved paths map back onto the remote root", () => {
  assert.equal(remotePosixPath("D:\\srv\\app\\src\\a.ts", "/srv/app"), "/srv/app/src/a.ts");
  assert.equal(quotePosixArg("o'brien"), "'o'\\''brien'");
  assert.equal(
    rewriteRemoteCommand('ls -la "C:/root/proxy-sticky" && dir C:\\root\\proxy-sticky', "/root/proxy-sticky"),
    'ls -la "/root/proxy-sticky" && dir /root/proxy-sticky',
  );
});

test("windows drive cwd still selects the ssh workspace", () => {
  const previous = process.env.ZCODE_SSH_REMOTE;
  process.env.ZCODE_SSH_REMOTE = JSON.stringify({
    alias: "box",
    host: "203.0.113.10",
    username: "root",
    remotePath: "/root/proxy-sticky",
  });
  try {
    assert.equal(readProcessSshRemoteSpec("C:\\root\\proxy-sticky")?.alias, "box");
    assert.equal(readProcessSshRemoteSpec("D:\\other"), undefined);
  } finally {
    if (previous === undefined) delete process.env.ZCODE_SSH_REMOTE;
    else process.env.ZCODE_SSH_REMOTE = previous;
  }
});

test("find output becomes file entries", () => {
  assert.deepEqual(parseFindEntries("d\tsrc\nf\tREADME.md\n", "/srv/app"), [
    { name: "src", path: "/srv/app/src", type: "directory", isSymbolicLink: false },
    { name: "README.md", path: "/srv/app/README.md", type: "file", isSymbolicLink: false },
  ]);
});
