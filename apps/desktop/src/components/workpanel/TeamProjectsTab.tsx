import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CoursewareOnlinePreparationReview, CoursewareTeamMember, CoursewareTeamProject } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { IconFolderOpen, IconPlay, IconRefresh } from "../icons";
import { WorkTabEmpty } from "./WorkTabEmpty";
import { CoursewareOnlineEditor } from "./CoursewareOnlineEditor";

const roleLabel: Record<CoursewareTeamProject["role"], string> = {
  OWNER: "创建者",
  EDITOR: "可编辑",
  VIEWER: "只读",
};

const preparationFailure = (failure: unknown) => {
  const message = String(failure);
  if (message.includes("COURSEWARE_ONLINE_SESSION_ACTIVE")) return "prepareActive";
  if (message.includes("TEACHING_MEDIA_UNAVAILABLE")) return "prepareTeachingMedia";
  if (message.includes("TEACHING_NOT_READY")) return "prepareTeachingNotReady";
  if (message.includes("TEACHING_CONFLICT") || message.includes("PREPARATION_CHANGED")) return "prepareTeachingConflict";
  return "prepareFailed";
};

export function TeamProjectsTab({ sessionId }: { sessionId?: string }) {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<CoursewareTeamProject[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState("");
  const [playError, setPlayError] = useState("");
  const [creating, setCreating] = useState(false);
  const [memberProject, setMemberProject] = useState("");
  const [memberUserId, setMemberUserId] = useState("");
  const [memberRole, setMemberRole] = useState<"EDITOR" | "VIEWER">("VIEWER");
  const [memberBusy, setMemberBusy] = useState(false);
  const [memberLoading, setMemberLoading] = useState(false);
  const [memberError, setMemberError] = useState("");
  const [members, setMembers] = useState<CoursewareTeamMember[]>([]);
  const [playChannel, setPlayChannel] = useState<"shared" | "formal">("shared");
  const [onlineAvailability, setOnlineAvailability] = useState<"checking" | "available" | "unavailable">("checking");
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const editingProject = useRef<string | null>(null);
  const projectRequest = useRef(0);
  const memberRequest = useRef(0);
  const memberMutation = useRef(false);
  const [preparationProject, setPreparationProject] = useState<string | null>(null);
  const [preparationPhase, setPreparationPhase] = useState<"idle" | "reviewing" | "confirming">("idle");
  const [preparationReview, setPreparationReview] = useState<CoursewareOnlinePreparationReview | null>(null);
  const [preparationError, setPreparationError] = useState("");
  const [preparationAcknowledged, setPreparationAcknowledged] = useState(false);
  const preparationRequest = useRef(0);
  const preparationBusy = useRef(false);
  const reviewedPreparation = useRef<CoursewareOnlinePreparationReview | null>(null);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;

  const clearPreparation = useCallback(() => {
    preparationRequest.current++;
    preparationBusy.current = false;
    const previous = reviewedPreparation.current;
    reviewedPreparation.current = null;
    if (previous) void api.coursewareOnlinePrepareCancel({ reviewId: previous.reviewId }).catch(() => {});
    setPreparationProject(null); setPreparationReview(null); setPreparationError("");
    setPreparationPhase("idle"); setPreparationAcknowledged(false);
  }, []);

  const reviewPreparation = async (project: CoursewareTeamProject, renderedRequest: number, includeTeaching = false) => {
    if (!sessionId || currentSession.current !== sessionId || project.role !== "OWNER" || onlineAvailability !== "available" ||
      editingProject.current || preparationBusy.current || projectRequest.current !== renderedRequest) return;
    clearPreparation();
    const request = preparationRequest.current;
    preparationBusy.current = true;
    setPreparationProject(project.projectId); setPreparationPhase("reviewing");
    try {
      const next = await api.coursewareOnlinePrepareReview({ sessionId, projectId: project.projectId, ...(includeTeaching ? { includeTeaching: true } : {}) });
      if (preparationRequest.current !== request || currentSession.current !== sessionId || projectRequest.current !== renderedRequest ||
        next.sessionId !== sessionId || next.projectId !== project.projectId) {
        void api.coursewareOnlinePrepareCancel({ reviewId: next.reviewId }).catch(() => {});
        return;
      }
      if (Boolean(next.teaching) !== includeTeaching) {
        void api.coursewareOnlinePrepareCancel({ reviewId: next.reviewId }).catch(() => {});
        throw new Error("COURSEWARE_ONLINE_TEACHING_CONFLICT");
      }
      reviewedPreparation.current = next;
      setPreparationReview(next);
    } catch (failure) {
      if (preparationRequest.current === request && currentSession.current === sessionId)
        setPreparationError(preparationFailure(failure));
    } finally {
      if (preparationRequest.current === request && currentSession.current === sessionId) {
        preparationBusy.current = false; setPreparationPhase("idle");
      }
    }
  };

  const confirmPreparation = async (review: CoursewareOnlinePreparationReview | null) => {
    if (!review || reviewedPreparation.current !== review || !preparationAcknowledged || preparationBusy.current || currentSession.current !== review.sessionId) return;
    const request = preparationRequest.current;
    preparationBusy.current = true;
    setPreparationPhase("confirming"); setPreparationError("");
    try {
      const prepared = await api.coursewareOnlinePrepareConfirm({ reviewId: review.reviewId });
      if (preparationRequest.current !== request || reviewedPreparation.current !== review || currentSession.current !== review.sessionId) return;
      if (prepared.projectId !== review.projectId) throw new Error("Unexpected prepared project");
      reviewedPreparation.current = null;
      clearPreparation();
      editingProject.current = prepared.projectId;
      setEditingProjectId(prepared.projectId);
    } catch (failure) {
      if (preparationRequest.current === request && currentSession.current === review.sessionId) {
        reviewedPreparation.current = null;
        setPreparationReview(null); setPreparationAcknowledged(false);
        setPreparationError(preparationFailure(failure));
      }
    } finally {
      if (preparationRequest.current === request && currentSession.current === review.sessionId) {
        preparationBusy.current = false; setPreparationPhase("idle");
      }
    }
  };

  const toggleMembers = async (projectId: string) => {
    const request = ++memberRequest.current;
    setMembers([]); setMemberUserId(""); setMemberRole("VIEWER"); setMemberError("");
    if (memberProject === projectId) { setMemberProject(""); setMemberLoading(false); return; }
    setMemberProject(projectId); setMemberLoading(true);
    try {
      const next = await api.coursewareTeamMembers(projectId);
      if (memberRequest.current === request) setMembers(next);
    } catch (failure) {
      if (memberRequest.current === request) setMemberError(String(failure));
    } finally { if (memberRequest.current === request) setMemberLoading(false); }
  };

  const createProject = async () => {
    const request = projectRequest.current;
    setCreating(true); setError("");
    try {
      await api.coursewareTeamProjectCreate();
      if (projectRequest.current === request) refresh();
    } catch (failure) { if (projectRequest.current === request) setError(String(failure)); }
    finally { setCreating(false); }
  };

  const changeMember = async (projectId: string, operation: "grant" | "revoke") => {
    if (memberMutation.current || memberLoading || memberProject !== projectId) return;
    const userId = Number(memberUserId);
    if (!Number.isSafeInteger(userId) || userId <= 0) { setMemberError("请输入有效的用户 ID"); return; }
    const request = memberRequest.current;
    memberMutation.current = true;
    setMemberBusy(true); setMemberError("");
    try {
      if (operation === "grant") await api.coursewareTeamMemberGrant(projectId, userId, memberRole);
      else await api.coursewareTeamMemberRevoke(projectId, userId);
      if (memberRequest.current !== request) return;
      const next = await api.coursewareTeamMembers(projectId);
      if (memberRequest.current === request) { setMemberUserId(""); setMembers(next); }
    } catch (failure) {
      if (memberRequest.current === request) setMemberError(String(failure));
    } finally { memberMutation.current = false; setMemberBusy(false); }
  };

  const refresh = useCallback(() => {
    clearPreparation();
    const request = ++projectRequest.current;
    memberRequest.current++;
    setMemberProject(""); setMembers([]); setMemberUserId(""); setMemberError(""); setMemberLoading(false);
    setStatus("loading");
    setError("");
    setOnlineAvailability("checking");
    void api.coursewareOnlineState().then(
      next => { if (projectRequest.current === request) setOnlineAvailability(next.available ? "available" : "unavailable"); },
      () => { if (projectRequest.current === request) setOnlineAvailability("unavailable"); },
    );
    void api.coursewareTeamProjects().then(
      (next) => {
        if (projectRequest.current !== request) return;
        setProjects(next);
        setStatus("ready");
      },
      (failure) => {
        if (projectRequest.current !== request) return;
        setError(String(failure));
        setStatus("error");
      },
    );
  }, [clearPreparation]);

  useEffect(() => {
    const unsubscribe = api.onAuthChanged(() => {
      editingProject.current = null;
      setEditingProjectId(null);
      refresh();
    });
    editingProject.current = null;
    setEditingProjectId(null);
    refresh();
    return () => {
      projectRequest.current++; memberRequest.current++; preparationRequest.current++;
      const previous = reviewedPreparation.current;
      reviewedPreparation.current = null;
      if (previous) void api.coursewareOnlinePrepareCancel({ reviewId: previous.reviewId }).catch(() => {});
      unsubscribe();
    };
  }, [refresh, sessionId]);
  const renderedProjectRequest = projectRequest.current;
  const renderedPreparationRequest = preparationRequest.current;

  if (editingProjectId) return <CoursewareOnlineEditor projectId={editingProjectId}
    manageTeachingPause={projects.some(project => project.projectId === editingProjectId && project.role === "OWNER")} onClose={() => {
    editingProject.current = null;
    setEditingProjectId(null);
    refresh();
  }} />;

  if (status === "loading") return <WorkTabEmpty icon={IconFolderOpen} title="正在读取团队课件" />;
  if (status === "error") {
    return <WorkTabEmpty icon={IconFolderOpen} title="团队课件读取失败" body={error}>
      <button type="button" className="btn btn-secondary" onClick={refresh}>
        <IconRefresh size={14} /> 重新读取
      </button>
    </WorkTabEmpty>;
  }
  if (projects.length === 0) return <WorkTabEmpty icon={IconFolderOpen} title="暂无共享课件" body="团队成员共享课件后会显示在这里。">
    <button type="button" className="btn btn-secondary" disabled={creating} onClick={() => void createProject()}>
      {creating ? "正在创建" : "新建团队项目"}
    </button>
    <button type="button" className="btn btn-secondary" onClick={refresh}>
      <IconRefresh size={14} /> 刷新
    </button>
    {error && <p role="alert">{error}</p>}
  </WorkTabEmpty>;

  return <section className="team-projects-tab" aria-label="团队课件">
    <header className="team-projects-header">
      <div>
        <h2>团队课件</h2>
        <p>{projects.length} 个项目对当前账号可见</p>
      </div>
      <div>
        <button type="button" className="btn btn-secondary" disabled={creating} onClick={() => void createProject()}>
          {creating ? "正在创建" : "新建团队项目"}
        </button>
        <button type="button" className="btn btn-secondary" onClick={refresh}>
          <IconRefresh size={14} /> 刷新
        </button>
      </div>
    </header>
    {onlineAvailability !== "available" && <p role="status">{t(onlineAvailability === "checking" ? "panel.onlineEditing.checking" : "panel.onlineEditing.unavailable")}</p>}
    <div className="team-projects-list">
      {projects.map((project) => <article className="team-project-row" key={project.projectId}>
        <div className="team-project-main">
          <strong>{project.projectId}</strong>
          <span>创建者用户 {project.ownerUserId}</span>
        </div>
        <span className="team-project-role">{roleLabel[project.role]}</span>
        {project.role !== "VIEWER" && <button type="button" className="btn btn-secondary" disabled={onlineAvailability !== "available" || preparationPhase === "confirming"}
          onClick={() => {
            if (onlineAvailability !== "available" || editingProject.current || preparationBusy.current || projectRequest.current !== renderedProjectRequest) return;
            clearPreparation();
            editingProject.current = project.projectId;
            setEditingProjectId(project.projectId);
          }}>{t("panel.onlineEditing.join")}</button>}
        {project.role === "OWNER" && <button type="button" className="btn btn-secondary"
          disabled={!sessionId || onlineAvailability !== "available" || preparationPhase !== "idle"}
          onClick={() => void reviewPreparation(project, renderedProjectRequest)}>{t("panel.onlineEditing.prepare")}</button>}
        {project.role === "OWNER" && <button type="button" className="btn btn-secondary"
          disabled={!sessionId || onlineAvailability !== "available" || preparationPhase !== "idle"}
          onClick={() => void reviewPreparation(project, renderedProjectRequest, true)}>{t("panel.onlineEditing.prepareWithTeaching")}</button>}
        {project.role === "OWNER" && !sessionId && <p>{t("panel.onlineEditing.prepareNeedsChat")}</p>}
        {preparationProject === project.projectId && <div className="team-project-play team-project-preparation" aria-label={t("panel.onlineEditing.prepareReviewTitle")}>
          {preparationPhase !== "idle" && <p role="status">{t(preparationPhase === "reviewing" ? "panel.onlineEditing.prepareReviewing" : "panel.onlineEditing.prepareConfirming")}</p>}
          {preparationError && <p role="alert">{t(`panel.onlineEditing.${preparationError}`)}</p>}
          {preparationReview && <>
            <h3>{t("panel.onlineEditing.prepareReviewTitle")}</h3>
            <p>{t(preparationReview.recovering ? "panel.onlineEditing.prepareRecovery" : preparationReview.replacesSource ? "panel.onlineEditing.prepareReplacement" : "panel.onlineEditing.prepareNewSource")}</p>
            <dl>
              <dt>{t("panel.onlineEditing.prepareFile")}</dt><dd>{preparationReview.fileName}</dd>
              <dt>{t("panel.onlineEditing.prepareBytes")}</dt><dd>{preparationReview.byteLength}</dd>
              <dt>SHA-256</dt><dd><code>{preparationReview.sha256}</code></dd>
              <dt>{t("panel.onlineEditing.prepareProject")}</dt><dd>{preparationReview.projectId}</dd>
              <dt>{t("panel.onlineEditing.prepareEpoch")}</dt><dd>{preparationReview.expectedEpoch}</dd>
            </dl>
            <p>{preparationReview.teaching ? t("panel.onlineEditing.prepareTeachingSummary", preparationReview.teaching) : t("panel.onlineEditing.preparePptxOnly")}</p>
            {(preparationReview.teaching?.audioCount ?? 0) > 0 && <p>{t("panel.onlineEditing.prepareTeachingAudioSummary", { count: preparationReview.teaching!.audioCount })}</p>}
            <label><input type="checkbox" checked={preparationAcknowledged} disabled={preparationPhase === "confirming"}
              onChange={event => { if (reviewedPreparation.current === preparationReview) setPreparationAcknowledged(event.target.checked); }} />
              {t((preparationReview.teaching?.audioCount ?? 0) > 0 ? "panel.onlineEditing.prepareTeachingAudioAcknowledgement" : preparationReview.teaching ? "panel.onlineEditing.prepareTeachingAcknowledgement" : "panel.onlineEditing.prepareAcknowledgement")}</label>
            <button type="button" className="btn btn-primary" disabled={!preparationAcknowledged || preparationPhase !== "idle"}
              onClick={() => void confirmPreparation(preparationReview)}>{t(preparationReview.recovering ? "panel.onlineEditing.prepareResume" : "panel.onlineEditing.prepareConfirm")}</button>
          </>}
          <button type="button" className="btn btn-secondary" disabled={preparationPhase === "confirming"}
            onClick={() => { if (preparationRequest.current === renderedPreparationRequest && preparationPhase !== "confirming") clearPreparation(); }}>{t("panel.onlineEditing.prepareCancel")}</button>
        </div>}
        <select aria-label="播放频道" value={playChannel} onChange={(event) => setPlayChannel(event.target.value as "shared" | "formal")}>
          <option value="shared">团队共享</option>
          <option value="formal">正式发布</option>
        </select>
        <button type="button" className="btn btn-secondary team-project-play" disabled={Boolean(playing)}
          onClick={async () => {
            setPlaying(project.projectId);
            setPlayError("");
            try { await api.coursewareTeamPlay(project.projectId, playChannel, "zh-CN"); }
            catch (failure) {
              const message = String(failure);
              setPlayError(message.includes("PLATFORM_46105") ? "该课件尚未发布到共享频道。" : message);
            }
            finally { setPlaying(""); }
          }}>
          <IconPlay size={14} /> {playing === project.projectId ? "正在打开" : "预览播放"}
        </button>
        {project.role === "OWNER" && <div className="team-project-members" aria-label="成员管理">
          <button type="button" className="btn btn-secondary" onClick={() => void toggleMembers(project.projectId)}>
            {memberProject === project.projectId ? "收起成员管理" : "成员管理"}
          </button>
          {memberProject === project.projectId && <div className="team-project-member-form">
            {memberLoading && <p role="status">{t("common.loading")}</p>}
            <div className="team-project-member-list">{members.map((member) => <button type="button" key={member.userId} className="btn btn-secondary" disabled={memberBusy} onClick={() => {
              setMemberUserId(String(member.userId));
              if (member.role !== "OWNER") setMemberRole(member.role);
            }}>用户 {member.userId} · {member.role}</button>)}</div>
            <label>用户 ID <input value={memberUserId} inputMode="numeric" disabled={memberBusy || memberLoading} onChange={(event) => setMemberUserId(event.target.value)} /></label>
            <label>权限 <select value={memberRole} disabled={memberBusy || memberLoading} onChange={(event) => setMemberRole(event.target.value as "EDITOR" | "VIEWER")}><option value="VIEWER">只读</option><option value="EDITOR">可编辑</option></select></label>
            <button type="button" className="btn btn-secondary" disabled={memberBusy || memberLoading} onClick={() => void changeMember(project.projectId, "grant")}>授权</button>
            <button type="button" className="btn btn-secondary" disabled={memberBusy || memberLoading} onClick={() => void changeMember(project.projectId, "revoke")}>撤销</button>
            {memberError && <p role="alert">{memberError}</p>}
          </div>}
        </div>}
      </article>)}
    </div>
    {error && <p role="alert">{error}</p>}
    {playError && <p role="alert">播放失败：{playError}</p>}
  </section>;
}
