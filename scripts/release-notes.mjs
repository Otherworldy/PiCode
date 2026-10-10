import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// 和 scripts/release-it/changelog-writer.mjs 同一套分节：feat/fix 在前，
// 其余类型靠后。GitHub 自动说明和 Vite 的 changelog 都是这个顺序。
const SECTIONS = [
  { type: "feat", title: "Features" },
  { type: "fix", title: "Bug Fixes" },
  { type: "refactor", title: "Refactorings" },
  { type: "docs", title: "Documentation" },
  { type: "chore", title: "Chores" },
  { type: "other", title: "Other Changes" },
];

const HEADER = /^(?:(?<type>[a-zA-Z]+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?:\s+)?(?<subject>.+)$/;
const VERSION_SENTENCE = /\s*The product version is now \d+\.\d+\.\d+\./g;

export function parseReleaseCommit({ hash, header, body = "" }) {
  const match = HEADER.exec(header.trim());
  const type = match?.groups?.type?.toLowerCase();
  const known = SECTIONS.some((section) => section.type === type);
  return {
    hash,
    type: known ? type : "other",
    scope: match?.groups?.scope?.trim() || "",
    breaking: Boolean(match?.groups?.breaking),
    subject: (match?.groups?.subject ?? header).trim(),
    paragraphs: releaseParagraphs(body),
  };
}

export function releaseParagraphs(body) {
  const cleaned = body.replace(VERSION_SENTENCE, "").trim();
  if (!cleaned) return [];
  return cleaned
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export function renderReleaseNotes(commits, { version, previous, repo } = {}) {
  const parsed = commits.map(parseReleaseCommit);
  const lines = ["## What's Changed", ""];
  let wroteChange = false;
  for (const section of SECTIONS) {
    const items = parsed.filter((commit) => commit.type === section.type);
    if (items.length === 0) continue;
    wroteChange = true;
    lines.push(`### ${section.title}`, "");
    for (const commit of items) lines.push(...renderCommit(commit, repo), "");
  }
  if (!wroteChange) {
    lines.push("No user-facing changes were found between these tags.", "");
  }
  if (previous && version && repo) {
    lines.push(
      `**Full Changelog**: https://github.com/${repo}/compare/${previous}...${version}`,
      "",
    );
  }
  lines.push(
    "Unsigned desktop installers: Windows x64/arm64, macOS arm64/x64, Linux x64/arm64 (AppImage, deb, rpm, pacman).",
    "",
  );
  return lines.join("\n");
}

function renderCommit(commit, repo) {
  const scope = commit.scope ? `**${commit.scope}:** ` : "";
  const breaking = commit.breaking ? "BREAKING: " : "";
  const title = `${scope}${breaking}${commit.subject}`;
  const link =
    repo && commit.hash
      ? ` ([${commit.hash.slice(0, 7)}](https://github.com/${repo}/commit/${commit.hash}))`
      : "";
  if (commit.paragraphs.length === 0) return [`- ${title}${link}`];
  const lines = [`#### ${title}${link}`, ""];
  for (const paragraph of commit.paragraphs) lines.push(`- ${paragraph}`);
  return lines;
}

export function readReleaseCommits(from, to, cwd = process.cwd()) {
  const range = from ? `${from}..${to}` : to;
  const raw = execFileSync(
    "git",
    ["log", "--no-merges", "--reverse", range, "--format=%H%x1f%s%x1f%b%x1e"],
    { cwd, encoding: "utf8" },
  );
  return raw
    .split("\u001e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, header, body = ""] = record.split("\u001f");
      return { hash, header, body: body.trim() };
    });
}

export function previousReleaseTag(tag, cwd = process.cwd()) {
  try {
    return execFileSync("git", ["describe", "--tags", "--abbrev=0", `${tag}^`], {
      cwd,
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? "" : process.argv[index + 1];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function writeNotes() {
  const tag = readOption("--tag");
  const repo = readOption("--repo");
  const out = resolve(readOption("--out"));
  const cwd = process.cwd();
  const previous = previousReleaseTag(tag, cwd);
  const notes = renderReleaseNotes(readReleaseCommits(previous, tag, cwd), {
    version: tag,
    previous,
    repo,
  });
  writeFileSync(out, notes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeNotes();
}
