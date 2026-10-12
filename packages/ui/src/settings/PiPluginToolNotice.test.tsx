import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "../i18n/IntlProvider.js";
import { PiPluginToolNotice } from "./PiPluginToolNotice.js";

function renderNotice(tools: { npm: boolean; git: boolean } | null) {
  return renderToStaticMarkup(
    <ZCodeIntlProvider>
      <PiPluginToolNotice tools={tools} />
    </ZCodeIntlProvider>,
  );
}

describe("PiPluginToolNotice", () => {
  it("does not render when both tools are present", () => {
    const html = renderNotice({ npm: true, git: true });
    expect(html).toBe("");
  });

  it("renders notice when tools are missing", () => {
    const html = renderNotice({ npm: false, git: true });
    expect(html).toContain("Node.js");
    expect(html).not.toContain("Git");
  });

  it("renders notice for both missing tools", () => {
    const html = renderNotice({ npm: false, git: false });
    expect(html).toContain("Node.js");
    expect(html).toContain("Git");
    expect(html).toContain("border-amber-500/30");
  });
});
