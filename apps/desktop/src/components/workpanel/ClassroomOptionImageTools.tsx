import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import type { ClassroomEditorView, ClassroomImageResult, ClassroomImageSelection } from "../../lib/courseware-classroom";

export function ClassroomOptionImageTools({ sessionId, view, sceneId, questionId, options, disabled, dirty, transport = api, onBusy, onAdopt, onError }: {
  sessionId: string; view: ClassroomEditorView; sceneId: string; questionId: string;
  options: { value: string; label: string }[]; disabled: boolean; dirty: boolean;
  transport?: Pick<typeof api, "coursewareClassroomImageModels" | "coursewareClassroomImageQuote" | "coursewareClassroomImageSubmit" | "coursewareClassroomImageRefresh">;
  onBusy(value: boolean): void; onAdopt(view: ClassroomEditorView): void; onError(error: string): void;
}) {
  const { t } = useTranslation();
  const [models, setModels] = useState<string[]>([]), [model, setModel] = useState("");
  const [optionValue, setOptionValue] = useState(options[0]?.value ?? ""), [running, setRunning] = useState(false);
  const [result, setResult] = useState<ClassroomImageResult>();
  const owner = useRef(0), selected = options.find(option => option.value === optionValue);
  const selectionKey = JSON.stringify([sessionId, view.projectId, view.revision, view.sourceRevision, sceneId, questionId, model, selected]);
  useEffect(() => { ++owner.current; setResult(undefined); return () => { ++owner.current; }; }, [selectionKey]);
  async function loadModels() {
    const generation = owner.current; setRunning(true); onError("");
    try {
      const values = await transport.coursewareClassroomImageModels(sessionId);
      if (generation !== owner.current) return;
      setModels(values); setModel(values[0] ?? "");
    } catch (failure) { if (generation === owner.current) onError(String(failure)); }
    finally { setRunning(false); }
  }
  async function run(kind: "quote" | "submit" | "refresh") {
    if (disabled || dirty || running || !model || !selected?.label.trim() || !view.revision) return;
    const generation = owner.current;
    const input: ClassroomImageSelection = { sessionId, projectId: view.projectId, expectedRevision: view.revision,
      expectedSourceRevision: view.sourceRevision, sceneId, questionId, optionValue, model };
    setRunning(true); onBusy(true); onError("");
    try {
      const next = kind === "quote" ? await transport.coursewareClassroomImageQuote(input) : kind === "refresh" ? await transport.coursewareClassroomImageRefresh(input)
        : await transport.coursewareClassroomImageSubmit({ ...input, quoteId: result?.quote?.quoteId ?? "" });
      if (generation !== owner.current) return;
      setResult(next);
      if (next.view) onAdopt({ ...next.view, resourceUrls: { ...view.resourceUrls, ...next.view.resourceUrls } });
    } catch (failure) { if (generation === owner.current) onError(String(failure)); }
    finally { setRunning(false); onBusy(false); }
  }
  return <details><summary>{t("panel.pptEditor.optionImages", { defaultValue: "生成选项配图" })}</summary>
    <fieldset disabled={disabled || running}>
      <p>{t("panel.pptEditor.optionImagesHint", { defaultValue: "根据已保存的题干与选项文字生成配图；确认报价后开始生成。" })}</p>
      <label>{t("panel.pptEditor.imageOption", { defaultValue: "配图选项" })}<select aria-label={t("panel.pptEditor.imageOption")} value={optionValue} onChange={event => setOptionValue(event.target.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.value}. {option.label}</option>)}</select></label>
      <button onClick={() => void loadModels()}>{t("panel.pptEditor.loadImageModels", { defaultValue: "读取图片模型" })}</button>
      <label>{t("panel.pptEditor.imageModel", { defaultValue: "图片模型" })}<select value={model} onChange={event => setModel(event.target.value)}>{models.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
      <button disabled={dirty || !model || !selected?.label.trim()} onClick={() => void run("quote")}>{t("panel.pptEditor.quoteImage", { defaultValue: "获取配图报价" })}</button>
      {result?.quote && <p>{t("panel.pptEditor.imageQuote", { defaultValue: "本次配图费用上限：{{points}} 积分；有效至 {{expires}}。", points: result.quote.maxPoints, expires: new Date(result.quote.expiresAt).toLocaleString() })}</p>}
      <button disabled={dirty || !result?.quote || Date.parse(result.quote.expiresAt) <= Date.now()} onClick={() => void run("submit")}>{t("panel.pptEditor.generateImage", { defaultValue: "确认报价并生成配图" })}</button>
      <button disabled={dirty || !model} onClick={() => void run("refresh")}>{t("panel.pptEditor.refreshImage", { defaultValue: "刷新并应用配图" })}</button>
      {result && <p role="status">{t("panel.pptEditor.imageStatus", { defaultValue: "配图状态：{{state}}", state: result.state })}{result.task?.errorCode ? ` · ${result.task.errorCode}` : ""}</p>}
    </fieldset>
  </details>;
}
