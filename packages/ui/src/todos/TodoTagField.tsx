import {
  useRef,
  useState,
  type CompositionEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { X } from "lucide-react";
import { MAX_TODO_TAGS, normalizeTodoTags, splitTodoTagDraft } from "@zcode/shared";

function isComposingInput(event: Event): boolean {
  return "isComposing" in event && event.isComposing === true;
}

export function TodoTagField({
  tags,
  suggestions,
  onChange,
}: {
  tags: string[];
  suggestions: string[];
  onChange: (tags: string[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  // Safari 组字结束才派发确认键，且 isComposing 已是 false。锁住这一拍，避免选词回车被当成添加。
  const ignoreConfirmKey = useRef(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const full = tags.length >= MAX_TODO_TAGS;
  const pending = text.trim().toLocaleLowerCase();
  const matches = suggestions
    .filter(
      (tag) =>
        !tags.some((current) => current.toLocaleLowerCase() === tag.toLocaleLowerCase()) &&
        (!pending || tag.toLocaleLowerCase().includes(pending)),
    )
    .slice(0, 8);

  function add(raw: string) {
    const parts = splitTodoTagDraft(raw);
    if (parts.length === 0) {
      setText("");
      setError(null);
      return;
    }
    try {
      onChange(normalizeTodoTags([...tags, ...parts]));
      setText("");
      setError(null);
    } catch (cause) {
      setText(raw);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const ime = composing.current || event.nativeEvent.isComposing || ignoreConfirmKey.current;
    if (event.key === "Enter") {
      event.preventDefault();
      if (!ime && text.trim() && !full) add(text);
      return;
    }
    if (ime) return;
    if (event.key === "Backspace" && text === "" && tags.length > 0) {
      event.preventDefault();
      onChange(tags.slice(0, -1));
      setError(null);
    }
  }

  function onCompositionEnd(event: CompositionEvent<HTMLInputElement>) {
    composing.current = false;
    ignoreConfirmKey.current = true;
    setTimeout(() => {
      ignoreConfirmKey.current = false;
    }, 0);
    const value = event.currentTarget.value;
    if (!full && /[,，]/.test(value)) add(value);
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex min-h-8 w-full cursor-text flex-wrap items-center gap-1 rounded-lg border border-input-border bg-input px-1.5 py-1 transition-colors hover:border-input-border-hover focus-within:border-input-border-focused focus-within:bg-input-focused"
        onMouseDown={(event: MouseEvent<HTMLDivElement>) => {
          const target = event.target as HTMLElement;
          if (target.closest("button, input")) return;
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        {tags.map((tag) => (
          <span
            key={tag.toLocaleLowerCase()}
            className="inline-flex items-center gap-0.5 rounded-md bg-surface px-1.5 py-0.5 text-ui-xs"
          >
            {tag}
            <button
              type="button"
              aria-label={`移除标签 ${tag}`}
              className="text-foreground-subtle hover:text-foreground"
              onClick={() => {
                onChange(tags.filter((current) => current !== tag));
                setError(null);
              }}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={text}
          readOnly={full}
          autoComplete="off"
          aria-label="标签，输入后按回车"
          placeholder={tags.length === 0 ? "标签，回车添加" : ""}
          className="h-6 min-w-16 flex-1 bg-transparent text-ui-sm outline-none placeholder:text-foreground-subtlest"
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            if (text.trim() && !full) add(text);
          }}
          onChange={(event) => {
            const value = event.target.value;
            if (composing.current || isComposingInput(event.nativeEvent)) {
              setText(value);
              return;
            }
            if (full) {
              setText("");
              return;
            }
            if (/[,，]/.test(value)) add(value);
            else {
              setText(value);
              if (error) setError(null);
            }
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={onCompositionEnd}
          onKeyDown={onKeyDown}
        />
      </div>
      {focused && !full && matches.length > 0 ? (
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
