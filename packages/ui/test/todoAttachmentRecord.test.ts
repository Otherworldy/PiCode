import assert from "node:assert/strict";
import test from "node:test";
import { todoAttachmentRecord } from "../src/todos/todoAttachmentRecord.ts";

test("clipboard images keep bytes and drop the temp path", () => {
  const pasted = todoAttachmentRecord(
    {
      fileName: "image.png",
      mime: "image/png",
      bytes: 5,
      localPath: "C:/Temp/clipboard.png",
      dataBase64: "aGVsbG8=",
    },
    true,
  );
  assert.equal(pasted?.localPath, undefined);
  assert.equal(pasted?.dataBase64, "aGVsbG8=");

  const picked = todoAttachmentRecord(
    {
      fileName: "shot.png",
      mime: "image/png",
      bytes: 5,
      localPath: "D:/Pictures/shot.png",
      dataBase64: "bm8=",
    },
    false,
  );
  assert.equal(picked?.localPath, "D:/Pictures/shot.png");
  assert.equal(picked?.dataBase64, undefined);
  assert.equal(
    todoAttachmentRecord({ fileName: "", mime: "", bytes: 0, dataBase64: "" }, true),
    null,
  );
});
