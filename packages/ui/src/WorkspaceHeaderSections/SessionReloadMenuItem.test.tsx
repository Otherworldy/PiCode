import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { SessionReloadMenuItem } from "./SessionReloadMenuItem.js";

const menuItem = vi.hoisted(() => ({ onSelect: undefined as (() => void) | undefined }));

vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenuItem: ({
    disabled,
    children,
    onSelect,
  }: {
    disabled: boolean;
    children: React.ReactNode;
    onSelect?: () => void;
  }) => {
    menuItem.onSelect = onSelect;
    return (
      <button role="menuitem" disabled={disabled}>
        {children}
      </button>
    );
  },
}));

const available: ComponentProps<typeof SessionReloadMenuItem> = {
  sessionId: "session",
  readOnly: false,
  busy: false,
  pending: false,
  onReload: () => {},
};
function render(overrides: Partial<typeof available> = {}) {
  return renderToStaticMarkup(
    <ZCodeIntlProvider>
      <SessionReloadMenuItem {...available} {...overrides} />
    </ZCodeIntlProvider>,
  );
}

describe("SessionReloadMenuItem", () => {
  it("offers a visible named action for an idle current session", () => {
    const html = render();
    expect(html).toContain("重载当前会话");
    expect(html).not.toContain('disabled=""');
  });
  it.each([
    { sessionId: null },
    { readOnly: true },
    { busy: true },
    { pending: true },
    { onReload: undefined },
  ])("disables unavailable session actions: %j", (props) => {
    expect(render(props)).toContain('disabled=""');
  });
  it("passes the selected session id and ignores selection after it disappears", () => {
    const onReload = vi.fn();
    render({ onReload });
    menuItem.onSelect?.();
    expect(onReload).toHaveBeenCalledWith("session");

    render({ sessionId: null });
    menuItem.onSelect?.();
    expect(onReload).toHaveBeenCalledTimes(1);
  });
  it("shows the progress icon while pending", () => {
    expect(render({ pending: true })).toContain("animate-spin");
  });
});
