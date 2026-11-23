import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { IconImage } from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";

type Pick = Parameters<typeof api.attachVisualSetting>[1];
export function VisualSettingPicker({ disabled, attach }: { disabled: boolean; attach: (pick: Pick) => Promise<void> }) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [libraries, setLibraries] = useState<Awaited<ReturnType<typeof api.visualSettingLibraries>>>([]);
  const [libraryId, setLibraryId] = useState(0);
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.visualSettingItems>>>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    let current = true;
    dialog.current?.showModal();
    setLibraries([]); setItems(undefined); setLibraryId(0); setError("");
    api.visualSettingLibraries().then(rows => {
      if (current) { setLibraries(rows); setLibraryId(rows[0]?.id ?? 0); if (!rows.length) setItems([]); }
    }).catch(err => { if (current) setError(String(err)); });
    return () => { current = false; };
  }, [open]);
  useEffect(() => {
    if (!open || !libraryId) return;
    let current = true;
    setItems(undefined); setError("");
    api.visualSettingItems(libraryId).then(rows => { if (current) setItems(rows); })
      .catch(err => { if (current) setError(String(err)); });
    return () => { current = false; };
  }, [open, libraryId]);
  const label = t("chat.visualSettings");
  return <><TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={label} ariaLabel={label}
    disabled={disabled} onClick={() => setOpen(true)}><IconImage size={16} aria-hidden="true" /></TooltipButton>
    {open && <dialog ref={dialog} aria-label={label} className="visual-setting-picker" onClose={() => setOpen(false)}>
      <header><strong>{label}</strong><button type="button" autoFocus onClick={() => dialog.current?.close()} aria-label={t("common.close")}>×</button></header>
      {!!libraries.length && <select aria-label={label} value={libraryId} disabled={busy} onChange={event => {
        setItems(undefined); setLibraryId(Number(event.target.value));
      }}>{libraries.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select>}
      {error ? <p role="alert">{error}</p> : items === undefined ? <p role="status">{t("common.loading")}</p> :
        !items.some(item => item.images.length) ? <p>{t("chat.noSettingImages")}</p> :
        items.map(item => <section key={item.id}><h3>{item.name}</h3>{item.description && <p>{item.description}</p>}
          {item.images.map(image => <button type="button" key={image.id} disabled={busy || disabled} onClick={async () => {
            const library = libraries.find(row => row.id === libraryId);
            if (!library) return;
            setBusy(true);
            try { await attach({ libraryId, revision: library.revision, itemId: item.id, imageId: image.id }); dialog.current?.close(); }
            finally { setBusy(false); }
          }}>{image.preview && <img src={image.preview} loading="lazy" referrerPolicy="no-referrer" alt="" />}<span>{image.name}</span></button>)}
        </section>)}
    </dialog>}</>;
}
