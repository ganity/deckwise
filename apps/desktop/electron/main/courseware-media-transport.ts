export type MediaRelayJournal = (method: "read" | "write", key: string, value?: unknown, expectedRevision?: number) => Promise<unknown>;
export type CoursewareMediaOptions = { baseUrl: string; imageBaseUrl?: string; fetch: typeof fetch; resolveAccessToken: () => Promise<string>;
  getPrincipal: () => object | null; relayJournal?: MediaRelayJournal };
const invalid = () => new Error("COURSEWARE_MEDIA_INVALID_RESPONSE");
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function mediaEnvelope(bytes: Buffer): unknown {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw invalid(); }
  if (!record(value) || !Number.isInteger(value.code)) throw invalid();
  if (value.code !== 200) throw new Error(`COURSEWARE_MEDIA_PLATFORM_${Number(value.code)}`);
  if (!Object.hasOwn(value, "data")) throw invalid();
  return value.data;
}

export function mediaSubmissionPath(projectId: string | undefined, confirmed = false): string {
  if (projectId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(projectId))
    throw new Error("COURSEWARE_MEDIA_INVALID_TEAM_PROJECT");
  return (projectId === undefined ? "/courseware/media" : `/courseware/team/projects/${projectId}/media`) +
    (confirmed ? "/tasks/confirmed" : "/tasks");
}

/** Main-only credential, cancellation and bounded-response ownership shared by media clients. */
export class CoursewareMediaTransport {
  private readonly baseUrl: string;
  private readonly imageBaseUrl: string;
  constructor(protected readonly options: CoursewareMediaOptions) {
    const checked = (base: string) => {
      const url = new URL(base);
      if (!(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) ||
          url.username || url.password || url.search || url.hash) throw new Error("COURSEWARE_MEDIA_INVALID_BASE_URL");
      return url.toString().replace(/\/+$/u, "");
    };
    this.baseUrl = checked(options.baseUrl);
    this.imageBaseUrl = checked(options.imageBaseUrl ?? options.baseUrl);
  }

  protected principal(): object {
    const principal = this.options.getPrincipal();
    if (!principal) throw new Error("COURSEWARE_MEDIA_AUTH_REQUIRED");
    return principal;
  }
  protected assertPrincipal(principal: object): void {
    if (this.options.getPrincipal() !== principal) throw new Error("COURSEWARE_MEDIA_AUTH_CHANGED");
  }
  protected async imageJson(path: string, principal: object, signal?: AbortSignal, init: RequestInit = {}): Promise<unknown> {
    return this.json(path, principal, signal, init, 30_000, true);
  }
  protected async json(path: string, principal: object, signal?: AbortSignal, init: RequestInit = {}, timeoutMs = 30_000, image = false): Promise<unknown> {
    const response = await this.receive(path, principal, signal, 64 * 1024, init, "application/json, audio/wav, audio/mpeg", timeoutMs, image);
    if (response.mime !== "application/json") throw invalid();
    return mediaEnvelope(response.bytes);
  }
  protected async receive(path: string, principal: object, signal: AbortSignal | undefined, max: number, init: RequestInit = {},
    accept = "application/json, audio/wav, audio/mpeg", timeoutMs = 30_000, image = false) {
    const cancellation = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    cancellation.throwIfAborted();
    let token: string;
    try { token = await this.options.resolveAccessToken(); } catch {
      this.assertPrincipal(principal);
      throw new Error("COURSEWARE_MEDIA_AUTH_REQUIRED");
    }
    this.assertPrincipal(principal);
    cancellation.throwIfAborted();
    if (!token || /[\r\n]/u.test(token)) throw new Error("COURSEWARE_MEDIA_AUTH_REQUIRED");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Accept", accept);
    if (typeof init.body === "string") headers.set("Content-Type", "application/json");
    let response: Response;
    try {
      response = await this.options.fetch(`${image ? this.imageBaseUrl : this.baseUrl}${path}`, { ...init, headers,
        cache: "no-store", credentials: "omit", redirect: "error", signal: cancellation });
    } catch {
      this.assertPrincipal(principal);
      throw new Error(cancellation.aborted ? "COURSEWARE_MEDIA_WAIT_CANCELLED" : "COURSEWARE_MEDIA_TRANSPORT_FAILED");
    }
    const reader = response.body?.getReader();
    try {
      this.assertPrincipal(principal);
      if (!response.ok) throw new Error(`COURSEWARE_MEDIA_HTTP_${response.status}`);
      if (!reader) throw invalid();
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/u.test(length) || Number(length) > max)) throw new Error("COURSEWARE_MEDIA_RESPONSE_TOO_LARGE");
      const chunks: Buffer[] = [];
      let size = 0;
      while (true) {
        const next = await reader.read();
        this.assertPrincipal(principal);
        cancellation.throwIfAborted();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > max) throw new Error("COURSEWARE_MEDIA_RESPONSE_TOO_LARGE");
        chunks.push(Buffer.from(next.value));
      }
      return { bytes: Buffer.concat(chunks, size), mime: response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() };
    } catch (error) {
      if (error instanceof Error && /^COURSEWARE_MEDIA_[A-Z0-9_]+$/u.test(error.message)) throw error;
      throw new Error(cancellation.aborted ? "COURSEWARE_MEDIA_WAIT_CANCELLED" : "COURSEWARE_MEDIA_TRANSPORT_FAILED");
    } finally {
      if (reader) {
        try { await reader.cancel(); } catch { /* Cleanup must not replace a sanitized transport error. */ }
        finally { reader.releaseLock(); }
      }
    }
  }
}
