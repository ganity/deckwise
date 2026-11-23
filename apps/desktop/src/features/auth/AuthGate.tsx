import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import QRCode from "qrcode";
import type { DesktopAuthState } from "@pi-desktop/shared";
import { BrandLogo } from "../../components/BrandLogo";
import { WindowControls } from "../../components/WindowControls";
import { api } from "../../lib/api";

export function AuthGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [state, setState] = useState<DesktopAuthState>({ status: "restoring" });
  const [qrCodeUrl, setQrCodeUrl] = useState("");
  const [error, setError] = useState("");
  const polling = useRef(false);

  const startLogin = useCallback(async () => {
    setError("");
    setQrCodeUrl("");
    try {
      setState(await api.startQrLogin());
    } catch (reason) {
      setState({ status: "signedOut" });
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    const unsubscribe = api.onAuthChanged((next) => {
      setState(next);
      if (next.status === "signedOut") void startLogin();
    });
    let active = true;
    void api.restoreAuth()
      .then(async (restored) => {
        if (!active) return;
        setState(restored);
        if (restored.status === "signedOut") await startLogin();
      })
      .catch((reason) => {
        if (!active) return;
        setState({ status: "signedOut" });
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [startLogin]);

  useEffect(() => {
    if (state.status !== "waitingForScan") return;
    let active = true;
    void QRCode.toDataURL(state.qrCodeText, {
      width: 264,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#111111", light: "#ffffff" },
    }).then((url) => {
      if (active) setQrCodeUrl(url);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      active = false;
    };
  }, [state]);

  useEffect(() => {
    if (state.status !== "waitingForScan") return;
    const poll = async () => {
      if (polling.current) return;
      polling.current = true;
      try {
        const next = await api.pollQrLogin(state.ticket);
        if (next.status !== "waitingForScan") setState(next);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        polling.current = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => window.clearInterval(timer);
  }, [state]);

  if (state.status === "authenticated") return <Fragment key={state.profile.userId}>{children}</Fragment>;

  const waiting = state.status === "restoring" || state.status === "waitingForScan";
  const message = error || (state.status === "signedOut" ? state.message : "");

  return (
    <main className="auth-shell">
      <div className="auth-titlebar" aria-hidden="true" />
      <WindowControls />
      <section className="auth-panel">
        <div className="auth-intro">
          <div className="auth-brand">
            <span className="auth-brand-mark"><BrandLogo size={42} /></span>
            <span>DeckWise</span>
          </div>
          <span className="auth-edition">{t("auth.educationEdition")}</span>
          <h1>{t("auth.title")}</h1>
          <p>{t("auth.description")}</p>
          <ol className="auth-steps">
            <li><span>1</span>{t("auth.stepOpenWechat")}</li>
            <li><span>2</span>{t("auth.stepScan")}</li>
            <li><span>3</span>{t("auth.stepEnter")}</li>
          </ol>
        </div>
        <div className="auth-qr-column">
          <div className="auth-qr-card">
            <div className="auth-qr-frame" aria-live="polite">
              {qrCodeUrl ? (
                <img src={qrCodeUrl} alt={t("auth.qrAlt")} draggable={false} />
              ) : (
                <span className="auth-qr-loading">{t("common.loading")}</span>
              )}
            </div>
            <strong>{t("auth.scanPrompt")}</strong>
            <p>{waiting ? t("auth.waiting") : message}</p>
          </div>
          {!waiting || message ? (
            <button className="auth-refresh" type="button" onClick={() => void startLogin()}>
              {t("auth.refreshQr")}
            </button>
          ) : null}
        </div>
      </section>
    </main>
  );
}
