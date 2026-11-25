import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  CoursewareGroup, CoursewareGroupMember,
  CoursewareTeamMemberCandidate, CoursewareTeamProject,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { CoursewareTeamAssignment } from "./CoursewareTeamAssignment";

type Props = {
  projects: CoursewareTeamProject[];
  groupId: string;
  onGroupChange: (groupId: string) => void;
  onProjectsChanged: () => void;
};

type Confirmation =
  | { action: "archive" }
  | { action: "leave" }
  | { action: "removeMember" | "transfer"; member: CoursewareGroupMember }
  | { action: "transferProject"; member: CoursewareGroupMember; projectId: string };

const person = (member: { userId: number; name: string }) =>
  [member.name, `#${member.userId}`].filter(Boolean).join(" · ");

export function CoursewareGroupPanel({ projects, groupId, onGroupChange, onProjectsChanged }: Props) {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<CoursewareGroup[]>([]);
  const [members, setMembers] = useState<CoursewareGroupMember[]>([]);
  const [nameForm, setNameForm] = useState<"create" | "rename">();
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<CoursewareTeamMemberCandidate[]>();
  const [shareProject, setShareProject] = useState("");
  const [transferProject, setTransferProject] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [editingIds, setEditingIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const lifetime = useRef(0);
  const initialGroup = useRef(groupId);
  const group = groups.find((item) => item.groupId === groupId);
  const owner = group?.role === "OWNER";
  const manage = !group?.archived && (owner || group?.role === "ADMIN");
  const title = (projectId: string) => projects.find((item) => item.projectId === projectId)?.title || projectId;
  const shareable = projects.filter((item) => item.role === "OWNER" && !item.groupId);
  const transferable = projects.filter((item) => item.role === "OWNER" && item.groupId === groupId);

  async function run(work: (current: () => boolean) => Promise<void>) {
    if (locked.current) return;
    const generation = lifetime.current;
    const current = () => generation === lifetime.current;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await work(current);
    } catch (failure) {
      if (current()) {
        const message = String(failure);
        if (message.includes("GROUP_SHARE_REVIEW_CHANGED")) setConfirmation(undefined);
        setError(message);
      }
    } finally {
      if (current()) {
        locked.current = false;
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    const generation = ++lifetime.current;
    void (async () => {
      try {
        const result = await api.coursewareGroups({ action: "list" });
        if (generation !== lifetime.current) return;
        if (initialGroup.current) {
          if (result.some((item) => item.groupId === initialGroup.current)) {
            const roster = await api.coursewareGroups({ action: "members", groupId: initialGroup.current });
            if (generation !== lifetime.current) return;
            setMembers(roster);
          } else {
            onGroupChange("");
          }
        }
        setGroups(result);
        setAvailable(true);
      } catch (failure) {
        if (generation === lifetime.current) setError(String(failure));
      }
    })();
    return () => { lifetime.current++; };
  }, [onGroupChange]);

  const choose = (id: string) => run(async (current) => {
    setConfirmation(undefined); setNameForm(undefined); setCandidates(undefined); setQuery("");
    setShareProject(""); setTransferProject(""); setEditingIds([]);
    const result = id ? await api.coursewareGroups({ action: "members", groupId: id }) : [];
    if (!current()) return;
    setMembers(result);
    onGroupChange(id);
  });

  const saveName = () => run(async (current) => {
    if (!name.trim() || !nameForm) return;
    let id = groupId;
    if (nameForm === "create") id = (await api.coursewareGroups({ action: "create", name })).groupId;
    else await api.coursewareGroups({ action: "rename", groupId, name });
    const [nextGroups, nextMembers] = await Promise.all([api.coursewareGroups({ action: "list" }), api.coursewareGroups({ action: "members", groupId: id })]);
    if (!current()) return;
    setGroups(nextGroups); setMembers(nextMembers); setNameForm(undefined);
    onGroupChange(id);
  });

  const changeRole = (userId: number, role: "ADMIN" | "MEMBER") => run(async (current) => {
    await api.coursewareGroups({ action: "setMember", groupId, userId, role });
    const [nextGroups, nextMembers] = await Promise.all([api.coursewareGroups({ action: "list" }), api.coursewareGroups({ action: "members", groupId })]);
    if (!current()) return;
    setGroups(nextGroups); setMembers(nextMembers); setCandidates(undefined); setQuery("");
  });

  const confirm = () => run(async (current) => {
    if (!confirmation) return;
    switch (confirmation.action) {
      case "archive":
      case "leave":
        await api.coursewareGroups({ action: confirmation.action, groupId });
        break;
      case "transferProject":
        await api.coursewareGroups({ action: "transferProject", groupId, projectId: confirmation.projectId, userId: confirmation.member.userId });
        break;
      default:
        await api.coursewareGroups({ action: confirmation.action, groupId, userId: confirmation.member.userId });
    }
    if (!current()) return;
    setConfirmation(undefined); setShareProject(""); setTransferProject("");
    const nextGroups = await api.coursewareGroups({ action: "list" });
    const stillMember = nextGroups.some((item) => item.groupId === groupId);
    const nextMembers = stillMember ? await api.coursewareGroups({ action: "members", groupId }) : [];
    if (!current()) return;
    setGroups(nextGroups); setMembers(nextMembers);
    if (!stillMember) onGroupChange("");
    onProjectsChanged();
  });

  return <section className="courseware-groups" aria-label={t("panel.teamGroups.heading")}>
    <div className="courseware-group-toolbar">
      <label>{t("panel.teamGroups.heading")}{" "}
        <select value={groupId} disabled={busy || !available} onChange={(event) => void choose(event.currentTarget.value)}>
          <option value="">{t("panel.teamGroups.allProjects")}</option>
          {groups.map((item) => <option key={item.groupId} value={item.groupId}>
            {item.name}{item.archived ? ` · ${t("panel.teamGroups.archived")}` : ""}
          </option>)}
        </select>
      </label>
      <button type="button" className="btn btn-secondary" disabled={busy || !available}
        onClick={() => { setName(""); setNameForm("create"); }}>{t("panel.teamGroups.create")}</button>
    </div>
    {nameForm && <form className="team-project-member-search" onSubmit={(event) => { event.preventDefault(); void saveName(); }}>
      <label>{t("panel.teamGroups.name")}<input value={name} maxLength={120} disabled={busy}
        onChange={(event) => setName(event.currentTarget.value)} /></label>
      <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>{t("common.save")}</button>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setNameForm(undefined)}>{t("common.cancel")}</button>
    </form>}
    {group && <>
      <p className="courseware-group-summary">{t(`panel.teamGroups.${group.role}`)} · {t("panel.teamGroups.memberCount", { count: group.memberCount })}</p>
      {!group.archived && <div className="courseware-group-toolbar">
        {owner ? <>
          <button type="button" className="btn btn-secondary" disabled={busy}
            onClick={() => { setName(group.name); setNameForm("rename"); }}>{t("panel.teamGroups.rename")}</button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void run(async (current) => {
            const active = await api.coursewareGroups({ action: "activeProjects", groupId });
            if (current()) { setEditingIds(active); setConfirmation(active.length ? undefined : { action: "archive" }); }
          })}>{t("panel.teamGroups.archive")}</button>
        </> : <button type="button" className="btn btn-secondary" disabled={busy}
          onClick={() => setConfirmation({ action: "leave" })}>{t("panel.teamGroups.leave")}</button>}
      </div>}
      {editingIds.length > 0 && <p role="status">{t("panel.teamGroups.active", { projects: editingIds.map(title).join(", ") })}</p>}
      <details className="courseware-group-members">
        <summary>{t("panel.teamGroups.members")}</summary>
        {manage && <form className="team-project-member-search" onSubmit={(event) => {
          event.preventDefault();
          void run(async (current) => {
            const result = await api.coursewareGroups({ action: "search", groupId, query });
            if (current()) setCandidates(result);
          });
        }}>
          <label>{t("panel.teamMembers.query")}<input type="search" value={query} maxLength={80} disabled={busy}
            onChange={(event) => { setQuery(event.currentTarget.value); setCandidates(undefined); }} /></label>
          <button type="submit" className="btn btn-secondary" disabled={busy || !query.trim()}>{t("panel.teamGroups.search")}</button>
        </form>}
        {candidates?.length === 0 && <p role="status">{t("panel.teamMembers.empty")}</p>}
        {candidates?.map((candidate) => <div key={candidate.userId} className="courseware-group-person">
          <span>{[person(candidate), candidate.departmentName].filter(Boolean).join(" · ")}</span>
          {!members.some((item) => item.userId === candidate.userId) &&
            <button type="button" className="btn btn-secondary" disabled={busy}
              onClick={() => void changeRole(candidate.userId, "MEMBER")}>{t("panel.teamGroups.add")}</button>}
        </div>)}
        {transferable.length > 0 && !group.archived && <label>{t("panel.teamGroups.transferProject")}{" "}
          <select value={transferProject} disabled={busy} onChange={(event) => setTransferProject(event.currentTarget.value)}>
            <option value="">{t("panel.teamGroups.pickProject")}</option>
            {transferable.map((project) => <option value={project.projectId} key={project.projectId}>{title(project.projectId)}</option>)}
          </select>
        </label>}
        {members.map((member) => <div key={member.userId} className="courseware-group-person">
          <span>{person(member)} · {t(`panel.teamGroups.${member.role}`)}</span>
          {manage && member.role !== "OWNER" && (owner || member.role === "MEMBER") &&
            <button type="button" className="btn btn-secondary" disabled={busy}
              onClick={() => setConfirmation({ action: "removeMember", member })}>{t("panel.teamGroups.remove")}</button>}
          {owner && !group.archived && member.role !== "OWNER" && <>
            <button type="button" className="btn btn-secondary" disabled={busy}
              onClick={() => void changeRole(member.userId, member.role === "ADMIN" ? "MEMBER" : "ADMIN")}>
              {t(member.role === "ADMIN" ? "panel.teamGroups.demote" : "panel.teamGroups.promote")}
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy}
              onClick={() => setConfirmation({ action: "transfer", member })}>{t("panel.teamGroups.transfer")}</button>
          </>}
          {transferProject && projects.find((item) => item.projectId === transferProject)?.ownerUserId !== member.userId &&
            <button type="button" className="btn btn-secondary" disabled={busy}
              onClick={() => setConfirmation({ action: "transferProject", member, projectId: transferProject })}>
              {t("panel.teamGroups.transferProject")}
            </button>}
        </div>)}
      </details>
      {!group.archived && shareable.length > 0 && <div className="courseware-group-toolbar">
        <label>{t("panel.teamGroups.share")}{" "}
          <select value={shareProject} disabled={busy} onChange={(event) => { setShareProject(event.currentTarget.value); setConfirmation(undefined); }}>
            <option value="">{t("panel.teamGroups.pickProject")}</option>
            {shareable.map((project) => <option value={project.projectId} key={project.projectId}>{title(project.projectId)}</option>)}
          </select>
        </label>
        {shareProject && <CoursewareTeamAssignment key={groupId + "/" + shareProject}
          group={group} projectId={shareProject} title={title(shareProject)} disabled={busy}
          onDone={() => { setShareProject(""); onProjectsChanged(); }} />}
      </div>}
    </>}
    {confirmation && <div className="courseware-group-confirm">
      <p>{t(`panel.teamGroups.confirm${confirmation.action}`, {
        name: "member" in confirmation ? person(confirmation.member) : group?.name,
        project: "projectId" in confirmation ? title(confirmation.projectId) : undefined,
      })}</p>
      <div className="courseware-group-toolbar">
        <button type="button" className="btn btn-primary" disabled={busy}
          onClick={() => void confirm()}>{t("panel.teamGroups.confirm")}</button>
        <button type="button" className="btn btn-secondary" disabled={busy}
          onClick={() => setConfirmation(undefined)}>{t("common.cancel")}</button>
      </div>
    </div>}
    {busy && <p role="status">{t("common.loading")}</p>}
    {error && <p role="alert">{
      error.includes("GROUP_SHARE_REVIEW_CHANGED") ? t("panel.teamGroups.reviewChanged") :
      error.includes("GROUP_MEMBER_OWNS_PROJECT") ? t("panel.teamGroups.transferFirst") :
      error.includes("GROUP_ACTIVE_EDITING") ? t("panel.teamGroups.finishEditing") : error
    }</p>}
  </section>;
}
