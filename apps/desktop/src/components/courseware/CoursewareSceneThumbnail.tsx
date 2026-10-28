import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CoursewareSceneImageView } from "@pi-desktop/shared";
import { api } from "../../lib/api";

export function CoursewareSceneThumbnail({ sessionId, image, pageNumber }: {
  sessionId: string; image?: CoursewareSceneImageView; pageNumber: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState("");
  const [failed, setFailed] = useState(false);
  const { t } = useTranslation();
  useEffect(() => {
    let disposed = false;
    setSrc(""); setFailed(false);
    if (!image?.asset || !ref.current) return;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void api.coursewareSceneImagePreview(sessionId, image.intentId).then(value => {
        if (!disposed) setSrc(value.dataUrl);
      }).catch(() => { if (!disposed) setFailed(true); });
    });
    observer.observe(ref.current);
    return () => { disposed = true; observer.disconnect(); };
  }, [sessionId, image?.intentId, image?.asset?.sha256]);
  return <span ref={ref} className="courseware-scene-thumbnail" aria-hidden="true" title={failed ? t("coursewareWorkflow.previewLoadFailed") : undefined}>
    {src ? <img src={src} alt="" loading="lazy" /> : <span>{String(pageNumber).padStart(2, "0")}</span>}
  </span>;
}
