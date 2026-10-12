import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { api } from "../../apps/desktop/src/lib/api";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { ModelConfigPage } from "../../apps/desktop/src/components/settings/ModelConfigPage";
import type { AppSettings, ProviderPublic } from "@pi-desktop/shared";

declare global { var managedContextProbe: () => Promise<unknown>; }
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

globalThis.managedContextProbe = async () => {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: {
    en: { translation: catalogs.en }, "zh-CN": { translation: catalogs["zh-CN"] },
  }, interpolation: { escapeValue: false } });
  let saved: AppSettings = { defaultMode: "agent", theme: "dark", enterToSend: true,
    onboardingDismissed: true, defaultProviderId: "deckwise-managed" };
  const writes: AppSettings[] = [];
  let fail = false;
  let complete: (() => void) | undefined;
  const provider: ProviderPublic = {
    id: "deckwise-managed", name: "DeckWise AI", vendorKey: "deckwise",
    type: "custom", protocol: "openai_compatible", authKind: "oauth", enabled: true,
    hasOauth: true, hasSecret: false, createdAt: "", updatedAt: "",
    models: [{ id: "fixture", contextWindow: 128_000, maxTokens: 32_768,
      thinkingLevels: ["off"], defaultThinkingLevel: "off" }],
  };
  // Fake only the app API boundary; render the real page, component and store.
  api.modelCatalogStatus = async () => ({ status: { loaded: false, source: "empty",
    catalogPath: "", providerCount: 0, modelCount: 0 } });
  api.getSettings = async () => structuredClone(saved);
  api.listProviders = async () => ({ providers: [provider] });
  api.listSessions = async () => ({ sessions: [] });
  api.getOnboarding = async () => ({ completed: true, checks: [] });
  api.setSettings = async (settings) => {
    try {
      if (fail) throw new Error("fixture save failed");
      writes.push(structuredClone(settings));
      saved = structuredClone(settings);
      return { ok: true };
    } finally { if (fail) queueMicrotask(() => complete?.()); }
  };
  const refresh = useAppStore.getState().refreshProviders;
  useAppStore.setState({ refreshProviders: async () => {
    await refresh();
    complete?.();
  } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let renderKey = 0;
  const render = () => flushSync(() => root.render(
    <I18nextProvider i18n={i18n}><ModelConfigPage key={++renderKey} /></I18nextProvider>));
  const input = () => host.querySelector<HTMLInputElement>(".managed-context-window input")!;
  const click = (element: HTMLElement | null) => {
    check(element, "missing control");
    flushSync(() => element.click());
  };
  const setInput = (value: string) => flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  const submit = async () => {
    const done = new Promise<void>((resolve) => { complete = resolve; });
    flushSync(() => host.querySelector("form.managed-context-window")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await done;
    // Flush state updates queued by the resolved save promise.
    await new Promise<void>((resolve) => requestAnimationFrame(() => { flushSync(() => {}); resolve(); }));
  };
  const scenarios: string[] = [];
  try {
    for (const locale of ["en", "zh-CN"]) {
      saved = { ...saved, managedContextWindow: 128_000 };
      await i18n.changeLanguage(locale);
      await refresh();
      render();
      check(input().value === "128000", "default window missing");
      const field = host.querySelector(".managed-context-window")!;
      check(field.textContent?.includes(i18n.t("settings.managedContextWindowHint")), "hint missing");
      click([...field.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "1M")!);
      check(input().value === "1000000", "preset did not update input");
      await submit();
      check(saved.managedContextWindow === 1_000_000, "save did not reach settings API");
      check(saved.theme === "dark" && saved.defaultMode === "agent", "unrelated settings changed");
      render();
      check(input().value === "1000000", "reopening lost setting");
      setInput("262144"); await submit();
      check(saved.managedContextWindow === 262144, "custom value not persisted");
      const count = writes.length;
      for (const invalid of ["", "0", "-1", "1.5"]) {
        setInput(invalid);
        check(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled,
          `invalid ${invalid} is saveable`);
      }
      check(writes.length === count, "invalid input wrote settings");
      setInput("256000"); fail = true; await submit();
      check(host.querySelector('[role="alert"]')?.textContent === "fixture save failed", "save failure hidden");
      check(saved.managedContextWindow === 262144, "failed save changed setting");
      fail = false;
      setInput("128000"); await submit();
      check(saved.managedContextWindow === 128_000, "restoring default failed");
      scenarios.push(`${locale}:preset-custom-reopen-invalid-failure-default`);
    }
    return { ok: true, scenarios, writes: writes.length, apiBoundary: "stubbed" };
  } finally { flushSync(() => root.unmount()); host.remove(); }
};
