import {
  ErrorCodes as SharedErrorCodes,
  DECKWISE_MANAGED_BASE_URL,
  DECKWISE_MANAGED_MODEL_ID,
  DECKWISE_MANAGED_PROVIDER_ID,
  DECKWISE_DEFAULT_CONTEXT_WINDOW,
  OAUTH_AUTH_KIND,
  THINKING_LEVELS,
  defaultCommandShellForPlatform,
  isCommandShellId,
  modelIdsMatch,
  resolveBindingContextWindow,
  validateNetworkProxy,
  validateSpeechSettings,
  validateManagedContextWindow,
  type CommandShellId,
  type ModelBinding,
  type ThinkingLevel,
} from "@pi-desktop/shared";
import {
  capabilitiesFromModelConfig,
  genericModelConfig,
  modelConfigWithBinding,
  visionFromModelConfig,
  type ThinkingCapabilities,
} from "@pi-desktop/agent-runtime";
import type { HostProcess } from "../host-process";
import {
  modelConfigFromModelsDev,
  type ModelsDevCatalog,
} from "../models-dev-catalog";

const ErrorCodes = {
  ...SharedErrorCodes,
  COMMAND_SHELL_INVALID: "COMMAND_SHELL_INVALID",
} as const;

const MANAGED_MAX_TOKENS = 32_768;
const MANAGED_THINKING_LEVELS = ["off", "low", "medium", "high"] as const;

export type RuntimeProvider = {
  id: string;
  name: string;
  vendorKey?: string;
  baseUrl?: string;
  modelId?: string;
  models?: ModelBinding[];
  defaultModelId?: string;
  apiKey?: string;
  authKind?: string;
  apiStyle?: string;
  /** Plugin-owned trusted agent key; no host secret is associated with it. */
  extensionAgentKey?: string;
  hasSecret?: boolean;
  hasOauth?: boolean;
  oauthAccountLabel?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  supportsVision?: boolean;
};

export type RuntimeSession = {
  providerId?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
};

export type SessionCapabilityDefaults = {
  defaultProviderId?: string;
  defaultModelId?: string;
};

export type ProviderCatalogRuntimeDependencies = {
  getHost: () => HostProcess | null;
  modelsDevCatalog: ModelsDevCatalog;
  resolvePlatformAccessToken: () => Promise<string>;
};

export function createProviderCatalogRuntime({
  getHost,
  modelsDevCatalog,
  resolvePlatformAccessToken = async () => "",
}: ProviderCatalogRuntimeDependencies) {
  const managedBaseUrl = () => {
    const value = process.env.DECKWISE_LLM_BASE_URL?.trim() || DECKWISE_MANAGED_BASE_URL;
    const url = new URL(value);
    if (!url.pathname || url.pathname === "/") url.pathname = "/v1";
    return url.toString().replace(/\/$/, "");
  };
  const managedModelId =
    process.env.DECKWISE_LLM_MODEL?.trim() || DECKWISE_MANAGED_MODEL_ID;
  const managedImageModelId =
    process.env.DECKWISE_IMAGE_MODEL?.trim() || "doubao-seedream-5-0-pro";
  const managedProvider: RuntimeProvider = {
    id: DECKWISE_MANAGED_PROVIDER_ID,
    name: "DeckWise AI",
    vendorKey: "deckwise",
    enabled: true,
    authKind: OAUTH_AUTH_KIND,
    hasOauth: true,
    // The managed gateway uses the OpenAI Responses API as its canonical
    // conversation transport.
    apiStyle: "responses",
    defaultModelId: managedModelId,
    models: [
      {
        id: managedModelId,
        alias: "DeckWise AI",
        contextWindow: DECKWISE_DEFAULT_CONTEXT_WINDOW,
        maxTokens: MANAGED_MAX_TOKENS,
        supportsImages: true,
        thinkingLevels: [...MANAGED_THINKING_LEVELS],
        defaultThinkingLevel: "off",
      },
    ],
  };
  const managedModels = async (): Promise<ModelBinding[]> => {
    let token = "";
    try {
      token = await resolvePlatformAccessToken();
    } catch {
      return managedProvider.models ?? [];
    }
    if (!token) return managedProvider.models ?? [];
    try {
      const response = await fetch(`${managedBaseUrl()}/models`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return managedProvider.models ?? [];
      const payload = (await response.json()) as {
        data?: Array<{ id?: unknown }>;
      };
      const models = (payload.data ?? [])
        .flatMap((item): ModelBinding[] => {
          const id = typeof item.id === "string" ? item.id.trim() : "";
          if (!id || modelIdsMatch(id, managedImageModelId)) return [];
          return [{
            id,
            // llm-ha's public model id is the stable alias selected by the
            // administrator; upstream deployment names stay server-side.
            alias: id,
            contextWindow: DECKWISE_DEFAULT_CONTEXT_WINDOW,
            maxTokens: MANAGED_MAX_TOKENS,
            supportsImages: true,
            thinkingLevels: [...MANAGED_THINKING_LEVELS],
            defaultThinkingLevel: "off",
          }];
        });
      return models.length > 0 ? models : managedProvider.models ?? [];
    } catch {
      return managedProvider.models ?? [];
    }
  };
  const bindingForModel = (
    provider: Pick<RuntimeProvider, "models">,
    modelId: string,
  ): ModelBinding | undefined =>
    provider.models?.find((binding) => modelIdsMatch(binding.id, modelId));

  const modelsDevModelFor = (provider: RuntimeProvider, modelId: string) =>
    modelsDevCatalog.findModel({
      vendorKey: provider.vendorKey,
      baseUrl: provider.baseUrl,
      modelId,
    });

  /**
   * Apply the exact provider/model binding before exposing a model to a
   * subagent. The catalog supplies the baseline, but an explicit binding owns
   * the effective thinking capability for the endpoint.
   */
  const effectiveSubagentModelConfig = (
    provider: Pick<RuntimeProvider, "models">,
    modelId: string,
    catalogModelConfig: Parameters<typeof modelConfigWithBinding>[0],
  ) => {
    const resolved = resolveBindingContextWindow(
      catalogModelConfig,
      bindingForModel(provider, modelId),
    );
    const modelConfig = modelConfigWithBinding(
      resolved.catalogConfig,
      resolved.binding,
    );
    return {
      modelConfig,
      capabilities: capabilitiesFromModelConfig(modelConfig),
    };
  };

  const enrichProvider = <T extends RuntimeProvider>(
    provider: T,
    selectedModelId?: string,
  ): T & ThinkingCapabilities & { supportsVision: boolean } => {
    const modelId =
      selectedModelId ||
      provider.modelId ||
      provider.models?.[0]?.id ||
      provider.defaultModelId ||
      "";
    const storedModel = bindingForModel(provider, modelId);
    const modelsDevModel = modelsDevModelFor(provider, modelId);
    const resolved = resolveBindingContextWindow(
      modelsDevModel
        ? modelConfigFromModelsDev(modelsDevModel, provider.baseUrl)
        : genericModelConfig(modelId, provider.baseUrl ?? ""),
      storedModel,
    );
    const modelConfig = modelConfigWithBinding(
      resolved.catalogConfig,
      resolved.binding,
    );
    const models = provider.models?.map((binding) => {
      const catalogModel = modelsDevModelFor(provider, binding.id);
      if (!catalogModel) return binding;
      const bindingResolved = resolveBindingContextWindow(
        modelConfigFromModelsDev(catalogModel, provider.baseUrl),
        binding,
      );
      const effective = modelConfigWithBinding(
        bindingResolved.catalogConfig,
        bindingResolved.binding,
      );
      return {
        ...binding,
        contextWindow: effective.contextWindow,
        maxTokens: effective.maxTokens,
        // An inherited window keeps its catalog provenance on the exposed row,
        // so saving this form cannot freeze a models.dev value into a snapshot
        // of its own.
        ...(bindingResolved.binding.contextWindowSource
          ? { contextWindowSource: bindingResolved.binding.contextWindowSource }
          : {}),
      };
    });
    return {
      ...provider,
      ...(models ? { models } : {}),
      ...(modelsDevModel
        ? {
            contextWindow: modelConfig.contextWindow,
            maxOutputTokens: modelConfig.maxTokens,
          }
        : {}),
      ...capabilitiesFromModelConfig(modelConfig),
      supportsVision: visionFromModelConfig(modelConfig),
    };
  };

  const normalizeThinkingLevel = (value: unknown): ThinkingLevel =>
    typeof value === "string" &&
    (THINKING_LEVELS as readonly string[]).includes(value)
      ? (value as ThinkingLevel)
      : "off";

  const normalizeSettings = <T>(
    settings: T,
  ): T & {
    defaultCommandShell: CommandShellId;
    defaultProviderId: string;
    defaultModelId: string;
  } => {
    const value = (
      settings && typeof settings === "object" ? settings : {}
    ) as T & {
      defaultCommandShell?: unknown;
      defaultProviderId?: unknown;
      defaultModelId?: unknown;
    };
    const hasDefaultProvider =
      typeof value.defaultProviderId === "string" && value.defaultProviderId.length > 0;
    return {
      ...(value as T),
      defaultProviderId: hasDefaultProvider
        ? value.defaultProviderId as string
        : DECKWISE_MANAGED_PROVIDER_ID,
      defaultModelId:
        typeof value.defaultModelId === "string" && value.defaultModelId
          ? value.defaultModelId
          : hasDefaultProvider
            ? ""
            : managedModelId,
      defaultCommandShell: isCommandShellId(value.defaultCommandShell)
        ? value.defaultCommandShell
        : defaultCommandShellForPlatform(process.platform),
    } as T & {
      defaultCommandShell: CommandShellId;
      defaultProviderId: string;
      defaultModelId: string;
    };
  };

  const validateSettingsWrite = <T>(settings: T): T => {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      return settings;
    }
    const value = settings as T & {
      defaultCommandShell?: unknown;
      networkProxy?: unknown;
      managedContextWindow?: unknown;
    };
    if (value.managedContextWindow !== undefined) {
      try {
        validateManagedContextWindow(value.managedContextWindow);
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
    }
    if (
      Object.prototype.hasOwnProperty.call(value, "defaultCommandShell") &&
      !isCommandShellId(value.defaultCommandShell)
    ) {
      throw Object.assign(new Error("defaultCommandShell is invalid"), {
        errorCode: ErrorCodes.COMMAND_SHELL_INVALID,
      });
    }
    if (Object.prototype.hasOwnProperty.call(value, "networkProxy")) {
      const proxy = validateNetworkProxy(value.networkProxy);
      if (!proxy.ok) {
        throw Object.assign(new Error(proxy.error), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      value.networkProxy = proxy.value;
    }
    if (Object.prototype.hasOwnProperty.call(value, "speech")) {
      (value as T & { speech?: unknown }).speech = validateSpeechSettings(
        (value as { speech?: unknown }).speech,
      );
    }
    return settings;
  };

  const listRuntimeProviders = async (includeDisabled = true) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const result = await host.call<{ providers: RuntimeProvider[] }>(
      "providers.list",
      { includeDisabled },
    );
    await modelsDevCatalog.ensureLoaded();
    const [discoveredModels, settings] = await Promise.all([
      managedModels(),
      host.call<{ managedContextWindow?: number }>("settings.get"),
    ]);
    const contextWindow = validateManagedContextWindow(settings?.managedContextWindow);
    const models = discoveredModels.map((model) => ({
      ...model,
      contextWindow,
      ...(settings?.managedContextWindow !== undefined
        ? { contextWindowSource: "user" as const }
        : {}),
    }));
    return [
      {
        ...managedProvider,
        baseUrl: managedBaseUrl(),
        defaultModelId: models[0]?.id ?? managedModelId,
        models,
      },
      ...result.providers,
    ];
  };

  const enrichProviderList = async <T extends RuntimeProvider>(result: {
    providers: T[];
  }) => {
    await modelsDevCatalog.ensureLoaded();
    return {
      ...result,
      providers: result.providers.map((provider) => enrichProvider(provider)),
    };
  };

  const loadSessionCapabilityDefaults =
    async (): Promise<SessionCapabilityDefaults> => {
      const host = getHost();
      if (!host) return {};
      try {
        const settings = await host.call<SessionCapabilityDefaults>("settings.get");
        return {
          defaultProviderId: settings?.defaultProviderId,
          defaultModelId: settings?.defaultModelId,
        };
      } catch {
        return {};
      }
    };

  const sessionCapabilityContext = async () => {
    const [providers, defaults] = await Promise.all([
      listRuntimeProviders(),
      loadSessionCapabilityDefaults(),
    ]);
    return { providers, defaults };
  };

  const resolveSessionCapabilityTarget = (
    session: RuntimeSession,
    providers: readonly RuntimeProvider[],
    defaults?: SessionCapabilityDefaults,
  ): { provider: RuntimeProvider; modelId: string } | null => {
    const pinnedProvider = session.providerId
      ? providers.find((item) => item.id === session.providerId)
      : undefined;
    const provider =
      pinnedProvider ||
      (defaults?.defaultProviderId
        ? providers.find((item) => item.id === defaults.defaultProviderId)
        : undefined);
    if (!provider) return null;
    const pinnedModelId =
      pinnedProvider && session.modelId ? session.modelId : undefined;
    const inheritedModelId =
      provider.id === defaults?.defaultProviderId
        ? defaults.defaultModelId
        : undefined;
    const modelId =
      pinnedModelId ||
      inheritedModelId ||
      provider.models?.[0]?.id ||
      provider.defaultModelId;
    if (!modelId) return null;
    return { provider, modelId };
  };

  const enrichSession = <T extends RuntimeSession>(
    session: T,
    providers: readonly RuntimeProvider[],
    defaults?: SessionCapabilityDefaults,
  ): T & ThinkingCapabilities & { supportsVision: boolean } => {
    const target = resolveSessionCapabilityTarget(session, providers, defaults);
    if (!target) {
      return {
        ...session,
        supportsReasoning: false,
        supportsVision: false,
        supportedThinkingLevels: ["off"],
      };
    }
    const { provider, modelId } = target;
    const catalogModel = modelsDevModelFor(provider, modelId);
    const resolved = resolveBindingContextWindow(
      catalogModel
        ? modelConfigFromModelsDev(catalogModel, provider.baseUrl)
        : genericModelConfig(modelId, provider.baseUrl ?? ""),
      bindingForModel(provider, modelId),
    );
    const modelConfig = modelConfigWithBinding(
      resolved.catalogConfig,
      resolved.binding,
    );
    return {
      ...session,
      ...capabilitiesFromModelConfig(modelConfig),
      supportsVision: visionFromModelConfig(modelConfig),
    };
  };

  return {
    bindingForModel,
    modelsDevModelFor,
    effectiveSubagentModelConfig,
    enrichProvider,
    normalizeThinkingLevel,
    normalizeSettings,
    validateSettingsWrite,
    listRuntimeProviders,
    enrichProviderList,
    sessionCapabilityContext,
    enrichSession,
  };
}
