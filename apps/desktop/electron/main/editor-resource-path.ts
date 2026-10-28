import { resolve, sep } from "node:path";

/** URL input is untrusted even when the caller is the embedded editor. */
export function editorResourcePath(root: string, pathname: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (!decoded.startsWith("/") || /[\\\0]/.test(decoded) || decoded.split("/").some(part => part === "." || part === "..")) return null;
  const file = resolve(root, `.${decoded === "/editor" ? "/editor.html" : decoded}`);
  return file.startsWith(resolve(root) + sep) ? file : null;
}
