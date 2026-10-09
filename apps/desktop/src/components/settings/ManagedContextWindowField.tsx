import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { validateManagedContextWindow } from "@pi-desktop/shared";
import { CONTEXT_WINDOW_PRESETS } from "../../lib/model-limit-presets";
import { Button, Input, cx } from "../ui";

export function ManagedContextWindowField({
  value,
  onSave,
}: {
  value: number;
  onSave: (value: number) => Promise<void>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setDraft(String(value)); }, [value]);
  let valid = draft.trim().length > 0;
  try { validateManagedContextWindow(Number(draft)); } catch { valid = false; }

  return (
    <form className="managed-context-window" onSubmit={async (event) => {
      event.preventDefault();
      if (!valid || saving) return;
      setSaving(true);
      setError("");
      try { await onSave(Number(draft)); }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { setSaving(false); }
    }}>
      <label htmlFor={id}>{t("settings.contextWindow")}</label>
      <div className="provider-limit-presets" role="group" aria-label={t("settings.contextWindow")}>
        {CONTEXT_WINDOW_PRESETS.map((preset) => (
          <button key={preset.label} type="button"
            className={cx("provider-thinking-chip", Number(draft) === preset.tokens && "selected")}
            aria-pressed={Number(draft) === preset.tokens} disabled={saving}
            onClick={() => { setDraft(String(preset.tokens)); setError(""); }}>
            {preset.label}
          </button>
        ))}
      </div>
      <div className="managed-context-window-input">
        <Input id={id} type="number" min={1} step={1} required inputMode="numeric"
          value={draft} disabled={saving} aria-describedby={`${id}-hint`}
          aria-invalid={!valid} onChange={(event) => { setDraft(event.target.value); setError(""); }} />
        <Button type="submit" size="sm" disabled={!valid || saving || Number(draft) === value}>
          {t(saving ? "common.saving" : "common.save")}
        </Button>
      </div>
      <p id={`${id}-hint`} className="settings-row-desc">{t("settings.managedContextWindowHint")}</p>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}
