import assert from "node:assert/strict";
import test from "node:test";
import { validateOfficeBytes, officeSaveExtension } from "../electron/main/office-file.ts";
import { getOfficeExtension, OFFICE_FORMATS } from "@pi-desktop/shared";

test("WiseOffice format selection respects filenames and attachment MIME", () => {
  for (const [ext, format] of Object.entries(OFFICE_FORMATS)) {
    assert.equal(getOfficeExtension(`C:\\docs\\report.${ext.toUpperCase()}`), ext);
    assert.equal(getOfficeExtension("attachments/hash", format.mime), ext);
    assert.equal(officeSaveExtension(ext), format.saveExt);
  }
  assert.equal(getOfficeExtension("code.ts", "text/plain"), null);
  assert.equal(getOfficeExtension("unknown"), null);
});

test("document validation rejects wrong package types and malformed input", () => {
  assert.throws(() => validateOfficeBytes(Buffer.from("PK[Content_Types].xmlword/document.xml"), "pptx"), /Invalid/);
  assert.throws(() => validateOfficeBytes(Buffer.from("bad"), "pdf"), /Invalid/);
  assert.throws(() => validateOfficeBytes(Buffer.from("bad"), "doc"), /Invalid/);
  assert.throws(() => validateOfficeBytes(Buffer.alloc(0), "docx"), /size/);
  assert.throws(() => validateOfficeBytes(Buffer.from([0, 1]), "txt"), /Invalid/);
  assert.equal(validateOfficeBytes(Buffer.from("%PDF-1.7"), "pdf").toString(), "%PDF-1.7");
  assert.equal(validateOfficeBytes(Buffer.from("{\\rtf1 hello}"), "rtf").toString(), "{\\rtf1 hello}");
  assert.equal(validateOfficeBytes(Buffer.alloc(0), "txt").length, 0);
  assert.equal(validateOfficeBytes(Buffer.from([0xff, 0xfe, 0x61, 0]), "txt").length, 4);
});
