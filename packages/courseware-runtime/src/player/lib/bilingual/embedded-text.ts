import type { PPTElement, ShapeText, TableCell } from "../types/slides";
import type { BilingualTextRecord } from "../types/bilingual";

export function bilingualEmbeddedHtml(pair: BilingualTextRecord): string {
  const html = (text: string) =>
    text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/\n/g, "<br>");
  return `<p lang="zh-CN" style="font-family:Arial;font-size:20px;line-height:1.5;margin:0">${html(pair.zhText)}</p><p lang="ru" style="font-family:Arial;font-size:20px;line-height:1.5;margin:8px 0 0">${html(pair.ruText)}</p>`;
}

export function bilingualShapeContent(text: ShapeText): string {
  return text.bilingual ? bilingualEmbeddedHtml(text.bilingual) : text.content;
}

export function bilingualCellContent(cell: TableCell): string {
  return cell.bilingual
    ? `${cell.bilingual.zhText}\n${cell.bilingual.ruText}`
    : cell.text;
}

export function embeddedBilingualFields(
  elements: PPTElement[],
  includeEmpty = false,
) {
  return elements.flatMap((element) => {
    if (
      element.type === "shape" &&
      element.text &&
      (includeEmpty || element.text.content.trim() || element.text.bilingual)
    )
      return [
        {
          elementId: element.id,
          cellId: undefined as string | undefined,
          label: "形状文字",
          text: element.text.content,
          pair: element.text.bilingual,
        },
      ];
    if (element.type === "table")
      return element.data.flatMap((row, rowIndex) =>
        row.flatMap((cell, colIndex) =>
          includeEmpty || cell.text.trim() || cell.bilingual
            ? [
                {
                  elementId: element.id,
                  cellId: cell.id,
                  label: `表格第 ${rowIndex + 1} 行第 ${colIndex + 1} 列`,
                  text: cell.text,
                  pair: cell.bilingual,
                },
              ]
            : [],
        ),
      );
    return [];
  });
}
