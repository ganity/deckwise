import DOMPurify from 'dompurify';

/** PPTX rich text remains formatted, but cannot navigate, fetch or execute in Desktop. */
export function sanitizeSlideHtml(html: string): string {
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'link', 'iframe', 'object', 'embed', 'video', 'audio', 'img'],
    FORBID_ATTR: ['href', 'src', 'srcset', 'action', 'formaction', 'id', 'name'],
  });
  for (const element of fragment.querySelectorAll<HTMLElement>('[style]')) {
    for (const property of Array.from(element.style)) {
      if (/url\s*\(|expression\s*\(|@import/i.test(element.style.getPropertyValue(property)))
        element.style.removeProperty(property);
    }
  }
  const container = document.createElement('div');
  container.append(fragment);
  return container.innerHTML;
}
