import type { PptxInspection } from "@pi-desktop/shared";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

export function PptxInspectionPanel({ enabled, revision }: { enabled: boolean; revision?: number }) {
  const { t } = useTranslation();
  const [check, setCheck] = useState<PptxInspection | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const active = useRef<PptxInspection | null>(null);
  const update = (next: PptxInspection) => { active.current = next; setCheck(next); };

  useEffect(() => {
    ++generation.current;
    active.current = null;
    setCheck(null);
    setStarting(false);
    setError("");
    return () => {
      ++generation.current;
      const current = active.current;
      if (current?.status === "RUNNING") void api.pptEditorInspectCancel(current.checkId).catch(() => {});
    };
  }, [revision]);

  useEffect(() => {
    if (check?.status !== "RUNNING") return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.pptEditorInspectStatus(check.checkId);
        if (!disposed) {
          update(next);
          if (next.status === "RUNNING") timer = setTimeout(poll, 200);
        }
      } catch (error) {
        if (!disposed) {
          setError(String(error));
          update({ ...check, status: "FAILED", message: String(error) });
        }
      }
    };
    timer = setTimeout(poll, 100);
    return () => { disposed = true; clearTimeout(timer); };
  }, [check?.checkId, check?.status]);

  const start = async () => {
    const request = generation.current;
    setStarting(true);
    setError("");
    setCheck(null);
    try {
      const next = await api.pptEditorInspectStart();
      if (generation.current === request) update(next);
      else if (next.status === "RUNNING") await api.pptEditorInspectCancel(next.checkId);
    } catch (error) {
      if (generation.current === request) setError(String(error));
    } finally {
      if (generation.current === request) setStarting(false);
    }
  };
  const cancel = () => {
    if (check?.status === "RUNNING") void api.pptEditorInspectCancel(check.checkId).catch((error) => setError(String(error)));
  };
  const running = starting || check?.status === "RUNNING";

  return (
    <section className="pptx-inspection" aria-label={t("panel.pptEditor.inspectSaved")}>
      <div className="pptx-inspection-actions">
        <button className="btn btn-secondary" type="button" disabled={!enabled || running} onClick={() => void start()}>
          {t("panel.pptEditor.inspectSaved")}
        </button>
        {check?.status === "RUNNING" && <button className="btn btn-secondary" type="button" onClick={cancel}>{t("panel.pptEditor.inspectCancel")}</button>}
        <span>{t("panel.pptEditor.inspectScope")}</span>
      </div>
      {check?.status === "SUCCEEDED" && <p role={check.errorCount > 0 ? "alert" : "status"}>
        {check.errorCount > 0
          ? t("panel.pptEditor.inspectContentErrors", { count: check.errorCount })
          : t("panel.pptEditor.inspectNoKnownErrors")}
      </p>}
      <div role="status" aria-live="polite">
        {running ? t("panel.pptEditor.inspectRunning") : null}
        {check?.status === "CANCELED" ? t("panel.pptEditor.inspectCanceled") : null}
        {check?.status === "SUCCEEDED" ? t("panel.pptEditor.inspectSummary", { revision: check.revision, pages: check.pages, count: check.warningCount }) : null}
      </div>
      {(error || check?.status === "FAILED") && <div role="alert">{error || (check?.status === "FAILED" ? check.message : "")}</div>}
      {check?.status === "SUCCEEDED" && <details>
        <summary>{t("panel.pptEditor.inspectReport")}</summary>
        <p>{t("panel.pptEditor.inspectLimit")}</p>
        <code>SHA-256: {check.sourceSha256}</code>
        <ul>{check.warnings.map((warning, index) => <li key={index}>
          <strong>{t(`panel.pptEditor.inspectSeverity_${warning.severity}`)}</strong>
          {" · "}{warning.pageIndex === undefined
            ? t("panel.pptEditor.inspectPageUnknown")
            : t("panel.pptEditor.inspectPage", { page: warning.pageIndex + 1 })}
          {" · "}{warning.code}: {warning.message}
        </li>)}</ul>
      </details>}
    </section>
  );
}
