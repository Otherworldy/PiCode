import assert from "node:assert/strict";
import test from "node:test";
import { parseReleaseCommit, renderReleaseNotes } from "./release-notes.mjs";

test("groups a release commit by type and turns each paragraph into a change", () => {
  const notes = renderReleaseNotes(
    [
      {
        hash: "317a9a449f9eecd151a5b79fda61ce3029ceb82b",
        header: "fix: keep sessions alive through new tasks, edits, and updates",
        body: [
          "New Task no longer kills running sessions.",
          "",
          "Full access survives a runtime rebuild.",
          "",
          "Pi host packages are now 1.1.0. The product version is now 3.14.8.",
        ].join("\n"),
      },
      {
        hash: "abc1234",
        header: "feat(browser): batch ref snapshots",
        body: "",
      },
    ],
    { version: "v3.14.8", previous: "v3.14.7", repo: "Otherworldy/PiCode" },
  );

  assert.match(notes, /### Features\n\n- \*\*browser:\*\* batch ref snapshots/);
  assert.match(notes, /### Bug Fixes/);
  assert.match(notes, /- New Task no longer kills running sessions\./);
  assert.match(notes, /- Full access survives a runtime rebuild\./);
  assert.match(notes, /- Pi host packages are now 1\.1\.0\./);
  assert.doesNotMatch(notes, /The product version is now/);
  assert.match(
    notes,
    /https:\/\/github\.com\/Otherworldy\/PiCode\/compare\/v3\.14\.7\.\.\.v3\.14\.8/,
  );
  assert.match(notes, /Unsigned desktop installers/);
});

test("a commit without a conventional prefix stays out of Bug Fixes", () => {
  const parsed = parseReleaseCommit({
    hash: "abc",
    header: "update the readme",
    body: "",
  });
  assert.equal(parsed.type, "other");
  assert.equal(parsed.subject, "update the readme");
});
