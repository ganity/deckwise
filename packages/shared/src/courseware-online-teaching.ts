import type { CoursewareProject } from "./courseware-contract.js";

/** Sanitized registered-client coordination state. No server IDs or publication proof. */
export type CoursewareOnlineBarrierView = {
  ownerId: string;
  viewId: string;
  sessionEpoch: number;
  state: "idle" | "draining" | "held" | "released";
  teachingPaused: boolean;
  uncertain: boolean;
  canStart: boolean;
  held: number;
  total: number;
  consistentPublicationReady: false;
};

/** A server-held teaching pause; native editing is independent. */
export type CoursewareOnlinePauseView = {
  ownerId: string;
  viewId: string;
  sessionEpoch: number;
  teachingRevision: string;
};

/** Initial-source logical page selection; native live page association is not implied. */
export type CoursewareOnlineTeachingView = {
  ownerId: string;
  viewId: string;
  project: CoursewareProject;
  mappingRevision: string;
  sessionEpoch: number;
  pageId: string;
  pageNumber: number;
  /** Main owns the lease proof. Absence means this view is read-only. */
  leaseExpiresAtEpochMillis?: number;
};
