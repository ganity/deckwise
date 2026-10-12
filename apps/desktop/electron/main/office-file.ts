import { OFFICE_FORMATS, type OfficeExtension } from "@pi-desktop/shared";

export const MAX_OFFICE_BYTES = 256 * 1024 * 1024;

export function validateOfficeBytes(value: Uint8Array, ext: OfficeExtension): Buffer {
  if (value.byteLength > MAX_OFFICE_BYTES || (!value.byteLength && ext !== "txt" && ext !== "csv")) {
    throw new Error("Document size is not allowed (maximum 256 MiB)");
  }
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const zipEntry = { docx: "word/document.xml", xlsx: "xl/workbook.xml", pptx: "ppt/presentation.xml", odt: "content.xml", ods: "content.xml", odp: "content.xml" };
  if (Object.hasOwn(zipEntry, ext)) {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || !bytes.includes(zipEntry[ext as keyof typeof zipEntry])) {
      throw new Error(`Invalid ${ext.toUpperCase()} document package`);
    }
    if (ext.endsWith("x") && !bytes.includes("[Content_Types].xml")) throw new Error("Invalid OOXML package");
  } else if (ext === "doc" || ext === "xls" || ext === "ppt") {
    const ole = bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    const htmlSheet = ext === "xls" && /^\s*(?:<!doctype html|<html|<table)/i.test(bytes.subarray(0, 1024).toString("utf8"));
    if (!ole && !htmlSheet) throw new Error(`Invalid ${ext.toUpperCase()} document`);
  } else if (ext === "pdf" && !bytes.subarray(0, 1024).includes("%PDF-")) {
    throw new Error("Invalid PDF document");
  } else if (ext === "rtf" && !bytes.subarray(0, 16).toString("ascii").startsWith("{\\rtf")) {
    throw new Error("Invalid RTF document");
  } else if ((ext === "txt" || ext === "csv") && bytes.includes(0) && !bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) && !bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    throw new Error("Invalid text document");
  }
  return bytes;
}

export function officeSaveExtension(ext: OfficeExtension): OfficeExtension {
  return OFFICE_FORMATS[ext].saveExt;
}
