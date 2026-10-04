import { useState } from "react";
import { X } from "lucide-react";
import { normalizeTodoTags } from "@zcode/shared";

export function TodoTagField({
  tags,
  suggestions,
  onChange,
}: {
  tags: string[];
  suggestions: string[];
  onChange: (tags: string[]) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pending = text.trim().toLocaleLowerCase();
  const matches = suggestions
    .filter(
      (tag) =>
        !tags.some((current) => current.toLocaleLowerCase() === tag.toLocaleLowerCase()) &&
        (!pending || tag.toLocaleLowerCase().includes(pending)),
    )
    .slice(0, 8);

  function add(raw: string) {
    try {
      onChange(normalizeTodoTags([...tags, raw]));
      setText("");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag.toLocaleLowerCase()}
            className="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-ui-xs"
          >
            {tag}
            <button
              type="button"
              aria-label={`移除标签 ${tag}`}
              className="text-foreground-subtle hover:text-foreground"
              onClick={() => onChange(tags.filter((current) => current !== tag))}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          value={text}
          placeholder={tags.length === 0 ? "标签，回车添加" : "添加标签"}
          className="h-7 min-w-24 flex-1 bg-transparent text-ui-sm outline-none placeholder:text-foreground-subtlest"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== ",") return;
            event.preventDefault();
            if (text.trim()) add(text);
          }}
          onBlur={() => {
            if (text.trim()) add(text);
          }}
        />
      </div>
      {matches.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {matches.map((tag) => (
            <button
              key={tag.toLocaleLowerCase()}
              type="button"
              className="rounded-full bg-surface px-2 py-0.5 text-ui-xs text-foreground-subtle hover:text-foreground"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => add(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      ) : null}
      {error ? <p className="text-ui-xs text-destructive">{error}</p> : null}
    </div>
  );
}
