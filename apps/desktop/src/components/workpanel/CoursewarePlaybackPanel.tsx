import type { CoursewareFixedBuildView, CoursewareTeachingView } from "@pi-desktop/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

type OnlineSource = { viewId: string; ownerId: string; teamProjectId: string; readyPages: number; totalPages: number };
type Props = { sessionId: string; enabled: boolean; onActiveChange: (active: boolean) => void } &
  ({ view: CoursewareTeachingView; onlineSource?: never } | { view?: never; onlineSource: OnlineSource });

/** A preview is frozen; resume editing by closing it and building again. */
export function CoursewarePlaybackPanel({ view, onlineSource, sessionId, enabled, onActiveChange }: Props) {
  const { t, i18n } = useTranslation();
  const [build, setBuild] = useState<CoursewareFixedBuildView | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [teamProjects, setTeamProjects] = useState<Awaited<ReturnType<typeof api.coursewareTeamProjects>>>([]);
  const [teamProjectId, setTeamProjectId] = useState(onlineSource?.teamProjectId ?? "");
  const [teamChannel, setTeamChannel] = useState<"shared" | "formal">("shared");
  const [shareConfirmed, setShareConfirmed] = useState(false);
  const [teamProjectsLoading, setTeamProjectsLoading] = useState(false);
  const [shareStatus, setShareStatus] = useState("");
  const [shareRecovery, setShareRecovery] = useState<Awaited<ReturnType<typeof api.coursewareFixedShareStatus>>["intent"]>(null);
  const [shareRecoveryChecked, setShareRecoveryChecked] = useState(false);
  const [shareAuthRevision, setShareAuthRevision] = useState(0);
  const shareAuthGeneration = useRef(0);
  const authGeneration = shareAuthGeneration.current;
  const shareBlocked = useRef(true);
  const pendingShare = useRef<{ snapshotId: string; buildId: string; teamProjectId: string; channel: "shared" | "formal" } | null>(null);
  const shareConsent = useRef("");
  const currentChannel = useRef(teamChannel); currentChannel.current = teamChannel;
  const currentBuild = useRef(build); currentBuild.current = build;
  const request = useRef(0);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const scope = onlineSource ? `${sessionId}:${onlineSource.ownerId}:${onlineSource.viewId}:${onlineSource.teamProjectId}:${onlineSource.readyPages}:${onlineSource.totalPages}` : sessionId;
  const currentScope = useRef(scope); currentScope.current = scope;
  const currentEnabled = useRef(enabled); currentEnabled.current = enabled;
  const mounted = useRef(true);
  const running = useRef(false);
  const active = useRef(false);
  const onActive = useRef(onActiveChange);
  onActive.current = onActiveChange;
  const pendingPages = onlineSource ? Math.max(0, onlineSource.totalPages - onlineSource.readyPages)
    : view?.project.pages.filter((page) => page.reviewState !== "ready").length ?? 0;
  const allPagesReady = !onlineSource || (Number.isInteger(onlineSource.totalPages) && onlineSource.totalPages > 0 &&
    onlineSource.readyPages === onlineSource.totalPages);
  const missingAudio = view?.project.pages.some((page) => page.actions.some((action) => action.type === "speech" &&
    (typeof action.audioAssetId !== "string" || !/^tts-[a-f0-9]{64}$/u.test(action.audioAssetId))));
  const codes = build?.status === "review" ? [...new Set(build.diagnostics
    .filter((entry) => (entry.severity ?? "warning") === "warning").map((entry) => entry.code))] : [];
  const cancel = useCallback(() => {
    request.current++;
    running.current = false;
    const hadBuild = currentBuild.current !== null;
    currentBuild.current = null; shareConsent.current = "";
    const wasActive = active.current;
    active.current = false;
    setBuild(null); setChecked([]); setShareConfirmed(false); setBusy(false); onActive.current(false);
    if (wasActive || (onlineSource && hadBuild)) void api.coursewareFixedCancel().catch((failure) => setError(onlineSource ? t("panel.onlineSource.playbackFailed") : String(failure)));
  }, []);
  useEffect(() => {
    if (!enabled) cancel();
  }, [enabled, cancel]);
  useEffect(() => { if (onlineSource) cancel(); }, [scope, cancel]);
  const refreshShareRecovery = useCallback(async () => {
    const generation = shareAuthGeneration.current;
    const result = await api.coursewareFixedShareStatus(sessionId);
    if (mounted.current && currentScope.current === scope && currentSession.current === sessionId && shareAuthGeneration.current === generation) {
      const pending = pendingShare.current;
      const confirmed = !pending || (result.intent?.state === "bound" && result.intent.selection.snapshotId === pending.snapshotId &&
        result.intent.selection.buildId === pending.buildId && result.intent.selection.teamProjectId === pending.teamProjectId && result.intent.selection.channel === pending.channel);
      setShareRecovery(result.intent); setShareRecoveryChecked(confirmed || result.intent?.state === "unknown");
      shareBlocked.current = !confirmed || result.intent?.state === "unknown";
      if (confirmed) pendingShare.current = null;
    }
    return result;
  }, [sessionId, scope]);
  useEffect(() => api.onAuthChanged(() => {
    shareAuthGeneration.current++;
    shareBlocked.current = true; shareConsent.current = "";
    if (onlineSource) cancel();
    setShareRecovery(null); setShareRecoveryChecked(false); setShareStatus("");
    setTeamProjects([]); setTeamProjectId(""); setShareConfirmed(false); setShareAuthRevision((value) => value + 1);
  }), []);
  useEffect(() => {
    let current = true;
    shareBlocked.current = true;
    setShareRecovery(null); setShareRecoveryChecked(false);
    if (enabled) void api.coursewareFixedShareStatus(sessionId).then((result) => {
      if (current) { setShareRecovery(result.intent); setShareRecoveryChecked(true); shareBlocked.current = result.intent?.state === "unknown"; }
    }, (failure) => {
      if (current && !String(failure).includes("COURSEWARE_MEDIA_AUTH_REQUIRED")) setError(onlineSource ? t("panel.onlineSource.playbackFailed") : "无法读取分享恢复记录：" + String(failure));
    });
    return () => { current = false; };
  }, [enabled, sessionId, scope, shareAuthRevision]);
  useEffect(() => {
    if (build?.status !== "ready" || onlineSource) return;
    let active = true;
    setTeamProjectsLoading(true);
    void api.coursewareTeamProjects().then((projects) => {
      if (active) setTeamProjects(projects);
    }, (failure) => {
      if (active) setError("无法读取团队课件：" + String(failure));
    }).finally(() => { if (active) setTeamProjectsLoading(false); });
    return () => { active = false; };
  }, [build?.status, build?.status === "ready" ? build.previewId : "", shareAuthRevision]);
  useEffect(() => {
    mounted.current = true;
    return () => {
    mounted.current = false;
    request.current++;
    if (active.current) void api.coursewareFixedCancel().catch(() => {});
    onActive.current(false);
  }; }, []);

  const run = async (operation: (current: () => boolean) => Promise<CoursewareFixedBuildView | void>, preserveBuild = false) => {
    if (onlineSource && (!mounted.current || !currentEnabled.current || currentScope.current !== scope ||
        authGeneration !== shareAuthGeneration.current || running.current)) return;
    const id = ++request.current;
    running.current = true;
    active.current = true; onActive.current(true); setBusy(true); setError(""); setShareStatus("");
    try {
      const current = () => request.current === id && mounted.current && currentScope.current === scope && authGeneration === shareAuthGeneration.current;
      const next = await operation(current);
      if (current() && next) { currentBuild.current = next; setBuild(next); setChecked([]); setShareConfirmed(false); shareConsent.current = ""; }
    } catch (failure) {
      if (request.current === id) {
        setError(onlineSource ? t("panel.onlineSource.playbackFailed") : String(failure));
        if (preserveBuild) { active.current = false; onActive.current(false); }
        else cancel();
      }
    } finally { if (request.current === id) {
      running.current = false;
      setBusy(false);
      if (preserveBuild && !build) { active.current = false; onActive.current(false); }
    } }
  };

  return <section className="courseware-playback" aria-label={t("panel.pptEditor.playbackTitle")}>
    <strong>{t("panel.pptEditor.playbackTitle")}</strong>
    <p>{t(onlineSource ? "panel.onlineSource.playbackScope" : "panel.pptEditor.playbackScope")}</p>
    {pendingPages > 0 && <p role="status">{t("panel.pptEditor.playbackUnconfirmed", { count: pendingPages })}</p>}
    {missingAudio && <p role="status">{t("panel.pptEditor.playbackAudioRequired")}</p>}
    {build && <details>
      <summary>{t("panel.pptEditor.playbackVersion")}</summary>
      <p>Snapshot: {build.snapshot.snapshotId}</p>
      {build.status === "ready" && <p>Build: {build.buildRef.buildId}</p>}
    </details>}
    {!build && <button type="button" disabled={!enabled || busy || !allPagesReady || pendingPages > 0 || missingAudio} onClick={() => {
      if (!allPagesReady || pendingPages > 0 || missingAudio || (onlineSource && currentBuild.current)) return;
      void run(async (current) => {
      await api.coursewareFixedCancel();
      if (!current()) return;
      if (onlineSource) {
        const captured = await api.coursewareOnlineSourceCapture({ viewId: onlineSource.viewId });
        if (!current()) return;
        if (captured.viewId !== onlineSource.viewId || captured.ownerId !== onlineSource.ownerId ||
            captured.snapshot.projectId !== onlineSource.teamProjectId) throw new Error("Online source capture changed");
        return api.coursewareFixedBuild(sessionId, captured.snapshot);
      }
      if (!view) return;
      const snapshot = await api.pptEditorSnapshotCapture(view.viewId, view.project.teachingRevision);
      if (current()) return api.coursewareFixedBuild(sessionId, snapshot);
    }); }}>{t(busy ? "panel.pptEditor.playbackBuilding" : onlineSource ? "panel.onlineSource.capture" : "panel.pptEditor.playbackBuild")}</button>}
    {build?.status === "review" && <>
      <p>{t("panel.pptEditor.playbackWarnings")}</p>
      {build.diagnostics.map((diagnostic, index) => <p key={index}>{diagnostic.code}{diagnostic.message ? `: ${diagnostic.message}` : ""}</p>)}
      {codes.map((code) => <label key={code}>
        <input type="checkbox" checked={checked.includes(code)} disabled={!enabled || busy} onChange={(event) => {
          setChecked(event.target.checked ? [...checked, code] : checked.filter((entry) => entry !== code));
        }} /> {t("panel.pptEditor.playbackAcceptWarning", { code })}
      </label>)}
      <button type="button" disabled={!enabled || busy || !codes.length || checked.length !== codes.length}
        onClick={() => {
          if (codes.length && checked.length === codes.length && (!onlineSource || currentBuild.current === build))
            void run(() => api.coursewareFixedApprove(build.reviewId, checked));
        }}>{t("panel.pptEditor.playbackContinue")}</button>
    </>}
    {build?.status === "ready" && <>
      <p role="status">{t("panel.pptEditor.playbackReady")}</p>
      <p>{t("panel.pptEditor.playbackFidelity")}</p>
      <button type="button" disabled={!enabled || busy} onClick={() => void run(async () => {
        if (onlineSource && currentBuild.current !== build) return;
        await api.coursewareFixedPlay(build.previewId, i18n.language.startsWith("zh") ? "zh-CN" : "en");
      })}>{t("panel.pptEditor.playbackPlay")}</button>
      {onlineSource ? <p>{t("panel.onlineSource.teamProject", { project: onlineSource.teamProjectId })}</p> : <label>
        团队项目
        <select value={teamProjectId} disabled={!enabled || busy || teamProjectsLoading}
          onChange={(event) => setTeamProjectId(event.target.value)}>
          <option value="">{teamProjectsLoading ? "正在读取…" : "选择团队项目"}</option>
          {teamProjects.filter((project) => project.role !== "VIEWER").map((project) =>
            <option key={project.projectId} value={project.projectId}>{project.projectId}</option>)}
        </select>
      </label>}
      <label>
        {onlineSource ? t("panel.onlineSource.channel") : "发布频道"}
        <select value={teamChannel} disabled={!enabled || busy} onChange={(event) => {
          const channel = event.target.value;
          if (channel !== "shared" && channel !== "formal") return;
          currentChannel.current = channel; shareConsent.current = ""; setTeamChannel(channel); setShareConfirmed(false);
        }}>
          <option value="shared">{onlineSource ? t("panel.onlineSource.shared") : "团队共享"}</option>
          <option value="formal">{onlineSource ? t("panel.onlineSource.formal") : "正式发布"}</option>
        </select>
      </label>
      {onlineSource && <label><input type="checkbox" checked={shareConfirmed} disabled={!enabled || busy || !shareRecoveryChecked || shareRecovery?.state === "unknown"}
        onChange={(event) => {
          if (currentScope.current !== scope || currentChannel.current !== teamChannel || currentBuild.current !== build) return;
          shareConsent.current = event.target.checked ? `${build.previewId}:${teamChannel}` : "";
          setShareConfirmed(event.target.checked);
        }} />{t(teamChannel === "formal" ? "panel.onlineSource.confirmFormal" : "panel.onlineSource.confirmShared")}</label>}
      <button type="button" disabled={!enabled || busy || !(onlineSource?.teamProjectId ?? teamProjectId) || !shareRecoveryChecked || shareRecovery?.state === "unknown" || (!!onlineSource && !shareConfirmed)} onClick={() => {
        if (onlineSource && (!shareConfirmed || shareConsent.current !== `${build.previewId}:${teamChannel}` ||
            currentBuild.current !== build || shareBlocked.current || currentChannel.current !== teamChannel)) return;
        void run(async (current) => {
        if (onlineSource) {
          shareBlocked.current = true; shareConsent.current = ""; setShareConfirmed(false); setShareRecoveryChecked(false);
          pendingShare.current = { snapshotId: build.snapshot.snapshotId, buildId: build.buildRef.buildId, teamProjectId: onlineSource.teamProjectId, channel: teamChannel };
        }
        try {
          if (onlineSource) await api.coursewareFixedShare(build.previewId, onlineSource.teamProjectId, sessionId, teamChannel);
          else await api.coursewareFixedShare(build.previewId, teamProjectId, sessionId, teamChannel);
          if (current()) pendingShare.current = null;
          if (current()) setShareStatus(onlineSource ? t(teamChannel === "formal" ? "panel.onlineSource.publishedFormal" : "panel.onlineSource.publishedShared") : teamChannel === "formal" ? "已发布到正式频道。" : "已发布到团队共享频道。");
        } finally { if (current()) await refreshShareRecovery(); }
      }, true); }}>{onlineSource ? t(busy ? "panel.onlineSource.publishing" : teamChannel === "formal" ? "panel.onlineSource.publishFormal" : "panel.onlineSource.publishShared") : busy ? "正在共享…" : "共享到团队"}</button>
      {shareStatus && <p role="status">{shareStatus}</p>}
    </>}
    {onlineSource && !shareRecoveryChecked && <button type="button" disabled={!enabled || busy}
      onClick={() => void run(async () => { await refreshShareRecovery(); }, true)}>{t("panel.onlineSource.recover")}</button>}
    {shareRecovery && <div role="status">
      <p>{onlineSource ? t(shareRecovery.state === "unknown" || !shareRecoveryChecked ? "panel.onlineSource.publishUnknown" : "panel.onlineSource.publishKnown") : shareRecovery.state === "unknown" ? "分享结果尚未确认，请查询原分享结果。" : "此前分享及原任务团队绑定已确认。"}</p>
      <p>团队：{shareRecovery.selection.teamProjectId} · 频道：{shareRecovery.selection.channel}</p>
      <p>Build: {shareRecovery.selection.buildId} · Snapshot: {shareRecovery.selection.snapshotId}</p>
      {shareRecovery.state === "unknown" && <>
        <p>{onlineSource ? t("panel.onlineSource.recoverScope") : "查询发布回执可恢复原任务绑定，即使频道已有更新版本。没有可确认的发布结果时，此记录仍保留，不能重新发布。"}</p>
        <button type="button" disabled={!enabled || busy} onClick={() => void run(async (current) => {
          try {
            const result = await api.coursewareFixedShareRecover(sessionId, shareRecovery.intentId);
            if (current()) { setShareRecovery(result.intent); setShareStatus(onlineSource ? t("panel.onlineSource.publishKnown") : "已查询确认远端发布并恢复原任务绑定。"); }
          } finally { if (current()) await refreshShareRecovery(); }
        }, true)}>{onlineSource ? t("panel.onlineSource.recover") : "查询分享结果"}</button>
      </>}
    </div>}
    {(busy || build) && <button type="button" onClick={cancel}>{t("panel.pptEditor.playbackClose")}</button>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
