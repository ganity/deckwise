import type { TFunction } from "i18next";
import {
  keybindingDisplayParts,
  type ShortcutPlatform,
  type SessionThinkingLevel,
} from "@pi-desktop/shared";
import type { AppState } from "../../../stores/app-store";
import { ContextUsageInspector } from "../../../components/ContextUsageInspector";
import { TooltipButton } from "../../../components/ui";
import {
  IconArrowUp,
  IconGlobe,
  IconPlus,
  IconSparkles,
  IconStop,
  IconUndo2,
} from "../../../components/icons";
import { ComposerModelPicker } from "./ComposerModelPicker";
import type { useComposerModelMenu } from "./hooks/useComposerModelMenu";

type ModelMenuController = ReturnType<typeof useComposerModelMenu>;
type ContextUsage = Parameters<typeof ContextUsageInspector>[0];

export type ComposerToolbarProps = {
  t: TFunction;
  providerId?: string;
  modelId?: string;
  thinkingLevel: SessionThinkingLevel;
  webSearchEnabled: boolean;
  setWebSearchEnabled: (enabled: boolean) => void;
  controlsBlocked: boolean;
  pasting: boolean;
  pickAndAttach: () => Promise<void>;
  modelMenu: ModelMenuController;
  modelLabel: string;
  thinkingLabel: string;
  contextUsage: ContextUsage | null;
  enhancementDraft: string;
  value: string;
  modelReady: boolean;
  sendBlocked: boolean;
  enhancingPrompt: boolean;
  enhancementUndoText: string | null;
  enhancePrompt: () => Promise<void>;
  undoPromptEnhancement: () => void;
  clearEnhancementError: () => void;
  runActive: boolean;
  hasDraftContent: boolean;
  abort: AppState["abort"];
  submit: () => Promise<void>;
};

/** Composer controls: attachments, web search, model, enhancement, and send/stop. */
export function ComposerToolbar({
  t,
  providerId,
  modelId,
  thinkingLevel,
  webSearchEnabled,
  setWebSearchEnabled,
  controlsBlocked,
  pasting,
  pickAndAttach,
  modelMenu,
  modelLabel,
  thinkingLabel,
  contextUsage,
  enhancementDraft,
  value,
  modelReady,
  sendBlocked,
  enhancingPrompt,
  enhancementUndoText,
  enhancePrompt,
  undoPromptEnhancement,
  clearEnhancementError,
  runActive,
  hasDraftContent,
  abort,
  submit,
}: ComposerToolbarProps) {
  const platform = (window.piDesktop?.platform ?? "darwin") as ShortcutPlatform;
  const steeringShortcut = keybindingDisplayParts("Alt+Enter", platform).join("+");
  return (
    <div className="composer-toolbar">
      <div className="composer-left">
        <div className="composer-plus">
          <TooltipButton
            type="button"
            className="icon-btn icon-btn-square"
            tooltip={t("chat.addFiles")}
            ariaLabel={t("chat.addFiles")}
            disabled={controlsBlocked || pasting}
            onClick={() => {
              void pickAndAttach();
            }}
          >
            <IconPlus size={15} aria-hidden="true" />
          </TooltipButton>
        </div>
        <TooltipButton
          type="button"
          className={`icon-btn mode-chip composer-web-search${webSearchEnabled ? " active" : ""}`}
          tooltip={t("chat.webSearchDescription")}
          ariaLabel={t("chat.webSearchDescription")}
          aria-pressed={webSearchEnabled}
          disabled={controlsBlocked || runActive}
          onClick={() => setWebSearchEnabled(!webSearchEnabled)}
        >
          <IconGlobe size={14} aria-hidden="true" />
          <span className="text-sm">{t("chat.webSearch")}</span>
        </TooltipButton>
      </div>

      <div className="composer-right">
        {contextUsage ? <ContextUsageInspector {...contextUsage} /> : null}
        <ComposerModelPicker
          t={t}
          controller={modelMenu}
          modelLabel={modelLabel}
          thinkingLabel={thinkingLabel}
          thinkingLevel={thinkingLevel}
          selectedProviderId={providerId}
          selectedModelId={modelId}
          controlsBlocked={controlsBlocked}
          onCloseOtherMenus={() => undefined}
        />
        <TooltipButton
          type="button"
          className={`icon-btn icon-btn-square composer-enhance-btn${enhancingPrompt ? " is-loading" : ""}`}
          tooltip={t("chat.enhancePrompt")}
          ariaLabel={enhancingPrompt ? t("chat.enhancingPrompt") : t("chat.enhancePrompt")}
          aria-busy={enhancingPrompt}
          disabled={
            !enhancementDraft.trim() ||
            enhancementDraft.trim().startsWith("/") ||
            !modelReady ||
            sendBlocked ||
            enhancingPrompt
          }
          onClick={() => void enhancePrompt()}
        >
          {enhancingPrompt ? (
            <>
              <span className="tool-spinner" aria-hidden="true" />
              <span>{t("chat.enhancingPrompt")}</span>
            </>
          ) : (
            <IconSparkles size={15} aria-hidden="true" />
          )}
        </TooltipButton>
        {enhancementUndoText !== null ? (
          <TooltipButton
            type="button"
            className="icon-btn icon-btn-square composer-enhance-undo"
            tooltip={t("chat.undoEnhancement")}
            ariaLabel={t("chat.undoEnhancement")}
            disabled={controlsBlocked}
            onClick={undoPromptEnhancement}
          >
            <IconUndo2 size={15} aria-hidden="true" />
          </TooltipButton>
        ) : null}
        {runActive && !hasDraftContent ? (
          <TooltipButton
            type="button"
            className="stop-btn"
            tooltip={t("chat.stopGenerating")}
            ariaLabel={t("chat.stopGenerating")}
            onClick={() => void abort()}
          >
            <IconStop size={14} />
          </TooltipButton>
        ) : (
          <TooltipButton
            type="button"
            className="send-btn"
            ariaLabel={modelReady ? t("chat.send") : t("settings.addProvider")}
            tooltip={
              runActive
                ? t("chat.sendWhileRunning", { shortcut: steeringShortcut })
                : modelReady
                  ? t("chat.send")
                  : t("settings.addProvider")
            }
            disabled={
              !hasDraftContent ||
              sendBlocked ||
              (!modelReady && !value.trim().startsWith("/"))
            }
            onClick={() => void submit()}
          >
            <IconArrowUp size={15} />
          </TooltipButton>
        )}
      </div>
    </div>
  );
}
