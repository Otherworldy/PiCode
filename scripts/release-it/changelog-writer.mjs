import createConventionalCommitsPreset from "conventional-changelog-conventionalcommits";

// 分组标题用中文：CHANGELOG 正文是中文，英文 section 名夹在中文条目之间会打断阅读。
// 顺序按读者的关心程度排：新功能 → 问题修复 → 性能 → 重构 → 文档 → 杂项。
export const RELEASE_CHANGELOG_TYPES = [
  { type: "feat", section: "新功能" },
  { type: "fix", section: "问题修复" },
  { type: "perf", section: "性能优化" },
  { type: "refactor", section: "重构" },
  { type: "docs", section: "文档" },
  { type: "chore", section: "杂项" },
  { type: "", section: "其他变更" },
];

export const RELEASE_CHANGELOG_PARSER_OPTS = {
  headerPattern: /^(?:(\w+)(?:\(([^)]*)\))?:\s+)?(.+)$/,
  breakingHeaderPattern: /^(\w+)(?:\(([^)]*)\))?!:\s+(.+)$/,
  headerCorrespondence: ["type", "scope", "subject"],
};

/**
 * 从提交正文提取条目。
 *
 * 正文里的长条目会折行，折行部分有缩进但不带列表符号。只认 `- ` 开头的行会把续行丢掉，
 * changelog 里的条目于是被截断成半句（"12 个工作流工具（CreateWorkflow / AmendWorkflow /"）。
 * 因此把带缩进的行接回上一个条目；顶格的段落（如「修复原因」说明）不属于这个列表，直接跳过。
 */
export function extractCommitBodyBullets(body) {
  if (typeof body !== "string" || body.trim() === "") {
    return [];
  }

  const bullets = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (/^BREAKING[ -]CHANGE:/i.test(line)) {
      continue;
    }
    const bullet = line.match(/^[-*+]\s+(.+?)\s*$/)?.[1]?.trim();
    if (bullet) {
      bullets.push(bullet);
      continue;
    }
    if (bullets.length > 0 && /^\s/.test(rawLine)) {
      bullets[bullets.length - 1] = joinContinuation(bullets[bullets.length - 1], line);
    }
  }
  return bullets;
}

const CJK_CHARACTER = /[\u4e00-\u9fff]/;
const CJK_PUNCTUATION = /[。，、；：！？」』】）]/;
const LATIN_WORD_START = /^[A-Za-z0-9`$@]/;

/**
 * 拼接折行时按中英混排决定要不要插入空格：
 * 中文标点后直接接；中文后接西文单词需要空格（“删除sea-bundled”读不通）；
 * 西文结尾则总是插空格。
 */
function joinContinuation(previous, next) {
  const lastCharacter = previous.slice(-1);
  if (CJK_PUNCTUATION.test(lastCharacter)) {
    return `${previous}${next}`;
  }
  if (CJK_CHARACTER.test(lastCharacter)) {
    return LATIN_WORD_START.test(next) ? `${previous} ${next}` : `${previous}${next}`;
  }
  return `${previous} ${next}`;
}

export function createReleaseChangelogWriterOpts() {
  const preset = createConventionalCommitsPreset({
    types: RELEASE_CHANGELOG_TYPES,
  });
  const baseWriter = preset.writer;
  const baseTransform = baseWriter.transform;

  return {
    ...baseWriter,
    // 主条目用 `*`，正文条目用缩进 `-`：符号不同，纯文本阅读时层级一眼可分。
    // scope 用 `**scope**`（不加冒号），中文条目里读起来更顺。
    commitPartial: `*{{#if scope}} **{{scope}}**{{/if}} {{#if subject}}{{subject}}{{else}}{{header}}{{/if}}{{#if hash}} {{#if @root.linkReferences}}([{{shortHash}}]({{@root.host}}/{{@root.owner}}/{{@root.repository}}/commit/{{hash}})){{else}}{{shortHash}}{{/if}}{{/if}}{{#if references}}, closes{{#each references}} {{#if @root.linkReferences}}[{{#if this.owner}}{{this.owner}}/{{/if}}{{this.repository}}{{this.prefix}}{{this.issue}}]({{issueUrlFormat}}){{else}}{{#if this.owner}}{{this.owner}}/{{/if}}{{this.repository}}{{this.prefix}}{{this.issue}}{{/if}}{{/each}}{{/if}}
{{#if bodyBullets}}{{#each bodyBullets}}  - {{this}}
{{/each}}{{/if}}
`,
    transform(commit, context) {
      const transformed = baseTransform(commit, context);
      if (!transformed) {
        return transformed;
      }

      const bodyBullets = extractCommitBodyBullets(commit.body);
      if (bodyBullets.length === 0) {
        return transformed;
      }

      return {
        ...transformed,
        bodyBullets,
      };
    },
  };
}
