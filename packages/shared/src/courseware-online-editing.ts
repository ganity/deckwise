/** Server-issued online session. Local Office bindings must never be reused here. */
export interface CoursewareOnlineSession {
  projectId: string;
  epoch: number;
  sessionId: string | null;
  active: boolean;
}

/** Opaque Main-owned review. Local paths, credentials, and signed Docs config never enter this view. */
export interface CoursewareOnlinePreparationReview {
  reviewId: string;
  projectId: string;
  sessionId: string;
  fileName: string;
  byteLength: number;
  sha256: string;
  expectedEpoch: number;
  replacesSource: boolean;
  /** Main verified a matching non-secret receipt; confirmation explicitly resumes that preparation. */
  recovering?: boolean;
  /** Explicitly selected first transfer; verified audio is adopted only after confirmation. */
  teaching?: { pageCount: number; narrationCount: number; audioCount?: number };
}

/** An in-process preparation result; this is not a persisted restart-recovery receipt. */
export interface CoursewareOnlinePreparationResult {
  projectId: string;
  sessionEpoch: number;
  source: { revision: string; sha256: string };
}

/** Keep configJson byte-for-byte unchanged; ONLYOFFICE Docs verifies its signature. */
export interface CoursewareOnlineLaunch {
  projectId: string;
  sessionEpoch: number;
  source: { revision: string; sha256: string };
  documentKey: string;
  docsUserId: string;
  configJson: string;
  expiresAtEpochMillis: number;
  /** Unique registered native mount. Absent on legacy Platform deployments. */
  clientId?: string;
}

/** Independent Host deployment pins, never derived from a project response. */
export interface CoursewareOnlineDeployment {
  hostUrl: string;
  apiUrl: string;
  communityPluginConfigUrl?: string;
}

/** Public UI state only; native Docs config and platform credentials stay out of the app renderer. */
export type CoursewareOnlineEditorState = {
  available: boolean;
  ownerId: string | null;
  projectId: string | null;
  status: "closed" | "opening" | "ready" | "sync-pending" | "sync-reported" | "error";
  errorCode?: string;
};

export interface CoursewareOnlineReadResult {
  page: number;
  totalSlides: number;
  text: string;
  truncated: boolean;
  slidesRead: number;
}

/** Per-editor acknowledgement only; an all-client barrier and archived save are separate. */
export interface CoursewareOnlineBarrierReceipt {
  barrierId: string;
  state: "draining" | "held" | "uncertain-held" | "resumed";
  serverIndex?: number;
  error?: string;
}

export interface CoursewareOnlineConnection {
  destroy(): void;
  communityReads?: {
    readPresentation(maxChars?: number): Promise<CoursewareOnlineReadResult>;
    barrierCapability?(): Promise<{ available: boolean }>;
    quiesceAndDrain?(barrierId: string): Promise<CoursewareOnlineBarrierReceipt>;
    barrierStatus?(barrierId: string): Promise<CoursewareOnlineBarrierReceipt>;
    resume?(barrierId: string): Promise<CoursewareOnlineBarrierReceipt>;
    close(): void;
  };
}

/** Structural signature of WiseOffice's existing mountDocsOnlineEditor export. */
export type CoursewareOnlineMount = (
  container: HTMLElement,
  hostUrl: string,
  apiUrl: string,
  configJson: string,
  binding: { documentKey: string; userId: string; communityPluginConfigUrl?: string },
  signal: AbortSignal,
  events?: {
    onDocumentReady?: () => void;
    onDocumentStateChange?: (event: { data: boolean }) => void;
    onError?: (event: unknown) => void;
  },
) => Promise<CoursewareOnlineConnection>;

/** Main-only per-mount identity and client-reported barrier evidence. */
export interface CoursewareOnlineClientBinding {
  ownerId: string;
  projectId: string;
  sessionEpoch: number;
  documentKey: string;
  docsUserId: string;
  clientId: string;
}

export interface CoursewareOnlineNativeBarrier {
  projectId: string;
  sessionEpoch: number;
  barrierId: string;
  pauseId: string;
  state: "draining" | "held" | "released";
  coverage: "managed" | "unmanaged";
  allRegisteredClientsHeld: boolean;
  authoritativeCoverage: false;
  consistentPublicationReady: false;
  proof: "client-reported";
  clients: Array<{
    clientId: string;
    docsUserId: string;
    state: "awaiting" | "draining" | "held" | "uncertain" | "resumed" | "stale" | "revoked" | "unavailable" | "disconnected";
    nativeReady: boolean;
    lastSeenEpochMillis: number | null;
  }>;
  reasons: string[];
}
