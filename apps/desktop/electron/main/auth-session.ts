import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { net } from "electron";
import { DECKWISE_MANAGED_BASE_URL } from "@pi-desktop/shared";
import type {
  DesktopAuthDictionaryItem,
  DesktopAuthProfile,
  DesktopAuthState,
  DesktopCoursewareImportInput,
  DesktopCoursewareImportResult,
  DesktopDocumentParseResult,
} from "@pi-desktop/shared";

const DEFAULT_PLATFORM_BASE_URL = "https://trainwise.efrobot.com/api/backend";
const QR_TTL_MS = 5 * 60 * 1000;
const ACCESS_REFRESH_EARLY_MS = 5 * 60 * 1000;
const DESKTOP_REFRESH_PATH = "/auth/desktop/refresh";
const IMAGE_ENV_BEGIN = "# BEGIN DECKWISE MANAGED IMAGE RUNTIME";
const IMAGE_ENV_END = "# END DECKWISE MANAGED IMAGE RUNTIME";
const IMAGE_ENV_KEYS = new Set([
  "IMAGE_BACKEND",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "OPENAI_RESPONSE_FORMAT",
  "OPENAI_QUALITY",
]);

class PlatformRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number) {
    super(message);
  }
}

type ApiEnvelope<T> = {
  code?: number;
  message?: string;
  data?: T;
};

type LoginTokens = {
  accessToken: string;
  refreshToken: string;
};

type PresignedUpload = {
  uploadUrl?: string;
  ossUrl?: string;
  fields?: Record<string, unknown>;
};

type AuthSessionOptions = {
  dataDir: string;
  onChanged: (state: DesktopAuthState) => void;
  log: (level: "info" | "warn", message: string) => void;
};

function platformBaseUrl(): string {
  const value = process.env.DECKWISE_PLATFORM_BASE_URL?.trim() || DEFAULT_PLATFORM_BASE_URL;
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("DeckWise authentication requires HTTPS");
  }
  return url.toString().replace(/\/$/, "");
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dictionaryItems(value: unknown): DesktopAuthDictionaryItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    const itemValue = text(item?.value);
    const label = text(item?.label);
    if (!itemValue || !label) return [];
    return [{
      value: itemValue,
      label,
      ...(Number.isFinite(Number(item?.sort)) ? { sort: Number(item?.sort) } : {}),
      ...(typeof item?.enabled === "boolean" ? { enabled: item.enabled } : {}),
      ...(text(item?.parentValue) ? { parentValue: text(item?.parentValue) } : {}),
    }];
  });
}

function dictionaries(value: unknown): Record<string, DesktopAuthDictionaryItem[]> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result: Record<string, DesktopAuthDictionaryItem[]> = {};
  for (const [key, entries] of Object.entries(value)) {
    const items = dictionaryItems(entries);
    if (items.length > 0) result[key] = items;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function educationProfile(value: unknown): DesktopAuthProfile {
  const profile = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const edition = text(profile.edition).toUpperCase();
  const role = text(profile.role).toUpperCase();
  if (edition !== "EDUCATION" || profile.pcAllowed !== true || role === "STAFF") {
    throw new Error("当前账号无权使用教育版 DeckWise");
  }
  const defaults = profile.generationDefaults && typeof profile.generationDefaults === "object"
    ? profile.generationDefaults as Record<string, unknown>
    : null;
  const detailLevel = text(defaults?.detailLevel);
  return {
    userId: numberValue(profile.userId),
    userName: text(profile.userName),
    avatarUrl: text(profile.avatarUrl) || undefined,
    role,
    tenantId: numberValue(profile.tenantId),
    tenantName: text(profile.tenantName),
    edition: "EDUCATION",
    dictionaries: dictionaries(profile.dictionaries),
    generationDefaults: defaults ? {
      schoolStage: text(defaults.schoolStage) || undefined,
      grade: text(defaults.grade) || undefined,
      subject: text(defaults.subject) || undefined,
      detailLevel:
        detailLevel === "quick" || detailLevel === "detailed"
          ? detailLevel
          : "normal",
    } : undefined,
    workflowProfile: text(profile.workflowProfile) || undefined,
    interactionProfile: text(profile.interactionProfile) || undefined,
  };
}

export class DesktopAuthSession {
  private readonly sessionPath: string;
  private readonly legacySessionPath: string;
  private readonly baseUrl = platformBaseUrl();
  private state: DesktopAuthState = { status: "restoring" };
  private accessToken = "";
  private restoreInFlight: Promise<DesktopAuthState> | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private restoreRetryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: AuthSessionOptions) {
    this.sessionPath = join(options.dataDir, "auth", "session.token");
    this.legacySessionPath = join(options.dataDir, "auth", "session.bin");
  }

  getState(): DesktopAuthState {
    return this.state;
  }

  async resolveAccessToken(): Promise<string> {
    if (this.state.status !== "authenticated" || !this.accessToken) {
      await this.restore();
    }
    if (this.state.status !== "authenticated" || !this.accessToken) {
      throw new Error("登录已过期，请重新扫码");
    }
    if (this.accessTokenExpiresIn() <= ACCESS_REFRESH_EARLY_MS) {
      await this.refreshStoredAccessToken();
    }
    return this.accessToken;
  }

  async restore(): Promise<DesktopAuthState> {
    if (this.state.status === "authenticated") return this.state;
    if (this.restoreInFlight) return this.restoreInFlight;
    const restore = this.restoreStoredSession().finally(() => {
      if (this.restoreInFlight === restore) this.restoreInFlight = null;
    });
    this.restoreInFlight = restore;
    return restore;
  }

  private async restoreStoredSession(): Promise<DesktopAuthState> {
    this.setState({ status: "restoring" });
    try {
      const refreshToken = await this.readRefreshToken();
      if (!refreshToken) return this.setState({ status: "signedOut" });
      await this.refreshAccessToken(refreshToken);
      return this.finishLogin();
    } catch (error) {
      if (this.isUnauthorized(error)) {
        await this.clearStoredSession();
        return this.setState({ status: "signedOut" });
      }
      this.options.log("warn", `desktop auth restore failed: ${String(error)}`);
      this.restoreRetryTimer = setTimeout(() => {
        this.restoreRetryTimer = null;
        void this.restore();
      }, 5000);
      return this.setState({ status: "restoring" });
    }
  }

  async startQrLogin(): Promise<DesktopAuthState> {
    if (this.state.status === "waitingForScan" && Date.now() < this.state.expiresAt) {
      return this.state;
    }
    const payload = await this.request<Record<string, unknown>>(
      "/auth/desktop/wx/qrcode?edition=EDUCATION",
    );
    const ticket = text(payload.ticket);
    const qrCodeText = text(payload.entryUrl);
    if (!ticket || !qrCodeText) throw new Error("登录二维码获取失败");
    return this.setState({
      status: "waitingForScan",
      ticket,
      qrCodeText,
      expiresAt: Date.now() + QR_TTL_MS,
    });
  }

  async pollQrLogin(ticket: string): Promise<DesktopAuthState> {
    if (!ticket || this.state.status !== "waitingForScan" || this.state.ticket !== ticket) {
      throw new Error("登录二维码已失效");
    }
    if (Date.now() >= this.state.expiresAt) {
      return this.setState({ status: "signedOut", message: "二维码已过期，请刷新" });
    }
    const payload = await this.request<Record<string, unknown>>(
      `/auth/wx/poll/${encodeURIComponent(ticket)}`,
    );
    const status = text(payload.status).toUpperCase();
    if (status === "PENDING") return this.state;
    if (status !== "SUCCESS") {
      return this.setState({
        status: "signedOut",
        message: status === "NEED_BIND" ? "账号尚未绑定，请联系管理员" : "二维码已失效，请刷新",
      });
    }
    const tokens: LoginTokens = {
      accessToken: text(payload.accessToken),
      refreshToken: text(payload.refreshToken),
    };
    if (!tokens.accessToken || !tokens.refreshToken) throw new Error("登录结果缺少凭证");
    this.accessToken = tokens.accessToken;
    await this.writeRefreshToken(tokens.refreshToken);
    await this.writeImageRuntime(tokens.accessToken);
    this.scheduleAccessRefresh();
    try {
      return await this.finishLogin();
    } catch (error) {
      this.accessToken = "";
      this.clearRefreshTimer();
      await this.clearStoredSession();
      throw error;
    }
  }

  async logout(): Promise<DesktopAuthState> {
    try {
      if (this.accessToken) {
        await this.request("/auth/logout", {
          method: "POST",
          headers: { Authorization: `Bearer ${this.accessToken}` },
        });
      }
    } catch (error) {
      this.options.log("warn", `desktop auth logout request failed: ${String(error)}`);
    }
    this.accessToken = "";
    this.clearRefreshTimer();
    if (this.restoreRetryTimer) clearTimeout(this.restoreRetryTimer);
    this.restoreRetryTimer = null;
    await this.clearStoredSession();
    await this.writeImageRuntime("");
    return this.setState({ status: "signedOut" });
  }

  async importCourseware(input: DesktopCoursewareImportInput): Promise<DesktopCoursewareImportResult> {
    if (this.state.status !== "authenticated" || !this.accessToken) {
      throw new Error("登录已过期，请重新扫码");
    }
    const title = text(input.title);
    const grade = text(input.grade);
    const subject = text(input.subject);
    const customSubjectName = text(input.customSubjectName);
    if (!title || !grade || !subject) throw new Error("请填写课件名称、年级和学科");
    if (subject === "other" && !customSubjectName) throw new Error("请填写自定义学科");
    if (!(["quick", "normal", "detailed"] as const).includes(input.detailLevel)) {
      throw new Error("讲解词详细程度无效");
    }

    const pptx = await this.uploadLocalFile(input.pptxPath, [".pptx"]);
    const lessonPlan = await this.uploadLocalFile(input.lessonPlanPath, [".pdf", ".doc", ".docx"]);
    const profile = this.state.profile;
    const task = await this.request<DesktopCoursewareImportResult>("/courses/courseware-import-tasks", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.accessToken}` },
      body: JSON.stringify({
        title,
        clientRequestId: `deckwise-${randomUUID()}`,
        description: "",
        category: "NORMAL",
        edition: "EDUCATION",
        sourceMaterial: {
          name: pptx.name,
          fileUrl: pptx.fileUrl,
          source: "upload",
          fileType: "PPT",
          coursewareType: "pptx",
        },
        lessonPlan: {
          name: lessonPlan.name,
          fileUrl: lessonPlan.fileUrl,
          source: "upload",
          fileType: lessonPlan.name.toLowerCase().endsWith(".pdf") ? "PDF" : "WORD",
          coursewareType: extname(lessonPlan.name).slice(1).toLowerCase(),
        },
        referenceImages: [],
        language: "zh-CN",
        narrationMode: "generated",
        parserPreference: "mineru",
        detailLevel: input.detailLevel,
        generateAssessment: false,
        educationContext: {
          schoolStage: "primary",
          grade,
          subject,
          ...(customSubjectName ? { customSubjectName } : {}),
          fullEnglishTeaching: false,
        },
        workflowProfile: profile.workflowProfile,
        interactionProfile: profile.interactionProfile,
        quizEnabled: false,
      }),
    });
    if (numberValue(task.taskId) <= 0) throw new Error("教学平台导入任务创建失败");
    return task;
  }

  async parseDocument(path: string): Promise<DesktopDocumentParseResult> {
    const name = basename(path);
    const uploaded = await this.uploadLocalFile(path, [".pdf", ".doc", ".docx", ".ppt", ".pptx"]);
    const token = await this.resolveAccessToken();
    let parsed: DesktopDocumentParseResult;
    try {
      parsed = await this.request<DesktopDocumentParseResult>("/courses/documents/parse", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fileUrl: uploaded.fileUrl, fileName: name }),
      });
    } catch (error) {
      await this.cleanupDocuments([uploaded.fileUrl]).catch(() => undefined);
      throw error;
    }
    const cleanupUrls = new Set<string>([uploaded.fileUrl]);
    const addCleanupUrl = (value: string | undefined) => {
      if (value && /^https?:\/\//i.test(value)) cleanupUrls.add(value);
    };
    for (const image of parsed.pdfImages ?? []) addCleanupUrl(image.src);
    for (const image of parsed.images ?? []) addCleanupUrl(image);
    for (const sheet of parsed.visionSheets ?? []) addCleanupUrl(sheet.src);
    return { ...parsed, cleanupUrls: [...cleanupUrls] };
  }

  async cleanupDocuments(fileUrls: string[]): Promise<void> {
    const urls = [...new Set(fileUrls.map((value) => text(value)).filter(Boolean))];
    if (urls.length === 0) return;
    const token = await this.resolveAccessToken();
    await this.request("/courses/documents/cleanup", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fileUrls: urls }),
    });
  }

  private async uploadLocalFile(path: string, extensions: readonly string[]): Promise<{
    name: string;
    fileUrl: string;
  }> {
    const name = basename(path);
    if (!extensions.includes(extname(name).toLowerCase())) {
      throw new Error(`不支持的文件格式：${name}`);
    }
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0) throw new Error(`文件不存在或为空：${name}`);
    const query = new URLSearchParams({
      filename: name,
      fileSize: String(info.size),
      skipMaterial: "true",
    });
    const token = await this.resolveAccessToken();
    const target = await this.request<PresignedUpload>(`/courses/presign?${query}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const uploadUrl = text(target.uploadUrl);
    const fileUrl = text(target.ossUrl);
    if (!uploadUrl || !fileUrl) throw new Error("文件上传地址获取失败");

    const body = new FormData();
    for (const [key, value] of Object.entries(target.fields ?? {})) {
      if (value !== null && value !== undefined) body.append(key, String(value));
    }
    const bytes = await readFile(path);
    body.append("file", new Blob([new Uint8Array(bytes)]), name);
    const response = await net.fetch(uploadUrl, { method: "POST", body });
    if (!response.ok) throw new Error(`文件上传失败 (${response.status})`);
    return { name, fileUrl };
  }

  private async finishLogin(): Promise<DesktopAuthState> {
    const profile = educationProfile(await this.request("/auth/me", {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    }));
    this.options.log("info", `desktop auth succeeded for user ${profile.userId}`);
    return this.setState({ status: "authenticated", profile });
  }

  private async refreshAccessToken(refreshToken: string): Promise<void> {
    let refreshed: { accessToken?: string; refreshToken?: string };
    try {
      refreshed = await this.request(DESKTOP_REFRESH_PATH, {
        method: "POST",
        body: JSON.stringify({ refreshToken }),
      });
    } catch (error) {
      if (!(error instanceof PlatformRequestError) || (error.status !== 404 && error.code !== 404)) {
        throw error;
      }
      refreshed = await this.request("/auth/refresh", {
        method: "POST",
        body: JSON.stringify({ refreshToken }),
      });
    }
    this.accessToken = text(refreshed.accessToken);
    if (!this.accessToken) throw new Error("登录凭证刷新失败");
    const rotatedRefreshToken = text(refreshed.refreshToken);
    if (rotatedRefreshToken) await this.writeRefreshToken(rotatedRefreshToken);
    await this.writeImageRuntime(this.accessToken);
    this.scheduleAccessRefresh();
  }

  private async refreshStoredAccessToken(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const refresh = this.readRefreshToken()
      .then((refreshToken) => {
        if (!refreshToken) throw new Error("登录凭证不存在");
        return this.refreshAccessToken(refreshToken);
      })
      .catch(async (error) => {
        if (this.isUnauthorized(error)) {
          this.accessToken = "";
          this.clearRefreshTimer();
          await this.clearStoredSession();
          await this.writeImageRuntime("");
          this.setState({ status: "signedOut", message: "登录已过期，请重新扫码" });
        }
        throw error;
      })
      .finally(() => {
        if (this.refreshInFlight === refresh) this.refreshInFlight = null;
      });
    this.refreshInFlight = refresh;
    return refresh;
  }

  private scheduleAccessRefresh(): void {
    this.clearRefreshTimer();
    try {
      const delay = Math.max(30_000, this.accessTokenExpiresIn() - ACCESS_REFRESH_EARLY_MS);
      this.refreshTimer = setTimeout(() => {
        void this.refreshStoredAccessToken()
          .catch(async (error) => {
            this.options.log("warn", `desktop auth refresh failed: ${String(error)}`);
            if (!this.isUnauthorized(error)) {
              this.refreshTimer = setTimeout(() => {
                void this.refreshStoredAccessToken().catch(() => this.scheduleAccessRefresh());
              }, 30_000);
            }
          });
      }, delay);
    } catch {
      this.options.log("warn", "desktop access token has no readable expiry");
    }
  }

  private accessTokenExpiresIn(): number {
    try {
      const payload = JSON.parse(Buffer.from(this.accessToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
      const expiresAt = Number(payload.exp) * 1000;
      return Number.isFinite(expiresAt) ? expiresAt - Date.now() : Number.POSITIVE_INFINITY;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  private isUnauthorized(error: unknown): boolean {
    return error instanceof PlatformRequestError && (error.status === 401 || error.code === 401);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  private setState(state: DesktopAuthState): DesktopAuthState {
    this.state = state;
    this.options.onChanged(state);
    return state;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("content-type", "application/json");
    const response = await net.fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      cache: "no-store",
    });
    const envelope = await response.json() as ApiEnvelope<T>;
    if (!response.ok || (typeof envelope.code === "number" && envelope.code !== 200)) {
      throw new PlatformRequestError(
        text(envelope.message) || `平台请求失败 (${response.status})`,
        response.status,
        envelope.code,
      );
    }
    if (envelope.data === undefined) throw new Error("平台返回无效数据");
    return envelope.data;
  }

  private async readRefreshToken(): Promise<string> {
    try {
      return (await readFile(this.sessionPath, "utf8")).trim();
    } catch {
      return "";
    }
  }

  private async writeRefreshToken(refreshToken: string): Promise<void> {
    await mkdir(join(this.options.dataDir, "auth"), { recursive: true, mode: 0o700 });
    await writeFile(this.sessionPath, refreshToken, { mode: 0o600 });
    await rm(this.legacySessionPath, { force: true });
  }

  private async clearStoredSession(): Promise<void> {
    await Promise.all([
      rm(this.sessionPath, { force: true }),
      rm(this.legacySessionPath, { force: true }),
    ]);
  }

  private async writeImageRuntime(accessToken: string): Promise<void> {
    const directory = join(homedir(), ".ppt-master");
    const path = join(directory, ".env");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const current = await readFile(path, "utf8").catch(() => "");
    let insideManagedBlock = false;
    const preserved = current.split(/\r?\n/).filter((line) => {
      if (line.trim() === IMAGE_ENV_BEGIN) {
        insideManagedBlock = true;
        return false;
      }
      if (line.trim() === IMAGE_ENV_END) {
        insideManagedBlock = false;
        return false;
      }
      if (insideManagedBlock) return false;
      const key = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/)?.[1];
      return !key || !IMAGE_ENV_KEYS.has(key);
    });
    const model = process.env.DECKWISE_IMAGE_MODEL?.trim() || "doubao-seedream-5-0-pro";
    const baseUrl = process.env.DECKWISE_LLM_BASE_URL?.trim() || DECKWISE_MANAGED_BASE_URL;
    const block = accessToken ? [
      IMAGE_ENV_BEGIN,
      "IMAGE_BACKEND=openai",
      `OPENAI_API_KEY=${accessToken}`,
      `OPENAI_BASE_URL=${baseUrl}`,
      `OPENAI_MODEL=${model}`,
      "OPENAI_RESPONSE_FORMAT=omit",
      "OPENAI_QUALITY=omit",
      IMAGE_ENV_END,
    ] : [];
    const contents = [...preserved, ...block]
      .join("\n")
      .replace(/^\s*\n/, "")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd();
    await writeFile(path, contents ? `${contents}\n` : "", { mode: 0o600 });
    await chmod(path, 0o600);
  }
}
