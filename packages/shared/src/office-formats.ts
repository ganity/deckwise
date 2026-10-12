/** Formats supported by WiseOffice's DOCUMENT_TYPE_MAP, not the vendor export catalog. */
export const OFFICE_FORMATS = {
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", saveExt: "docx" },
  doc: { mime: "application/msword", saveExt: "docx" },
  odt: { mime: "application/vnd.oasis.opendocument.text", saveExt: "odt" },
  rtf: { mime: "application/rtf", saveExt: "rtf" },
  txt: { mime: "text/plain", saveExt: "txt" },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", saveExt: "xlsx" },
  xls: { mime: "application/vnd.ms-excel", saveExt: "xlsx" },
  ods: { mime: "application/vnd.oasis.opendocument.spreadsheet", saveExt: "ods" },
  csv: { mime: "text/csv", saveExt: "csv" },
  pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", saveExt: "pptx" },
  ppt: { mime: "application/vnd.ms-powerpoint", saveExt: "pptx" },
  odp: { mime: "application/vnd.oasis.opendocument.presentation", saveExt: "odp" },
  pdf: { mime: "application/pdf", saveExt: "pdf" },
} as const;

export type OfficeExtension = keyof typeof OFFICE_FORMATS;

export function getOfficeExtension(path: string, mimeType?: string): OfficeExtension | null {
  const name = path.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  if (dot >= 0) {
    const ext = name.slice(dot + 1).toLowerCase();
    return Object.hasOwn(OFFICE_FORMATS, ext) ? ext as OfficeExtension : null;
  }
  // Content-addressed attachments have no extension; their stored MIME supplies it.
  const mime = mimeType?.split(";")[0]?.trim().toLowerCase();
  return (Object.keys(OFFICE_FORMATS) as OfficeExtension[]).find(ext => OFFICE_FORMATS[ext].mime === mime) ?? null;
}

/** Plain text uses the local text viewer instead of document conversion. */
export function getOfficePreviewExtension(path: string, mimeType?: string): OfficeExtension | null {
  const extension = getOfficeExtension(path, mimeType);
  return extension === "txt" ? null : extension;
}
