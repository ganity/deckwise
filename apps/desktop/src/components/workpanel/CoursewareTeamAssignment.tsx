import { useEffect, useRef, useState } from "react";
import type { CoursewareGroup, CoursewareGroupShareReview, CoursewareTeamProject } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";

type Props = {
  title: string;
  sessionId?: string;
  projectId?: string;
  group?: CoursewareGroup;
  disabled?: boolean;
  onDone?: () => void;
};

export function CoursewareTeamAssignment({ title, sessionId, projectId, group, disabled, onDone }: Props) {
  const requestedSession = useAppStore(state => state.coursewareTeamAssignmentSessionId);
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<CoursewareGroup[]>([]);
  const [groupId, setGroupId] = useState(group?.groupId ?? "");
  const [project, setProject] = useState<CoursewareTeamProject>();
  const [review, setReview] = useState<CoursewareGroupShareReview>();
  const [needsSync, setNeedsSync] = useState(false);
  const [assigned, setAssigned] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const lifetime = useRef(0);
  useEffect(() => {
    const unsubscribe = api.onAuthChanged(() => {
      lifetime.current++;
      setOpen(false);
      setGroups([]);
      setAssigned("");
      setReview(undefined);
      setProject(undefined);
      setNeedsSync(false);
      setGroupId(group?.groupId ?? "");
      setBusy(false);
    });
    return () => { lifetime.current++; unsubscribe(); };
  }, [group?.groupId]);

  const run = async (operation: (check: () => void) => Promise<void>) => {
    if (inFlight.current || disabled) return;
    const generation = lifetime.current;
    const check = () => {
      if (generation !== lifetime.current || (sessionId && useAppStore.getState().activeSessionId !== sessionId))
        throw new Error("课件或登录账号已切换，请重新打开课件。");
    };
    inFlight.current = true;
    setBusy(true);
    setError("");
    try { check(); await operation(check); }
    catch (failure) {
      if (generation === lifetime.current) {
        const message = String(failure);
        setError(message.includes("GROUP_SHARE_REVIEW_CHANGED") ? "团队成员已变化，请重新确认归属。" :
          message.includes("COURSEWARE_ONLINE_TEACHING_NOT_READY") ? "请先保存本机 PPT 和教学内容，再同步到团队。" :
          message.includes("COURSEWARE_ONLINE_PREPARATION_CHANGED") ? "课件、PPT 或在线版本已变化，请打开此课件的最新版本后重试。" :
          message.includes("TEACHING_MEDIA_UNAVAILABLE") ? "有配音素材无法读取，请在本机确认语音能播放后重试。" : message);
        setReview(undefined);
      }
    } finally {
      inFlight.current = false;
      if (generation === lifetime.current) setBusy(false);
    }
  };

  const show = () => {
    setOpen(true);
    void run(async check => {
      const [availableGroups, projects, local] = await Promise.all([
        api.coursewareGroups({ action: "list" }),
        api.coursewareTeamProjects(),
        sessionId ? api.coursewareTaskGet(sessionId) : undefined,
      ]);
      check();
      if (sessionId && !local?.task) throw new Error("当前任务没有可归属的课件。");
      const id = projectId ?? local?.task?.teamProjectId;
      const current = projects.find(item => item.projectId === id);
      if (id && !current) throw new Error("当前账号无法访问此课件。");
      if (current?.groupId) {
        setAssigned(availableGroups.find(item => item.groupId === current.groupId)?.name ?? "已归属团队");
        setOpen(false);
        return;
      }
      if (current && current.role !== "OWNER") throw new Error("只有课件所有者可以设置归属团队。");
      setProject(current);
      setNeedsSync(Boolean(sessionId && !id));
      setGroups(availableGroups.filter(item => !item.archived && (!group || item.groupId === group.groupId)));
    });
  };

  useEffect(() => {
    if (sessionId && requestedSession === sessionId && !disabled) {
      useAppStore.setState({ coursewareTeamAssignmentSessionId: undefined });
      if (!assigned) show();
    }
  }, [requestedSession, sessionId, disabled, assigned]);

  const selected = groups.find(item => item.groupId === groupId);
  const inspect = () => run(async check => {
    if (!selected) return;
    const result = await api.coursewareGroups({ action: "review", groupId, projectId: project?.projectId });
    check();
    setReview(result);
  });

  const confirm = () => run(async check => {
    if (!selected || !review) return;
    let current = project;
    if (!current && sessionId) {
      // Reuse the same private project if the first sync or its response is interrupted.
      const id = await api.coursewareTeamProjectCreate(title.trim().slice(0, 120) || "课件", sessionId);
      check();
      current = (await api.coursewareTeamProjects()).find(item => item.projectId === id);
      check();
      if (!current || current.role !== "OWNER") throw new Error("当前账号无法访问此课件。");
      setProject(current);
    }
    if (!current) return;
    if (sessionId && needsSync) {
      const preparation = await api.coursewareOnlinePrepareReview({
        sessionId, projectId: current.projectId, includeTeaching: true, requireTaskSource: true,
      });
      try {
        check();
        await api.coursewareOnlinePrepareConfirm({ reviewId: preparation.reviewId });
      } finally {
        await api.coursewareOnlinePrepareCancel({ reviewId: preparation.reviewId }).catch(() => {});
      }
      check();
      setNeedsSync(false);
    }
    await api.coursewareGroups({ action: "share", groupId, projectId: current.projectId, ...review, keepOutsideAccess: false });
    check();
    setAssigned(selected.name);
    setOpen(false);
    onDone?.();
  });

  if (assigned) return <span>所属团队 · {assigned}</span>;
  if (!open) return <button type="button" className="btn btn-secondary" disabled={disabled} onClick={show}>归属团队</button>;
  return <div className="courseware-group-confirm" aria-label="设置课件归属团队">
    <label>归属团队{" "}
      <select aria-label="选择团队" value={groupId} disabled={busy || Boolean(group)} onChange={event => {
        setGroupId(event.currentTarget.value);
        setReview(undefined);
      }}>
        <option value="">选择已有团队</option>
        {groups.map(item => <option key={item.groupId} value={item.groupId}>{item.name}</option>)}
      </select>
    </label>
    {selected && <p>归入「{selected.name}」后，团队成员可以查看和编辑《{title}》。{needsSync ? "确认后会先同步本机课件。" : ""}</p>}
    {review && <ul>{review.recipients.map(item => <li key={item.userId}>
      {item.name || item.userId} · {item.role === "VIEWER" ? "只读" : "可编辑"}
    </li>)}</ul>}
    {review && review.outsideCollaborators.length > 0 && <p>以下组外协作者将失去访问权限 · {review.outsideCollaborators.map(item => item.name || item.userId).join("、")}</p>}
    {!busy && !error && !groups.length && <p>请先在团队管理中创建或加入团队。</p>}
    {busy && <p role="status">正在处理课件归属…</p>}
    {error && <p role="alert">{error}</p>}
    <div className="courseware-group-toolbar">
      {!review ? <button type="button" className="btn btn-primary" disabled={disabled || busy || !selected} onClick={() => void inspect()}>核对访问范围</button> :
        <button type="button" className="btn btn-primary" disabled={disabled || busy || !selected} onClick={() => void confirm()}>确认归属</button>}
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { setOpen(false); setReview(undefined); }}>取消</button>
    </div>
  </div>;
}
