import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildSshAskpassScript,
  parseFindEntries,
  quotePosixArg,
  rememberSshWorkspaceTarget,
  remotePosixPath,
  sshDestinationArgs,
  sshPasswordSecretPath,
  sshSpecFromConnectTarget,
  sshWorkspaceSpawnEnv,
  writeSshPasswordSecret,
} from "@zcode/shared/node";
import {
  readProcessSshRemoteSpec,
  rewriteRemoteCommand,
  sshWorkspacePrompt,
} from "./ssh-remote.js";

test("ssh destination prefers the config alias and never adds a port", () => {
  assert.deepEqual(
    sshDestinationArgs({
      alias: "56idc-jp",
      host: "203.0.113.10",
      port: 22,
      username: "root",
      remotePath: "/srv/app",
    }),
    [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "56idc-jp",
    ],
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
    [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-p",
      "2201",
      "deploy@203.0.113.10",
    ],
  );
});

test("password auth re-enables password methods and keeps the secret out of argv", () => {
  const args = sshDestinationArgs({
    host: "203.0.113.10",
    port: 22,
    username: "root",
    remotePath: "/srv/app",
    passwordFile: "/tmp/zcode-ssh-secrets/abc.secret",
  });

  // BatchMode=yes 会让 OpenSSH 连同密码认证一起禁用，密码模式必须显式关掉。
  assert.equal(args[args.indexOf("BatchMode=no") - 1], "-o");
  assert.ok(args.includes("PreferredAuthentications=password,keyboard-interactive"));
  assert.ok(args.includes("PubkeyAuthentication=no"));
  assert.ok(args.includes("NumberOfPasswordPrompts=1"));
  assert.ok(args.includes("StrictHostKeyChecking=accept-new"));
  // 凭据文件路径本身也不能进 argv：进程列表会暴露它。
  assert.equal(
    args.some((arg) => arg.includes("abc.secret")),
    false,
  );
});

test("accepts new host keys instead of failing on an unknown host", () => {
  // 未登记的 known_hosts 之前直接报 "Host key verification failed."；
  // accept-new 首次自动登记并写入 known_hosts，指纹变化时仍然拒绝。
  assert.ok(
    sshDestinationArgs({ host: "203.0.113.10", username: "root", remotePath: "/srv/app" }).includes(
      "StrictHostKeyChecking=accept-new",
    ),
  );
});

test("connect target turns the password into a secret file reference", () => {
  const secretDirectory = join("/tmp", "zcode-ssh-secrets");
  const spec = sshSpecFromConnectTarget(
    { host: "203.0.113.10", username: "root", password: "s3cret-value" },
    "/srv/app",
    { passwordSecretDirectory: secretDirectory },
  );
  assert.equal(spec.passwordFile, sshPasswordSecretPath(secretDirectory, spec));
  // env 里只能是路径：agent 派生的第三方子进程会继承整个 env。
  assert.equal(JSON.stringify(spec).includes("s3cret-value"), false);

  // 没有密码或没有目录时不能凭空造出密码认证。
  assert.equal("passwordFile" in sshSpecFromConnectTarget({ host: "h", username: "u" }, "/"), false);
  // 空字符串是「密码认证 + 空口令」：无密码账户必须仍走密码认证，
  // 否则会退回 BatchMode 公钥认证，报 Permission denied (publickey,...)。
  const emptyPasswordSpec = sshSpecFromConnectTarget(
    { host: "h", username: "u", password: "" },
    "/",
    { passwordSecretDirectory: secretDirectory },
  );
  assert.equal(
    emptyPasswordSpec.passwordFile,
    sshPasswordSecretPath(secretDirectory, emptyPasswordSpec),
  );
  const emptyPasswordArgs = sshDestinationArgs(emptyPasswordSpec);
  assert.ok(emptyPasswordArgs.includes("BatchMode=no"));
  assert.ok(emptyPasswordArgs.includes("PreferredAuthentications=password,keyboard-interactive"));
});

test("secret path is stable per target and isolated from the remote path", () => {
  const directory = join("/tmp", "zcode-ssh-secrets");
  const base = { host: "203.0.113.10", port: 22, username: "root" };
  assert.equal(
    sshPasswordSecretPath(directory, base),
    sshPasswordSecretPath(directory, { ...base }),
  );
  assert.notEqual(
    sshPasswordSecretPath(directory, base),
    sshPasswordSecretPath(directory, { ...base, username: "deploy" }),
  );
  assert.equal(sshPasswordSecretPath(directory, base).endsWith(".secret"), true);
});

test("written secret is private, newline terminated, and never enters the spawn env", async () => {
  const secretDirectory = await mkdtemp(join(tmpdir(), "zcode-ssh-secret-test-"));
  const workspaceIdentity = "ssh:test-secret-file";
  try {
    const target = { host: "203.0.113.10", username: "root" };
    const password = "p@ss & <word>!100%";
    const passwordFile = await writeSshPasswordSecret(secretDirectory, target, password);
    assert.equal(await readFile(passwordFile, "utf8"), `${password}\n`);
    if (process.platform !== "win32") {
      assert.equal((await stat(passwordFile)).mode & 0o777, 0o600);
    }

    rememberSshWorkspaceTarget(
      workspaceIdentity,
      sshSpecFromConnectTarget({ ...target, password }, "/srv/app", {
        passwordSecretDirectory: secretDirectory,
      }),
    );
    const spawnEnv = sshWorkspaceSpawnEnv(workspaceIdentity);
    assert.equal(spawnEnv.ZCODE_SSH_REMOTE?.includes(password), false);

    // agent 进程只能从 spawn env 拿到 spec；密码本体必须只在文件里。
    const previousSpec = process.env.ZCODE_SSH_REMOTE;
    process.env.ZCODE_SSH_REMOTE = spawnEnv.ZCODE_SSH_REMOTE;
    try {
      const spec = readProcessSshRemoteSpec("/srv/app");
      assert.equal(spec?.passwordFile, passwordFile);
      assert.equal(spec && "password" in spec, false);
    } finally {
      if (previousSpec === undefined) delete process.env.ZCODE_SSH_REMOTE;
      else process.env.ZCODE_SSH_REMOTE = previousSpec;
    }
  } finally {
    await rm(secretDirectory, { recursive: true, force: true });
  }
});

test("askpass script reads the secret file from env and never embeds the password", () => {
  // Windows 原生 OpenSSH 只能执行 .cmd；Git/Cygwin 的 ssh 只能执行 shell 脚本。
  // 两种形态的脚本都只按 env 路径读取凭据文件，脚本本体不含口令。
  const cmd = buildSshAskpassScript("cmd");
  assert.match(cmd, /type "%ZCODE_SSH_ASKPASS_SECRET%"/u);
  assert.match(cmd, /\r\n$/u);

  const sh = buildSshAskpassScript("sh");
  assert.match(sh, /^#!\/bin\/sh\n/u);
  assert.match(sh, /exec cat "\$ZCODE_SSH_ASKPASS_SECRET"/u);
  assert.match(sh, /\n$/u);
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

test("env spec with a non-string secret path degrades to key auth, not to a local workspace", () => {
  const previous = process.env.ZCODE_SSH_REMOTE;
  process.env.ZCODE_SSH_REMOTE = JSON.stringify({
    host: "203.0.113.10",
    username: "root",
    remotePath: "/root/app",
    passwordFile: { path: "/tmp/x" },
  });
  try {
    const spec = readProcessSshRemoteSpec("/root/app");
    assert.equal(spec?.host, "203.0.113.10");
    assert.equal(spec && "passwordFile" in spec, false);
  } finally {
    if (previous === undefined) delete process.env.ZCODE_SSH_REMOTE;
    else process.env.ZCODE_SSH_REMOTE = previous;
  }
});

test("env spec keeps the detected platform and drops dirty values", () => {
  const previous = process.env.ZCODE_SSH_REMOTE;
  try {
    process.env.ZCODE_SSH_REMOTE = JSON.stringify({
      host: "192.168.87.20",
      username: "agent",
      remotePath: "C:\\work",
      platform: "windows",
    });
    assert.equal(readProcessSshRemoteSpec("C:\\work")?.platform, "windows");

    // 脏值只丢字段：旧 Host 或未来新增的枚举不能让整个 spec 失效，
    // 否则远程工作区会静默退化成本地目录。
    process.env.ZCODE_SSH_REMOTE = JSON.stringify({
      host: "192.168.87.20",
      username: "agent",
      remotePath: "C:\\work",
      platform: "os2",
    });
    const dirty = readProcessSshRemoteSpec("C:\\work");
    assert.equal(dirty?.host, "192.168.87.20");
    assert.equal(dirty && "platform" in dirty, false);
  } finally {
    if (previous === undefined) delete process.env.ZCODE_SSH_REMOTE;
    else process.env.ZCODE_SSH_REMOTE = previous;
  }
});

test("workspace prompt switches shell family with the remote platform", () => {
  const windowsPrompt = sshWorkspacePrompt({
    host: "192.168.87.20",
    username: "agent",
    remotePath: "C:\\work",
    platform: "windows",
  });
  assert.match(windowsPrompt, /remote Windows host/u);
  assert.match(windowsPrompt, /PowerShell/u);
  assert.equal(/POSIX shell/u.test(windowsPrompt), false);

  const posixPrompt = sshWorkspacePrompt({
    host: "203.0.113.10",
    username: "root",
    remotePath: "/srv/app",
  });
  assert.match(posixPrompt, /remote POSIX host/u);
  assert.match(posixPrompt, /Do not use cmd, PowerShell/u);
});

test("find output becomes file entries", () => {
  assert.deepEqual(parseFindEntries("d\tsrc\nf\tREADME.md\n", "/srv/app"), [
    { name: "src", path: "/srv/app/src", type: "directory", isSymbolicLink: false },
    { name: "README.md", path: "/srv/app/README.md", type: "file", isSymbolicLink: false },
  ]);
});
