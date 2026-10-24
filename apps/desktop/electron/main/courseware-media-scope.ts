/** Only Host's durable begin receipt selects the submission route. */
export function coursewareMediaSubmissionProject(value: unknown, sessionId: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "sessionId,teamProjectId" ||
      Reflect.get(value, "sessionId") !== sessionId)
    throw new Error("COURSEWARE_MEDIA_INVALID_SUBMISSION_SCOPE");
  const projectId = Reflect.get(value, "teamProjectId");
  if (projectId !== null && (typeof projectId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(projectId)))
    throw new Error("COURSEWARE_MEDIA_INVALID_SUBMISSION_SCOPE");
  return projectId ?? undefined;
}

/** Only these team-route responses are guaranteed to precede task creation. */
export function isCoursewareMediaPermissionRefusal(failure: unknown, teamProjectId: string | undefined): boolean {
  return teamProjectId !== undefined && failure instanceof Error &&
    /^COURSEWARE_MEDIA_PLATFORM_(46100|46102)$/u.test(failure.message);
}
