"use client";
import { useState, useRef, useEffect, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

// ─── SUPABASE ─────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

// ─── SUPABASE 서비스 함수 ─────────────────────────────────────────────────────
async function sbCheckUsernameExists(username) {
  const { data } = await supabase
    .from("accounts").select("id").eq("username", username.trim()).maybeSingle();
  return !!data;
}
async function sbGetAccountByUsername(username) {
  const { data, error } = await supabase
    .from("accounts").select("*").eq("username", username.trim()).maybeSingle();
  if (error) throw error;
  return data;
}
async function sbCreateAccount(username, displayName, pwHash) {
  const { data, error } = await supabase
    .from("accounts")
    .insert({ username: username.trim(), name: displayName.trim(), pw_hash: pwHash })
    .select().single();
  if (error) {
    if (error.code === "42501" || error.message?.includes("row-level security"))
      throw new Error("계정 생성 권한이 없습니다. Supabase RLS 정책을 확인해주세요.");
    if (error.code === "23505") throw new Error("이미 사용 중인 아이디입니다.");
    throw new Error(error.message || "계정 생성 중 오류가 발생했습니다.");
  }
  if (!data) throw new Error("계정 생성 후 데이터를 받지 못했습니다.");
  return data;
}
async function sbGetOrCreateUserForAccount(account) {
  const { data: byAcc } = await supabase
    .from("users").select("*").eq("account_id", account.id).maybeSingle();
  if (byAcc) return byAcc;
  const displayName = account.name || account.username;
  const { data: byName } = await supabase
    .from("users").select("*").eq("name", displayName).is("account_id", null).maybeSingle();
  if (byName) {
    await supabase.from("users").update({ account_id: account.id }).eq("id", byName.id);
    return { ...byName, account_id: account.id };
  }
  const { data: created, error } = await supabase
    .from("users").insert({ name: displayName, account_id: account.id }).select().single();
  if (error) throw error;
  return created;
}
async function sbCreateMemberByName(name) {
  // 기존 사용자 먼저 검색 (중복 방지)
  const { data: existing } = await supabase
    .from("users").select("*").eq("name", name).is("account_id", null).maybeSingle();
  if (existing) return existing;
  const { data: created, error } = await supabase
    .from("users").insert({ name }).select().single();
  if (error) throw error;
  return created;
}
async function sbGetMyProjects(accountId) {
  const { data: memberRows, error: mErr } = await supabase
    .from("project_members").select("project_id").eq("account_id", accountId);
  if (mErr) throw mErr;
  if (!memberRows || memberRows.length === 0) return [];
  const projectIds = memberRows.map(r => r.project_id);
  const { data: projects, error: pErr } = await supabase
    .from("projects")
    .select(`
      id, name, topic, start_date, end_date, owner_account_id, invite_code, created_at, flow_graph, gantt_edit_perm,
      procedures (
        id, name, icon, color, order_index,
        tasks ( id, procedure_id, title, member_id, status, note, files, deadline, comments, start_date, start_time, deadline_time )
      ),
      project_members (
        id, user_id, account_id, role,
        users ( id, name, account_id )
      )
    `)
    .in("id", projectIds);
  if (pErr) throw pErr;
  const { data: allRoles, error: rErr } = await supabase
    .from("member_roles").select("*").in("project_id", projectIds);
  if (rErr) throw rErr;
  return (projects || []).map(p => dbProjectToApp(p, allRoles || []));
}
function dbProjectToApp(p, allRoles = []) {
  const projectRoles = allRoles.filter(r => r.project_id === p.id);
  const members = (p.project_members || []).map(pm => {
    const userRoles = projectRoles.filter(r => r.user_id === pm.user_id);
    const lead = userRoles.find(r => r.role_type === "main");
    const sup1 = userRoles.find(r => r.role_type === "sub1");
    const sup2 = userRoles.find(r => r.role_type === "sub2");
    return {
      id: pm.user_id, accountId: pm.account_id || null,
      name: pm.users?.name || "", role: pm.role,
      memberRoles: {
        lead: lead ? { name: lead.role_name, icon: lead.role_icon, color: lead.role_color } : null,
        support1: sup1 ? { name: sup1.role_name, icon: sup1.role_icon, color: sup1.role_color } : null,
        support2: sup2 ? { name: sup2.role_name, icon: sup2.role_icon, color: sup2.role_color } : null,
      },
    };
  });
  const procedures = (p.procedures || [])
    .sort((a, b) => a.order_index - b.order_index)
    .map(proc => ({
      id: proc.id, name: proc.name,
      icon: proc.icon || "📌", color: proc.color || "#6366f1",
      tasks: (proc.tasks || []).map(t => ({
        id: t.id, title: t.title,
        memberId: t.member_id || "",
        memberName: !t.member_id ? "미할당"
          : members.find(m => m.id === t.member_id)?.name || "미할당",
        status: t.status || "todo",
        note: t.note || "",
        files: t.files || [],
        deadline: t.deadline || "",
        startDate: t.start_date || "",
        startTime: t.start_time || "",
        deadlineTime: t.deadline_time || "",
        comments: t.comments || [],
      })),
    }));
  return {
    id: p.id, name: p.name, topic: p.topic || "",
    startDate: p.start_date || "", endDate: p.end_date || "",
    ownerAccountId: p.owner_account_id || null,
    inviteCode: p.invite_code || null,
    flowGraph: p.flow_graph || null,
    ganttEditPerm: p.gantt_edit_perm || false,
    members, procedures, createdAt: p.created_at,
  };
}
function genInviteCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}
async function sbCreateProject({ name, topic, startDate, endDate, ownerAccountId, ownerUserId, members, procedures }) {
  const validMembers = members.filter(m => m.id && m.id !== "self" && m.id.includes("-"));
  const inviteCode = genInviteCode();

  // 1) 프로젝트 생성
  const { data: proj, error: pErr } = await supabase
    .from("projects")
    .insert({ name, topic, start_date: startDate || null, end_date: endDate || null, owner_account_id: ownerAccountId, invite_code: inviteCode })
    .select().single();
  if (pErr) throw pErr;

  // 2) project_members 행 준비
  const memberRows = validMembers.map(m => ({
    project_id: proj.id, user_id: m.id,
    account_id: m.id === ownerUserId ? ownerAccountId : (m.account_id || null),
    role: m.id === ownerUserId ? "owner" : "member",
  }));
  if (!memberRows.find(r => r.user_id === ownerUserId))
    memberRows.push({ project_id: proj.id, user_id: ownerUserId, account_id: ownerAccountId, role: "owner" });

  // 3) member_roles 행 준비
  const roleRows = [];
  validMembers.forEach(m => {
    const mr = m.memberRoles || {};
    [["main", mr.lead], ["sub1", mr.support1], ["sub2", mr.support2]].forEach(([type, r]) => {
      if (r?.name) roleRows.push({
        project_id: proj.id, user_id: m.id,
        role_type: type, role_name: r.name,
        role_icon: r.icon || "⭐", role_color: r.color || "#6366f1",
      });
    });
  });

  // 4) project_members + member_roles 병렬 INSERT
  const insertPromises = [
    supabase.from("project_members").insert(memberRows).then(({ error }) => { if (error) throw error; }),
  ];
  if (roleRows.length) {
    insertPromises.push(
      supabase.from("member_roles").insert(roleRows).then(({ error }) => { if (error) throw error; })
    );
  }
  await Promise.all(insertPromises);

  // 5) 절차 + 작업 생성
  if (procedures?.length) {
    const procRows = procedures.map((p, i) => ({
      project_id: proj.id, name: p.name,
      icon: p.icon || "📌", color: p.color || "#6366f1", order_index: i,
    }));
    const { data: createdProcs, error: prErr } = await supabase.from("procedures").insert(procRows).select();
    if (prErr) throw prErr;

    // flowGraph 매핑 + tasks 준비를 병렬로
    const taskRows = [];
    createdProcs.forEach((proc, i) => {
      const src = procedures[i];
      const custom = src.customTasks || [];
      if (custom.length > 0) {
        custom.forEach(ct => {
          const memberId = ct.memberId && ct.memberId.includes("-") ? ct.memberId : null;
          taskRows.push({ project_id: proj.id, procedure_id: proc.id, title: ct.title, member_id: memberId, status: "todo", note: "", deadline: ct.deadline || null });
        });
      } else {
        validMembers.forEach(m => {
          taskRows.push({ project_id: proj.id, procedure_id: proc.id, title: `${proc.name} — ${m.name}`, member_id: m.id, status: "todo", note: "" });
        });
      }
    });

    // flow_graph 업데이트 + tasks INSERT 병렬
    const postProcPromises = [];
    const onboardFlowGraph = procedures._flowGraph || null;
    if (onboardFlowGraph && onboardFlowGraph.nodes?.length) {
      const procIdMap = {};
      procedures.forEach((p, i) => { if (createdProcs[i]) procIdMap[p.id] = createdProcs[i].id; });
      const mappedNodes = onboardFlowGraph.nodes.filter(n => procIdMap[n.procId]).map(n => ({ ...n, procId: procIdMap[n.procId] }));
      const mappedEdges = onboardFlowGraph.edges.filter(e => {
        const fn = onboardFlowGraph.nodes.find(n => n.id === e.from);
        const tn = onboardFlowGraph.nodes.find(n => n.id === e.to);
        return fn && tn && procIdMap[fn.procId] && procIdMap[tn.procId];
      });
      postProcPromises.push(
        supabase.from("projects").update({ flow_graph: { nodes: mappedNodes, edges: mappedEdges } }).eq("id", proj.id)
      );
    }
    if (taskRows.length) {
      postProcPromises.push(
        supabase.from("tasks").insert(taskRows).then(({ error }) => { if (error) throw error; })
      );
    }
    if (postProcPromises.length) await Promise.all(postProcPromises);
  }
  return proj;
}
async function sbUpdateProject(projectId, updates) {
  const dbUpdates = {};
  if (updates.name !== undefined) dbUpdates.name = updates.name;
  if (updates.topic !== undefined) dbUpdates.topic = updates.topic;
  if (updates.startDate !== undefined) dbUpdates.start_date = updates.startDate || null;
  if (updates.endDate !== undefined) dbUpdates.end_date = updates.endDate || null;
  if (updates.ganttEditPerm !== undefined) dbUpdates.gantt_edit_perm = updates.ganttEditPerm;
  const { error } = await supabase.from("projects").update(dbUpdates).eq("id", projectId);
  if (error) throw error;
}
async function sbDeleteProject(projectId) {
  const { data: members } = await supabase.from("project_members").select("user_id").eq("project_id", projectId);
  const memberIds = (members || []).map(m => m.user_id);
  await supabase.from("tasks").delete().eq("project_id", projectId);
  await supabase.from("procedures").delete().eq("project_id", projectId);
  await supabase.from("project_members").delete().eq("project_id", projectId);
  const { error } = await supabase.from("projects").delete().eq("id", projectId);
  if (error) throw error;
  if (memberIds.length > 0) {
    for (const userId of memberIds) {
      const { data: other } = await supabase.from("project_members").select("id").eq("user_id", userId).limit(1);
      if (!other || other.length === 0)
        await supabase.from("users").delete().eq("id", userId).is("account_id", null);
    }
  }
}
async function sbGetProjectByInviteCode(code) {
  const { data, error } = await supabase
    .from("projects")
    .select(`id, name, topic, invite_code, owner_account_id, project_members ( id, user_id, account_id, role, users(id, name) )`)
    .eq("invite_code", code.toUpperCase().trim()).maybeSingle();
  if (error) throw error;
  return data;
}
async function sbAcceptInvite(projectId, accountId, userId) {
  const { data: existing } = await supabase.from("project_members").select("id")
    .eq("project_id", projectId).eq("account_id", accountId).maybeSingle();
  if (existing) return;
  const { data: byUser } = await supabase.from("project_members").select("id, account_id")
    .eq("project_id", projectId).eq("user_id", userId).maybeSingle();
  if (byUser) {
    if (!byUser.account_id) {
      await supabase.from("project_members").update({ account_id: accountId }).eq("id", byUser.id);
      await supabase.from("users").update({ account_id: accountId }).eq("id", userId);
    }
  } else {
    await supabase.from("project_members").insert({ project_id: projectId, user_id: userId, account_id: accountId, role: "member" });
  }
}
async function sbRegenInviteCode(projectId) {
  const newCode = genInviteCode();
  const { error } = await supabase.from("projects").update({ invite_code: newCode }).eq("id", projectId);
  if (error) throw error;
  return newCode;
}
async function sbUpdateTask(taskId, changes) {
  const dbChanges = {};
  if (changes.status       !== undefined) dbChanges.status        = changes.status;
  if (changes.title        !== undefined) dbChanges.title         = changes.title;
  if (changes.note         !== undefined) dbChanges.note          = changes.note;
  if (changes.files        !== undefined) dbChanges.files         = changes.files;
  if (changes.memberId     !== undefined) dbChanges.member_id     = changes.memberId || null;
  if (changes.deadline     !== undefined) dbChanges.deadline      = changes.deadline || null;
  if (changes.startDate    !== undefined) dbChanges.start_date    = changes.startDate || null;
  if (changes.startTime    !== undefined) dbChanges.start_time    = changes.startTime || null;
  if (changes.deadlineTime !== undefined) dbChanges.deadline_time = changes.deadlineTime || null;
  if (changes.comments     !== undefined) dbChanges.comments      = changes.comments;
  const { error } = await supabase.from("tasks").update(dbChanges).eq("id", taskId);
  if (error) throw error;
}
async function sbCreateTask({ projectId, procedureId, title, memberId, startDate, deadline }) {
  const { data, error } = await supabase.from("tasks")
    .insert({ project_id: projectId, procedure_id: procedureId, title, member_id: memberId || null, status: "todo", note: "", deadline: deadline || null, start_date: startDate || null, comments: [] })
    .select().single();
  if (error) throw error;
  return data;
}
async function sbDeleteTask(taskId) {
  const { error } = await supabase.from("tasks").delete().eq("id", taskId);
  if (error) throw error;
}
async function sbAddProcedure({ projectId, name, icon, color, orderIndex }) {
  const { data, error } = await supabase.from("procedures")
    .insert({ project_id: projectId, name, icon: icon || "📌", color: color || "#6366f1", order_index: orderIndex })
    .select().single();
  if (error) throw error;
  return data;
}
async function sbUpdateProcedure(procId, updates) {
  const { error } = await supabase.from("procedures").update(updates).eq("id", procId);
  if (error) throw error;
}
async function sbDeleteProcedure(procId) {
  const { error } = await supabase.from("procedures").delete().eq("id", procId);
  if (error) throw error;
}
async function sbUpdateProcedureOrders(procedures) {
  await Promise.all(procedures.map((p, i) => supabase.from("procedures").update({ order_index: i }).eq("id", p.id)));
}
async function sbUploadFile(taskId, file) {
  const path = `${taskId}/${Date.now()}_${file.name}`;
  const { error: upErr } = await supabase.storage.from("task-files").upload(path, file, { upsert: false });
  if (upErr) throw upErr;
  const { data: urlData } = supabase.storage.from("task-files").getPublicUrl(path);
  return { id: uid(), name: file.name, size: file.size, type: file.type, url: urlData.publicUrl, path, uploadedAt: new Date().toLocaleString("ko-KR") };
}

// ─── PROJECT DRAFT (실시간 공동 온보딩) ──────────────────────────────────────
async function sbCreateDraft(ownerAccountId, initialData = {}) {
  const code = genInviteCode();
  const { data, error } = await supabase
    .from("project_drafts")
    .insert({ invite_code: code, owner_account_id: ownerAccountId, data: initialData, participants: [] })
    .select().single();
  if (error) throw error;
  return data;
}
async function sbGetDraftByCode(code) {
  const { data, error } = await supabase
    .from("project_drafts")
    .select("*")
    .eq("invite_code", code.toUpperCase().trim())
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  // 이미 프로젝트 생성 완료된 초안이면 거부
  if (data.data?._finishedProjectId) throw new Error("이미 완료된 공동 작업 코드입니다. 다른 코드를 확인해주세요.");
  // 만료된 초안이면 거부
  if (data.expires_at && new Date(data.expires_at) < new Date()) throw new Error("만료된 공동 작업 코드입니다.");
  return data;
}
async function sbUpdateDraftData(draftId, newData) {
  const { error } = await supabase
    .from("project_drafts")
    .update({ data: newData })
    .eq("id", draftId);
  if (error) throw error;
}
async function sbJoinDraft(draftId, participant) {
  // 참가자 배열에 추가 (중복 방지)
  const { data: current } = await supabase
    .from("project_drafts").select("participants").eq("id", draftId).single();
  const parts = current?.participants || [];
  if (parts.find(p => p.accountId === participant.accountId)) return;
  const { error } = await supabase
    .from("project_drafts")
    .update({ participants: [...parts, participant] })
    .eq("id", draftId);
  if (error) throw error;
}
async function sbDeleteDraft(draftId) {
  await supabase.from("project_drafts").delete().eq("id", draftId);
}

// ─── MESSAGES (쪽지) ─────────────────────────────────────────────────────────
async function sbSendMessage({ fromAccountId, fromName, toAccountId, toName, subject, body, team }) {
  const { data, error } = await supabase.from("messages").insert({
    from_account_id: fromAccountId,
    from_name: fromName,
    to_account_id: toAccountId,
    to_name: toName,
    subject: subject || "(제목 없음)",
    body: body || "",
    team: team || "",
    sent_at: new Date().toISOString(),
    read: false,
  }).select().single();
  if (error) throw error;
  return data;
}
async function sbGetMessages(accountId) {
  const { data, error } = await supabase.from("messages")
    .select("*")
    .or(`from_account_id.eq.${accountId},to_account_id.eq.${accountId}`)
    .order("sent_at", { ascending: false });
  if (error) throw error;
  return data || [];
}
async function sbMarkMessageRead(messageId) {
  await supabase.from("messages").update({ read: true }).eq("id", messageId);
}
async function sbDeleteMessage(messageId) {
  await supabase.from("messages").delete().eq("id", messageId);
}

// ─── THEME ────────────────────────────────────────────────────────────────────
const DARK = {
  bg: "#0c0c0f", surface: "#13131a", surfaceHover: "#1a1a24",
  border: "#1e1e2e", border2: "#28283a",
  text: "#e8e8f0", textSub: "#9898b8", textMuted: "#606080",
  accent: "#7c6af7", accentSub: "#a855f7",
  success: "#22d3a0", warn: "#fbbf24", danger: "#f87171",
  card: "#13131a", sidebarBg: "#0e0e14",
  glow: "rgba(124,106,247,0.15)",
};
const LIGHT = {
  bg: "#f0f0f8", surface: "#ffffff", surfaceHover: "#f7f7fc",
  border: "#e0e0f0", border2: "#d0d0e8",
  text: "#1a1a2e", textSub: "#5a5a7a", textMuted: "#a0a0c0",
  accent: "#7c6af7", accentSub: "#a855f7",
  success: "#059669", warn: "#d97706", danger: "#dc2626",
  card: "#ffffff", sidebarBg: "#f8f8fc",
  glow: "rgba(124,106,247,0.08)",
};

// ─── ICONS ────────────────────────────────────────────────────────────────────
const SVG = ({ d, size = 16, style = {} }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={style}>
    <path d={d} />
  </svg>
);
const I = {
  plus:      "M12 5v14M5 12h14",
  trash:     "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6",
  edit:      "M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z",
  check:     "M20 6L9 17l-5-5",
  chevR:     "M9 18l6-6-6-6",
  chevD:     "M6 9l6 6 6-6",
  sun:       "M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42M12 17a5 5 0 100-10 5 5 0 000 10z",
  moon:      "M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z",
  upload:    "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12",
  paperclip: "M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48",
  x:         "M18 6L6 18M6 6l12 12",
  calendar:  "M3 4h18v18H3zM16 2v4M8 2v4M3 10h18",
  msg:       "M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z",
  filter:    "M22 3H2l8 9.46V19l4 2v-8.54L22 3z",
  zoomIn:    "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35M11 8v6M8 11h6",
  zoomOut:   "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35M8 11h6",
  user:      "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z",
  link:      "M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71",
  bell:      "M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0",
  home:      "M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2zM9 22V12h6v10",
  layers:    "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  clock:     "M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2",
  settings:  "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z",
  chartBar:  "M18 20V10M12 20V4M6 20v-6",
  task:      "M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11",
};

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const PROC_TEMPLATES = [
  { id: "topic",     name: "주제 선정",  icon: "💡", color: "#f59e0b" },
  { id: "research",  name: "자료 조사",  icon: "🔍", color: "#3b82f6" },
  { id: "plan",      name: "계획 수립",  icon: "📋", color: "#8b5cf6" },
  { id: "develop",   name: "개발/제작",  icon: "⚙️", color: "#10b981" },
  { id: "ppt",       name: "PPT 제작",  icon: "🖥️", color: "#f97316" },
  { id: "rehearsal", name: "발표 연습",  icon: "🎤", color: "#ec4899" },
  { id: "present",   name: "최종 발표",  icon: "🏆", color: "#ef4444" },
  { id: "review",    name: "결과 검토",  icon: "📊", color: "#6366f1" },
];
const BASE_ROLES = [
  { id: "ppt",      name: "PPT 제작",      icon: "🖥️", color: "#f97316" },
  { id: "present",  name: "발표",          icon: "🎤", color: "#ec4899" },
  { id: "research", name: "자료조사",      icon: "🔍", color: "#3b82f6" },
  { id: "dev",      name: "개발/부가가치", icon: "⚙️", color: "#10b981" },
];
const ST  = { todo: "미진행", doing: "진행중", done: "진행완료" };
const SC  = { todo: "#94a3b8", doing: "#f59e0b", done: "#10b981" };
const uid = () => Math.random().toString(36).slice(2, 9);
const simpleHash = str => {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return String(h);
};

// ─── APP ──────────────────────────────────────────────────────────────────────
// 로컬스토리지 세션 키
const SESSION_KEY = "workend_session";
// 임시저장 목록 키 (여러 개 저장)
const DRAFTS_KEY  = "workend_drafts";

function loadDrafts(username = "") {
  try {
    const key = username ? `${DRAFTS_KEY}_${username}` : DRAFTS_KEY;
    const r = localStorage.getItem(key);
    return r ? JSON.parse(r) : [];
  } catch { return []; }
}
function saveDrafts(drafts, username = "") {
  try {
    const key = username ? `${DRAFTS_KEY}_${username}` : DRAFTS_KEY;
    localStorage.setItem(key, JSON.stringify(drafts));
  } catch {}
}

// ─── 전역 클릭 이펙트 스타일 주입 ─────────────────────────────────────────────
const GLOBAL_STYLE = `
  @keyframes ripple {
    from { transform: scale(0); opacity: 0.5; }
    to   { transform: scale(4); opacity: 0; }
  }
  @keyframes btnPress {
    0%   { transform: scale(1); }
    40%  { transform: scale(0.94); }
    100% { transform: scale(1); }
  }
  @keyframes pulse {
    0%,100% { opacity: 1; } 50% { opacity: .5; }
  }
  button, [role="button"] {
    position: relative; overflow: hidden;
    transition: transform .12s, box-shadow .12s;
  }
  button:active, [role="button"]:active {
    animation: btnPress .18s ease;
  }
  .ripple-wave {
    position: absolute; border-radius: 50%;
    background: rgba(255,255,255,0.35);
    pointer-events: none;
    animation: ripple 0.55s ease-out forwards;
  }
  * { box-sizing: border-box; }
  ::-webkit-scrollbar { width: 5px; height: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(128,128,160,0.3); border-radius: 10px; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(128,128,160,0.55); }
`;

function GlobalStyle({ dark }) {
  // 테마 CSS 변수 — dark/light 전환 시마다 갱신
  useEffect(() => {
    if (!document.getElementById("workend-global")) {
      const el = document.createElement("style");
      el.id = "workend-global";
      el.textContent = GLOBAL_STYLE;
      document.head.appendChild(el);
    }
    let varStyle = document.getElementById("workend-vars");
    if (!varStyle) {
      varStyle = document.createElement("style");
      varStyle.id = "workend-vars";
      document.head.appendChild(varStyle);
    }
    const T = dark ? DARK : LIGHT;
    varStyle.textContent = `
      :root {
        --wk-text:       ${T.text};
        --wk-text-sub:   ${T.textSub};
        --wk-text-muted: ${T.textMuted};
        --wk-surface:    ${T.surface};
        --wk-bg:         ${T.bg};
        --wk-accent:     ${T.accent};
        --wk-border:     ${T.border};
      }
      select { color: var(--wk-text); background: var(--wk-surface); }
      option { color: var(--wk-text); background: var(--wk-surface); }
      input::placeholder, textarea::placeholder { color: var(--wk-text-muted); opacity: 1; }
      input[type="date"], input[type="time"] { color-scheme: ${dark ? "dark" : "light"}; }
    `;
  }, [dark]);

  // 전역 ripple 클릭 이펙트 — 한 번만 등록
  useEffect(() => {
    const onClick = (e) => {
      const target = e.target.closest("button, [role='button']");
      if (!target) return;
      const rect = target.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height) * 2;
      const x = e.clientX - rect.left - size / 2;
      const y = e.clientY - rect.top  - size / 2;
      const wave = document.createElement("span");
      wave.className = "ripple-wave";
      wave.style.cssText = `width:${size}px;height:${size}px;left:${x}px;top:${y}px;`;
      target.appendChild(wave);
      setTimeout(() => wave.remove(), 600);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  return null;
}

// 생성 중 화면: 주기적으로 프로젝트 폴링 + 타임아웃 탈출
function CreatingTimeout({ onEscape, onProjectFound, T }) {
  const [elapsed, setElapsed] = useState(0);
  const [polling, setPolling] = useState(false);

  // 1초마다 경과 시간 증가
  useEffect(() => {
    const t = setInterval(() => setElapsed(s => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // 5초마다 프로젝트 자동 폴링 (Realtime 놓쳤을 때 대비)
  useEffect(() => {
    if (elapsed > 0 && elapsed % 5 === 0 && !polling) {
      setPolling(true);
      if (onProjectFound) onProjectFound().finally(() => setPolling(false));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsed]);

  return (
    <div style={{ marginTop: 16 }}>
      <p style={{ color: T.textMuted, fontSize: 11 }}>
        {polling ? "🔍 프로젝트 확인 중..." : `${elapsed}초 경과`}
      </p>
      {elapsed >= 15 && (
        <div style={{ marginTop: 12 }}>
          <p style={{ color: T.warn, fontSize: 12, marginBottom: 8 }}>⚠️ 자동 전환이 안 된다면 수동으로 이동하세요.</p>
          <button onClick={onEscape}
            style={{ padding: "8px 20px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 9, color: T.textSub, fontSize: 13, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>
            프로젝트 목록 새로고침
          </button>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [dark, setDark]           = useState(false);
  const T                          = dark ? DARK : LIGHT;
  const [screen, setScreen]       = useState("loading"); // 초기 로딩 화면
  const [projects, setProjects]   = useState([]);
  const [active, setActive]       = useState(null);
  const [tab, setTab]             = useState("dashboard");
  const [onStep, setOnStep]       = useState(0);
  const [onData, setOnData]       = useState({});
  const [loginName, setLoginName] = useState("");
  const [currentAccount, setCurrentAccount] = useState(null);
  const [currentUser, setCurrentUser]       = useState(null);
  const [toast, setToast]         = useState(null);
  const [loading, setLoading]     = useState(true);  // 초기 true — 세션 복원 완료 전
  const [isCreating, setIsCreating] = useState(false); // 프로젝트 생성 중 (전역 오버레이 없음)
  const [notifications, setNotifications] = useState([]);
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const sideW = sideCollapsed ? 60 : 220;
  // 임시저장 목록 — 로그인 후 계정별로 로드 (초기엔 빈 배열)
  const [drafts, setDrafts]       = useState([]);
  // 현재 편집 중인 초안 ID (null이면 새 초안)
  const [activeDraftId, setActiveDraftId] = useState(null);
  // 실시간 공동 온보딩 draft (DB)
  const [realtimeDraftId, setRealtimeDraftId] = useState(null);   // project_drafts.id
  const [realtimeDraftCode, setRealtimeDraftCode] = useState(null); // 초대 코드
  const [isOwnerDraft, setIsOwnerDraft] = useState(true);           // true=팀장, false=팀원
  const [draftParticipants, setDraftParticipants] = useState([]);   // 현재 참가자 목록
  const realtimeChannelRef = useRef(null);                          // Realtime 채널 ref
  const projectRealtimeRef = useRef(null);                          // 프로젝트 Realtime 채널
  const currentAccountRef  = useRef(null);                          // 최신 currentAccount ref
  const draftSyncTimerRef  = useRef(null);                          // draft DB sync debounce timer
  useEffect(() => { currentAccountRef.current = currentAccount; }, [currentAccount]);

  const addNotif = (text, icon = "📌") => {
    const n = { text, icon, time: new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }), read: false };
    setNotifications(ns => [n, ...ns].slice(0, 30));
  };
  const clearNotifs = (arr) => setNotifications(Array.isArray(arr) ? arr : []);
  const notify = (msg, type = "ok") => { setToast({ msg, type }); setTimeout(() => setToast(null), 2500); };
  const syncProject = updated => { setActive(updated); setProjects(ps => ps.map(x => x.id === updated.id ? updated : x)); };

  // 화면 전환 헬퍼 — SESSION에 마지막 화면 저장
  const goProject = (proj, tabName = "dashboard") => {
    setActive(proj); setTab(tabName); setScreen("project");
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      const sess = raw ? JSON.parse(raw) : {};
      localStorage.setItem(SESSION_KEY, JSON.stringify({ ...sess, lastScreen: "project", lastProjectId: proj.id, lastTab: tabName }));
    } catch {}
  };
  const goProjects = () => {
    setScreen("projects");
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      const sess = raw ? JSON.parse(raw) : {};
      localStorage.setItem(SESSION_KEY, JSON.stringify({ ...sess, lastScreen: "projects", lastProjectId: null }));
    } catch {}
  };

  // ── 프로젝트 Realtime 구독 (tasks, procedures, project_members 변경 감지)
  const subscribeProject = useCallback((projectId) => {
    if (projectRealtimeRef.current) {
      supabase.removeChannel(projectRealtimeRef.current);
      projectRealtimeRef.current = null;
    }
    const reload = async () => {
      const aid = currentAccountRef.current?.id;
      if (!aid) return;
      try {
        // 전체 재조회 대신 해당 프로젝트만 조회 (다른 프로젝트로 덮어쓰기 방지)
        const [projData, rolesData] = await Promise.all([
          supabase.from("projects").select(`
            id, name, topic, start_date, end_date, owner_account_id, invite_code, created_at, flow_graph, gantt_edit_perm,
            procedures ( id, name, icon, color, order_index,
              tasks ( id, procedure_id, title, member_id, status, note, files, deadline, comments, start_date, start_time, deadline_time )
            ),
            project_members ( id, user_id, account_id, role, users ( id, name, account_id ) )
          `).eq("id", projectId).single(),
          supabase.from("member_roles").select("*").eq("project_id", projectId),
        ]);
        if (projData.data) {
          const updated = dbProjectToApp(projData.data, rolesData.data || []);
          // projects 목록 갱신 + active는 현재 보고 있는 프로젝트일 때만 갱신
          setProjects(ps => ps.map(x => x.id === projectId ? updated : x));
          setActive(prev => prev?.id === projectId ? updated : prev);
        }
      } catch {}
    };
    const ch = supabase.channel(`project-${projectId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks",        filter: `project_id=eq.${projectId}` }, reload)
      .on("postgres_changes", { event: "*", schema: "public", table: "procedures",   filter: `project_id=eq.${projectId}` }, reload)
      .on("postgres_changes", { event: "*", schema: "public", table: "projects",     filter: `id=eq.${projectId}` },         reload)
      .on("postgres_changes", { event: "*", schema: "public", table: "member_roles", filter: `project_id=eq.${projectId}` }, reload)
      .subscribe();
    projectRealtimeRef.current = ch;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 활성 프로젝트 변경 시 구독 전환
  useEffect(() => {
    if (active?.id) { subscribeProject(active.id); }
    return () => {
      if (projectRealtimeRef.current) { supabase.removeChannel(projectRealtimeRef.current); projectRealtimeRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  // ── 세션 자동 복원: OAuth 콜백 처리만, 일반 세션은 로그인 화면 먼저 표시
  useEffect(() => {
    const restore = async () => {
      const hash = window.location.hash;
      const search = window.location.search;
      const hasOAuthCallback = hash.includes("access_token") || search.includes("code=");

      if (hasOAuthCallback) {
        // Google OAuth 콜백 처리
        try {
          const { data: { session }, error } = await supabase.auth.getSession();
          if (!session) {
            if (error) console.warn("OAuth session error:", error.message);
            window.history.replaceState({}, document.title, window.location.pathname);
            setLoading(false);
            return;
          }
          window.history.replaceState({}, document.title, window.location.pathname);
          const email = session.user.email;
          const displayName = session.user.user_metadata?.full_name
            || session.user.user_metadata?.name
            || email?.split("@")[0] || "사용자";
          let account = null;
          try {
            const { data: existing } = await supabase.from("accounts").select("*").eq("username", email).maybeSingle();
            if (existing) { account = existing; }
            else {
              const { data: upserted, error: upsErr } = await supabase.from("accounts")
                .upsert({ username: email, name: displayName, pw_hash: "google_oauth_" + session.user.id }, { onConflict: "username" })
                .select().maybeSingle();
              if (upsErr) {
                const { data: retry } = await supabase.from("accounts").select("*").eq("username", email).maybeSingle();
                account = retry;
              } else { account = upserted; }
            }
          } catch (e) { console.warn("[Google] account error:", e); }
          if (!account) { setLoading(false); return; }
          const user = await sbGetOrCreateUserForAccount(account);
          setCurrentAccount(account); setCurrentUser(user);
          setLoginName(account.name || displayName);
          try { localStorage.setItem(SESSION_KEY, JSON.stringify({ username: account.username })); } catch {}
          setDrafts(loadDrafts(account.username));
          const projs = await sbGetMyProjects(account.id);
          setProjects(projs); setScreen("projects");
          const isExisting = !!account.created_at && new Date(account.created_at) < new Date(Date.now() - 10000);
          notify(isExisting ? `환영합니다, ${account.name}님! 기존 계정과 연동되었습니다. 👋` : `환영합니다, ${displayName}님! 🎉`);
        } catch (e) { console.warn("OAuth restore error:", e); }
        finally { setLoading(false); }
        return;
      }

      // 일반 username/pw 세션 복원 (새로고침 대응)
      try {
        const raw = localStorage.getItem(SESSION_KEY);
        if (!raw) { setScreen("login"); setLoading(false); return; }
        const { username, lastScreen, lastProjectId, lastTab } = JSON.parse(raw);
        if (!username) { setScreen("login"); setLoading(false); return; }
        const account = await sbGetAccountByUsername(username);
        if (!account) { localStorage.removeItem(SESSION_KEY); setScreen("login"); setLoading(false); return; }
        const user = await sbGetOrCreateUserForAccount(account);
        setCurrentAccount(account); setCurrentUser(user);
        setLoginName(account.name || account.username);
        setDrafts(loadDrafts(account.username));
        const projs = await sbGetMyProjects(account.id);
        setProjects(projs);
        // 마지막 화면 복원
        if (lastScreen === "project" && lastProjectId) {
          const lastProj = projs.find(p => p.id === lastProjectId);
          if (lastProj) {
            setActive(lastProj);
            setTab(lastTab || "dashboard");
            setScreen("project");
          } else { setScreen("projects"); }
        } else {
          setScreen("projects");
        }
        const todayStr = new Date().toISOString().slice(0, 10);
        const dn = account.name || account.username;
        const overdueCount = projs.flatMap(p =>
          p.procedures.flatMap(proc => proc.tasks.filter(t => t.memberName === dn && t.deadline && t.deadline < todayStr && t.status !== "done"))
        ).length;
        if (overdueCount > 0) setTimeout(() => addNotif(`⚠️ 기한 초과 작업이 ${overdueCount}개 있습니다!`, "⚠️"), 600);
      } catch { localStorage.removeItem(SESSION_KEY); setScreen("login"); }
      finally { setLoading(false); }
    };
    restore();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 초안 저장 헬퍼 (계정별 분리)
  const upsertDraft = (draftId, data) => {
    const id = draftId || uid();
    const username = currentAccount?.username || "";
    setDrafts(prev => {
      const idx = prev.findIndex(d => d.id === id);
      const entry = { id, data, savedAt: new Date().toLocaleString("ko-KR"), projectName: data.projectName || "이름 없음" };
      const next = idx >= 0 ? prev.map((d, i) => i === idx ? entry : d) : [...prev, entry];
      saveDrafts(next, username);
      return next;
    });
    return id;
  };
  const deleteDraft = (draftId) => {
    const username = currentAccount?.username || "";
    setDrafts(prev => { const next = prev.filter(d => d.id !== draftId); saveDrafts(next, username); return next; });
  };
  // 이전 단일 키 호환성 제거 + 공용 초안 키 제거
  useEffect(() => {
    try { localStorage.removeItem("workend_draft"); } catch {}
    try { localStorage.removeItem(DRAFTS_KEY); } catch {} // 계정 없는 공용 키 제거 (이상민 4개 포함)
    // 이전 형식 키 패턴 정리 (workend_drafts 자체 및 구버전)
    try {
      Object.keys(localStorage).forEach(k => {
        if (k === DRAFTS_KEY) localStorage.removeItem(k);
      });
    } catch {}
  }, []);

  // ── Realtime 구독 (공동 온보딩) ───────────────────────────────────────────
  const subscribeToRealtimeDraft = (draftId) => {
    if (realtimeChannelRef.current) {
      supabase.removeChannel(realtimeChannelRef.current);
      realtimeChannelRef.current = null;
    }
    const channel = supabase
      .channel("draft-" + draftId)
      .on("postgres_changes", {
        event: "UPDATE",
        schema: "public",
        table: "project_drafts",
        filter: `id=eq.${draftId}`,
      }, payload => {
        const updated = payload.new;
        const newData = updated.data || {};
        const newParts = updated.participants || [];

        // _creating 신호: 팀장이 프로젝트 생성 중 (_finishedProjectId가 없을 때만)
        if (newData._creating === true && !newData._finishedProjectId) {
          setScreen("creating");
          return;
        }

        // _finishedProjectId가 있으면 생성 완료 → 팀원 화면 전환
        if (newData._finishedProjectId) {
          const aid = currentAccountRef.current?.id;
          if (!aid) { setScreen("projects"); return; }
          const tryGoProject = (retries = 3) => {
            sbGetMyProjects(aid).then(projs => {
              setProjects(projs);
              const proj = projs.find(p => p.id === newData._finishedProjectId);
              if (proj) {
                goProject(proj);
                notify("🎉 프로젝트 생성 완료! 참가합니다.");
              } else if (retries > 0) {
                setTimeout(() => tryGoProject(retries - 1), 1500);
              } else {
                setScreen("projects");
              }
            }).catch(() => setScreen("projects"));
          };
          tryGoProject();
          unsubscribeRealtimeDraft();
          return;
        }

        // 일반 데이터 업데이트 — DB data를 그대로 사용 (participants→members 재merge 제거)
        // handleJoinRealtimeDraft에서 이미 members에 추가 + sbUpdateDraftData로 저장했으므로 중복 merge 불필요
        setOnData(newData);
        setDraftParticipants(newParts);
      })
      .subscribe();
    realtimeChannelRef.current = channel;
  };

  const unsubscribeRealtimeDraft = () => {
    if (realtimeChannelRef.current) {
      supabase.removeChannel(realtimeChannelRef.current);
      realtimeChannelRef.current = null;
    }
    setRealtimeDraftId(null);
    setRealtimeDraftCode(null);
    setDraftParticipants([]);
  };

  // 팀장: 온보딩 시작 시 draft 생성 — 자기 자신도 참가자로 등록
  const handleCreateRealtimeDraft = async () => {
    if (!currentAccount) return;
    try {
      // 팀장 본인도 members에 포함
      const ownerMember = { id: "self", name: loginName };
      const initialData = { members: [ownerMember] };
      const draft = await sbCreateDraft(currentAccount.id, initialData);
      setRealtimeDraftId(draft.id);
      setRealtimeDraftCode(draft.invite_code);
      setIsOwnerDraft(true);
      subscribeToRealtimeDraft(draft.id);
      return draft;
    } catch (e) {
      notify("공동 작업 초안 생성 실패: " + e.message, "err");
      return null;
    }
  };

  // 팀원: 초대 코드로 draft 참가
  const handleJoinRealtimeDraft = async (code) => {
    try {
      const draft = await sbGetDraftByCode(code);
      if (!draft) throw new Error("유효하지 않은 초대 코드입니다.");
      // 참가자로 등록 (#3: participants에 추가 → Realtime으로 팀장 화면에 반영)
      await sbJoinDraft(draft.id, {
        accountId: currentAccount.id,
        name: loginName,
        joinedAt: new Date().toISOString(),
      });
      // 현재 data에 내 이름을 members에 추가해서 DB 업데이트 (중복 방지)
      const curData = draft.data || {};
      const curMembers = curData.members || [];
      // 이름+accountId 기준 중복 체크
      const alreadyIn = curMembers.find(m => m.name === loginName || m.accountId === currentAccount.id);
      const newMembers = alreadyIn ? curMembers : [...curMembers, { id: uid(), name: loginName, accountId: currentAccount.id }];
      if (!alreadyIn) {
        await sbUpdateDraftData(draft.id, { ...curData, members: newMembers });
      }
      setRealtimeDraftId(draft.id);
      setRealtimeDraftCode(draft.invite_code);
      setIsOwnerDraft(false);
      setOnData({ ...curData, members: newMembers }); // 중복 없이
      setDraftParticipants([...(draft.participants || []), { accountId: currentAccount.id, name: loginName }]);
      subscribeToRealtimeDraft(draft.id);
      notify(`✅ 공동 작업에 참가했습니다!`);
      setScreen("onboard");
      setOnStep(0);
      return draft;
    } catch (e) {
      notify(e.message || "참가 실패", "err");
      return null;
    }
  };

  // onData가 바뀔 때마다 DB draft에도 저장 (팀장만)
  const syncOnDataToRealtimeDraft = useCallback(async (data) => {
    if (!realtimeDraftId || !isOwnerDraft) return;
    try { await sbUpdateDraftData(realtimeDraftId, data); } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realtimeDraftId, isOwnerDraft]);

  const handleLogin = async (username, pw) => {
    setLoading(true);
    try {
      const account = await sbGetAccountByUsername(username);
      if (!account) throw new Error("존재하지 않는 아이디입니다.");
      if (account.pw_hash !== simpleHash(pw)) throw new Error("아이디 또는 비밀번호가 올바르지 않습니다.");
      const user = await sbGetOrCreateUserForAccount(account);
      setCurrentAccount(account); setCurrentUser(user);
      setLoginName(account.name || account.username);
      // 세션 저장
      try { localStorage.setItem(SESSION_KEY, JSON.stringify({ username: account.username })); } catch {}
      // 계정별 임시저장 로드
      setDrafts(loadDrafts(account.username));
      const projs = await sbGetMyProjects(account.id);
      setProjects(projs); setScreen("projects");
      notify(`환영합니다, ${account.name || account.username}님! 👋`);
      const todayStr = new Date().toISOString().slice(0, 10);
      const displayName = account.name || account.username;
      const overdueCount = projs.flatMap(p =>
        p.procedures.flatMap(proc =>
          proc.tasks.filter(t => (t.memberName === displayName) && t.deadline && t.deadline < todayStr && t.status !== "done")
        )
      ).length;
      if (overdueCount > 0) setTimeout(() => addNotif(`⚠️ 기한이 초과된 내 작업이 ${overdueCount}개 있습니다. 확인해주세요!`, "⚠️"), 500);
    } catch (e) { throw e; }
    finally { setLoading(false); }
  };
  const handleSignup = async (username, displayName, pw) => {
    setLoading(true);
    try {
      const exists = await sbCheckUsernameExists(username);
      if (exists) throw new Error("이미 사용 중인 아이디입니다.");
      const account = await sbCreateAccount(username, displayName, simpleHash(pw));
      const user = await sbGetOrCreateUserForAccount(account);
      setCurrentAccount(account); setCurrentUser(user);
      setLoginName(account.name || account.username);
      // 세션 저장
      try { localStorage.setItem(SESSION_KEY, JSON.stringify({ username: account.username })); } catch {}
      setDrafts([]); // 신규 가입은 초안 없음
      const projs = await sbGetMyProjects(account.id);
      setProjects(projs); setScreen("projects");
      notify(`가입 완료! 환영합니다, ${displayName}님! 🎉`);
    } catch (e) { throw e; }
    finally { setLoading(false); }
  };
  const handleLogout = () => {
    setScreen("login"); setProjects([]); setActive(null);
    setLoginName(""); setCurrentAccount(null); setCurrentUser(null);
    setOnData({}); setOnStep(0); setActiveDraftId(null);
    setDrafts([]); // 로그아웃 시 화면에서 초안 제거 (localStorage는 유지)
    unsubscribeRealtimeDraft();
    try { localStorage.removeItem(SESSION_KEY); } catch {}
    notify("로그아웃 되었습니다.");
  };
  const handleCreateProject = async (data) => {
    if (isCreating) return;
    setIsCreating(true);
    // 팀원들에게 "생성 중" 신호 전송
    if (realtimeDraftId) {
      sbUpdateDraftData(realtimeDraftId, { ...data, _creating: true }).catch(() => {});
    }
    try {
      const projectName = (data.projectName || "").trim() || "새 프로젝트";
      const onboardMembers = data.members || [];
      // 이름 기준 중복 제거 (같은 이름은 accountId 있는 것 우선)
      const dedupedMembers = [];
      const seenNames = new Set();
      // accountId 있는 것 먼저
      [...onboardMembers].sort((a, b) => (b.accountId ? 1 : 0) - (a.accountId ? 1 : 0)).forEach(m => {
        if (!seenNames.has(m.name)) { seenNames.add(m.name); dedupedMembers.push(m); }
      });
      const rawOthers = dedupedMembers.filter(m => m.id !== "self");
      // 가입된 참가자는 account_id로 기존 user 조회, 미가입자는 이름으로 생성
      const otherUsers = await Promise.all(rawOthers.map(async m => {
        if (m.accountId) {
          // Realtime 공동작업으로 추가된 가입 유저 — users 테이블에서 account_id로 조회
          const { data: existingUser } = await supabase.from("users").select("*").eq("account_id", m.accountId).maybeSingle();
          if (existingUser) return existingUser;
          // 없으면 account 기반으로 생성
          const acc = await sbGetAccountByUsername(m.username || m.name).catch(() => null);
          if (acc) return sbGetOrCreateUserForAccount(acc);
        }
        return sbCreateMemberByName(m.name);
      }));
      const dbUserMap = { "self": { ...currentUser, account_id: currentAccount.id } };
      rawOthers.forEach((om, i) => { dbUserMap[om.id] = otherUsers[i]; });
      const onboardRoles = data.roles || BASE_ROLES.map(r => ({ ...r }));
      const roleAssignments = data.roleAssignments || {};
      const roleById = Object.fromEntries(onboardRoles.map(r => [r.id, r]));
      const memberUsers = dedupedMembers.map(om => {
        const dbUser = dbUserMap[om.id];
        if (!dbUser) return null;
        const assign = roleAssignments[om.id] || {};
        const toRole = rid => rid && roleById[rid] ? { name: roleById[rid].name, icon: roleById[rid].icon, color: roleById[rid].color } : null;
        return { ...dbUser, memberRoles: { lead: toRole(assign.lead), support1: toRole(assign.support1), support2: toRole(assign.support2) } };
      }).filter(Boolean);
      const proceduresWithFlow = Object.assign(data.procedures || [], { _flowGraph: data.flowGraph || null });
      const created = await sbCreateProject({
        name: projectName, topic: data.topic || "",
        startDate: data.startDate || null, endDate: data.endDate || null,
        ownerAccountId: currentAccount.id, ownerUserId: currentUser.id,
        members: memberUsers, procedures: proceduresWithFlow,
      });

      // 생성된 프로젝트만 빠르게 조회 (전체 sbGetMyProjects 대신)
      const [newProjData, allRoles] = await Promise.all([
        supabase.from("projects").select(`
          id, name, topic, start_date, end_date, owner_account_id, invite_code, created_at, flow_graph, gantt_edit_perm,
          procedures ( id, name, icon, color, order_index,
            tasks ( id, procedure_id, title, member_id, status, note, files, deadline, comments, start_date, start_time, deadline_time )
          ),
          project_members ( id, user_id, account_id, role, users ( id, name, account_id ) )
        `).eq("id", created.id).single(),
        supabase.from("member_roles").select("*").eq("project_id", created.id),
      ]);
      const newProj = newProjData.data ? dbProjectToApp(newProjData.data, allRoles.data || []) : null;
      if (newProj) {
        setProjects(prev => [...prev.filter(p => p.id !== newProj.id), newProj]);
        // 구독을 먼저 해제하고 새 프로젝트로 이동 (생성 중 INSERT 이벤트로 덮어쓰기 방지)
        if (projectRealtimeRef.current) {
          supabase.removeChannel(projectRealtimeRef.current);
          projectRealtimeRef.current = null;
        }
        setActive(newProj);
        setTab("dashboard");
        setScreen("project");
        try {
          const raw = localStorage.getItem(SESSION_KEY);
          const sess = raw ? JSON.parse(raw) : {};
          localStorage.setItem(SESSION_KEY, JSON.stringify({ ...sess, lastScreen: "project", lastProjectId: newProj.id, lastTab: "dashboard" }));
        } catch {}
        // 생성 완료 후 2초 뒤에 Realtime 구독 등록 (생성 INSERT 이벤트 완료 후)
        setTimeout(() => subscribeProject(newProj.id), 2000);
      } else { setScreen("projects"); }
      // 완료된 초안 삭제
      if (activeDraftId) { deleteDraft(activeDraftId); setActiveDraftId(null); }

      // 공동작업: finishedProjectId 브로드캐스트만 (팀원 등록은 sbCreateProject에서 이미 완료)
      if (realtimeDraftId) {
        try {
          const { _creating, ...dataWithoutCreating } = data;
          await sbUpdateDraftData(realtimeDraftId, { ...dataWithoutCreating, _creating: false, _finishedProjectId: created.id });
          setTimeout(() => sbDeleteDraft(realtimeDraftId).catch(() => {}), 4000);
        } catch (e) { console.warn("Realtime broadcast error:", e); }
        unsubscribeRealtimeDraft();
      }
      setOnData({}); setOnStep(0);
      notify("프로젝트가 생성되었습니다! 🎉");
    } catch (e) { notify(e.message, "err"); }
    finally { setIsCreating(false); }
  };
  const handleDeleteProject = async (id) => {
    setLoading(true);
    try {
      await sbDeleteProject(id); setProjects(ps => ps.filter(x => x.id !== id));
      if (active?.id === id) { setActive(null); setScreen("projects"); }
      notify("프로젝트가 삭제되었습니다.");
    } catch (e) { notify("삭제 실패: " + e.message, "err"); }
    finally { setLoading(false); }
  };
  const handleUpdateProject = async (id, updates) => {
    try {
      await sbUpdateProject(id, updates);
      const updated = { ...projects.find(p => p.id === id), ...updates };
      setProjects(ps => ps.map(p => p.id === id ? updated : p));
      if (active?.id === id) setActive(updated);
      notify("프로젝트 정보가 수정되었습니다.");
    } catch (e) { notify("수정 실패: " + e.message, "err"); }
  };
  const handleJoinByCode = async (code) => {
    setLoading(true);
    try {
      const proj = await sbGetProjectByInviteCode(code);
      if (!proj) throw new Error("유효하지 않은 초대 코드입니다.");
      await sbAcceptInvite(proj.id, currentAccount.id, currentUser.id);
      const projs = await sbGetMyProjects(currentAccount.id);
      setProjects(projs); notify("✅ 프로젝트에 참여했습니다!");
    } catch (e) { notify(e.message || "참여 실패", "err"); }
    finally { setLoading(false); }
  };
  const handleRegenCode = async (projectId) => {
    try {
      const newCode = await sbRegenInviteCode(projectId);
      setProjects(ps => ps.map(p => p.id === projectId ? { ...p, inviteCode: newCode } : p));
      if (active?.id === projectId) setActive(prev => ({ ...prev, inviteCode: newCode }));
      notify("초대 코드가 재발급되었습니다."); return newCode;
    } catch (e) { notify("재발급 실패: " + e.message, "err"); }
  };
  const updateProject = p => { setActive(p); setProjects(ps => ps.map(x => x.id === p.id ? p : x)); };

  const handleTaskChange = async (project, procId, taskId, changes) => {
    try {
      await sbUpdateTask(taskId, changes);
      const updatedProject = {
        ...project,
        procedures: project.procedures.map(p =>
          p.id === procId ? { ...p, tasks: p.tasks.map(t => t.id === taskId ? { ...t, ...changes } : t) } : p
        ),
      };
      syncProject(updatedProject);
      // 작업 완료 시 알림
      if (changes.status === "done") {
        const task = project.procedures.flatMap(p => p.tasks).find(t => t.id === taskId);
        if (task) addNotif(`✅ "${task.title}" 작업이 완료되었습니다.`, "✅");
      }
    } catch (e) { notify("저장 실패: " + e.message, "err"); }
  };
  const handleAddTask = async (project, procId, title, memberId = null, startDate = null, deadline = null) => {
    try {
      const created = await sbCreateTask({ projectId: project.id, procedureId: procId, title, memberId, startDate, deadline });
      const memberName = memberId ? project.members.find(m=>m.id===memberId)?.name || "미할당" : "미할당";
      const newTask = { id: created.id, title, memberId: memberId||"", memberName, status: "todo", note: "", files: [], deadline: deadline||"", startDate: startDate||"", comments: [] };
      syncProject({ ...project, procedures: project.procedures.map(p => p.id === procId ? { ...p, tasks: [...p.tasks, newTask] } : p) });
      notify("작업이 추가되었습니다.");
    } catch (e) { notify("작업 추가 실패: " + e.message, "err"); }
  };
  const handleDeleteTask = async (project, procId, taskId) => {
    try {
      await sbDeleteTask(taskId);
      syncProject({ ...project, procedures: project.procedures.map(p => p.id === procId ? { ...p, tasks: p.tasks.filter(t => t.id !== taskId) } : p) });
      notify("작업이 삭제되었습니다.");
    } catch (e) { notify("삭제 실패: " + e.message, "err"); }
  };
  const handleAddProcedure = async (project, name) => {
    try {
      const created = await sbAddProcedure({ projectId: project.id, name: name || "새 단계", icon: "📌", color: "#6366f1", orderIndex: project.procedures.length });
      syncProject({ ...project, procedures: [...project.procedures, { id: created.id, name: created.name, icon: created.icon, color: created.color, tasks: [] }] });
      notify("단계가 추가되었습니다.");
    } catch (e) { notify("단계 추가 실패: " + e.message, "err"); }
  };
  const handleUpdateProcedure = async (project, procId, updates) => {
    try {
      await sbUpdateProcedure(procId, updates);
      syncProject({ ...project, procedures: project.procedures.map(p => p.id === procId ? { ...p, ...updates } : p) });
    } catch (e) { notify("수정 실패: " + e.message, "err"); }
  };
  const handleDeleteProcedure = async (project, procId) => {
    try {
      await sbDeleteProcedure(procId);
      syncProject({ ...project, procedures: project.procedures.filter(p => p.id !== procId) });
      notify("단계가 삭제되었습니다.");
    } catch (e) { notify("삭제 실패: " + e.message, "err"); }
  };
  const handleReorderProcedures = async (project, newProcedures) => {
    try {
      await sbUpdateProcedureOrders(newProcedures);
      syncProject({ ...project, procedures: newProcedures });
    } catch (e) { notify("저장 실패: " + e.message, "err"); }
  };
  const handleFileUpload = async (project, procId, task, files) => {
    try {
      let uploaded;
      try { uploaded = await Promise.all(files.map(f => sbUploadFile(task.id, f))); }
      catch { uploaded = files.map(f => ({ id: uid(), name: f.name, size: f.size, type: f.type, url: URL.createObjectURL(f), uploadedAt: new Date().toLocaleString("ko-KR") })); }
      const newFiles = [...(task.files || []), ...uploaded];
      await sbUpdateTask(task.id, { files: newFiles });
      syncProject({ ...project, procedures: project.procedures.map(p => p.id === procId ? { ...p, tasks: p.tasks.map(t => t.id === task.id ? { ...t, files: newFiles } : t) } : p) });
      notify(`📎 ${files.length}개 파일이 첨부되었습니다.`); return newFiles;
    } catch (e) { notify("파일 업로드 실패: " + e.message, "err"); return task.files || []; }
  };

  // 세션 복원 중 (초기 로딩) — screen이 "loading"이거나 loading=true이면 항상 로딩 화면
  if (screen === "loading" || (loading && screen !== "login")) return (
    <>
      <GlobalStyle dark={dark} />
      <div style={{ minHeight: "100vh", background: T.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Pretendard','Apple SD Gothic Neo',sans-serif" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ width: 44, height: 44, background: `linear-gradient(135deg,${T.accent},${T.accentSub})`, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, margin: "0 auto 16px" }}>🚀</div>
          <p style={{ color: T.textSub, fontSize: 14, fontWeight: 600 }}>Workend</p>
          <p style={{ color: T.textMuted, fontSize: 12, marginTop: 6 }}>{screen === "loading" ? "세션 복원 중..." : "로딩 중..."}</p>
        </div>
      </div>
    </>
  );
  if (screen === "creating") return (
    <div style={{ minHeight: "100vh", background: T.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Pretendard','Apple SD Gothic Neo',sans-serif" }}>
      <div style={{ textAlign: "center", padding: 40 }}>
        <div style={{ width: 60, height: 60, background: `linear-gradient(135deg,${T.accent},${T.accentSub})`, borderRadius: 16, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, margin: "0 auto 20px", animation: "pulse 1.5s ease-in-out infinite" }}>🚀</div>
        <h2 style={{ color: T.text, fontSize: 20, fontWeight: 800, marginBottom: 8 }}>프로젝트 생성 중...</h2>
        <p style={{ color: T.textSub, fontSize: 13, marginBottom: 4 }}>팀장이 프로젝트를 생성하고 있습니다.</p>
        <p style={{ color: T.textMuted, fontSize: 12 }}>잠시 후 자동으로 프로젝트에 참가됩니다.</p>
        <div style={{ marginTop: 24, display: "flex", gap: 8, justifyContent: "center" }}>
          {[0,1,2].map(i => (
            <div key={i} style={{ width: 8, height: 8, borderRadius: "50%", background: T.accent, animation: `bounce 1s ease-in-out ${i*0.2}s infinite` }} />
          ))}
        </div>
        {/* 안전 탈출 버튼 — 30초 후 표시 or Realtime 실패 시 */}
        <CreatingTimeout
          T={T}
          onProjectFound={async () => {
            // 5초마다 자동 폴링 — 프로젝트가 생성됐으면 자동 이동
            const aid = currentAccountRef.current?.id;
            if (!aid) return;
            const projs = await sbGetMyProjects(aid).catch(() => []);
            if (!projs.length) return;
            setProjects(projs);
            // 가장 최근 프로젝트 (내가 멤버인 것 중 최신)
            const newest = [...projs].sort((a,b) => new Date(b.created_at||0) - new Date(a.created_at||0))[0];
            if (newest) { unsubscribeRealtimeDraft(); goProject(newest); }
          }}
          onEscape={() => {
            unsubscribeRealtimeDraft();
            const aid = currentAccountRef.current?.id;
            if (aid) {
              sbGetMyProjects(aid).then(projs => {
                setProjects(projs); setScreen("projects");
              }).catch(() => setScreen("projects"));
            } else { setScreen("projects"); }
          }}
        />
      </div>
    </div>
  );
  if (screen === "login") return <><GlobalStyle dark={dark} /><LoginScreen T={T} dark={dark} setDark={setDark} onLogin={handleLogin} onSignup={handleSignup} globalLoading={loading} onGoogleLoading={setLoading} /></>;
  if (screen === "onboard") return (
    <OnboardScreen T={T} step={onStep} data={onData} setData={updater => {
      setOnData(prev => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        // Realtime draft DB 동기화 — debounce 1.5초 (타이핑마다 DB 호출 방지)
        if (realtimeDraftId) {
          if (draftSyncTimerRef.current) clearTimeout(draftSyncTimerRef.current);
          draftSyncTimerRef.current = setTimeout(() => {
            sbUpdateDraftData(realtimeDraftId, next).catch(() => {});
          }, 1500);
        }
        return next;
      });
    }} loginName={loginName} loading={isCreating}
      realtimeDraftCode={realtimeDraftCode}
      realtimeDraftId={realtimeDraftId}
      draftParticipants={draftParticipants}
      isOwnerDraft={isOwnerDraft}
      onCreateRealtimeDraft={handleCreateRealtimeDraft}
      onJoinRealtimeDraft={handleJoinRealtimeDraft}
      onGoHome={() => {
        if (onData.projectName || onData.members?.length) upsertDraft(activeDraftId, onData);
        unsubscribeRealtimeDraft();
        setScreen("projects");
      }}
      onNext={() => {
        if (onStep < 4) { setOnStep(s => s + 1); return; }
        // #4: 팀원은 직접 생성 안 함 — 팀장이 생성할 때까지 대기
        if (realtimeDraftId && !isOwnerDraft) {
          notify("팀장이 프로젝트를 생성할 때 자동으로 참가됩니다. 잠시 기다려주세요! ⏳");
          return;
        }
        if (!isCreating) handleCreateProject(onData);
      }}
      onBack={() => {
        if (onStep === 0) {
          if (onData.projectName || onData.members?.length) upsertDraft(activeDraftId, onData);
          unsubscribeRealtimeDraft();
          setScreen("projects");
        } else setOnStep(s => s - 1);
      }} />
  );
  if (screen === "project" && active) return (
    <><GlobalStyle dark={dark} /><ProjectScreen T={T} dark={dark} setDark={setDark}
      project={active} tab={tab} setTab={setTab}
      loginName={loginName} currentAccount={currentAccount}
      notifications={notifications} onClearNotif={clearNotifs} onAddNotif={addNotif}
      onUpdate={updateProject}
      onUpdateProject={updates => handleUpdateProject(active.id, updates)}
      onDeleteProject={() => handleDeleteProject(active.id)}
      onRegenCode={() => handleRegenCode(active.id)}
      onTaskChange={(procId, taskId, ch) => handleTaskChange(active, procId, taskId, ch)}
      onAddTask={(procId, title) => handleAddTask(active, procId, title)}
      onDeleteTask={(procId, taskId) => handleDeleteTask(active, procId, taskId)}
      onAddProcedure={name => handleAddProcedure(active, name)}
      onUpdateProcedure={(procId, upd) => handleUpdateProcedure(active, procId, upd)}
      onDeleteProcedure={procId => handleDeleteProcedure(active, procId)}
      onReorderProcedures={procs => handleReorderProcedures(active, procs)}
      onFileUpload={(procId, task, files) => handleFileUpload(active, procId, task, files)}
      notify={notify} onBack={() => setScreen("projects")}
      onGoHome={() => setScreen("projects")}
      sideCollapsed={sideCollapsed} onSideCollapse={setSideCollapsed} /></>
  );
  return (
    <><GlobalStyle dark={dark} /><ProjectsScreen T={T} dark={dark} setDark={setDark}
      projects={projects} loginName={loginName} currentAccount={currentAccount}
      toast={toast} notify={notify} notifications={notifications} onClearNotif={clearNotifs} onAddNotif={addNotif}
      sideCollapsed={sideCollapsed} onSideCollapse={setSideCollapsed}
      drafts={drafts} onDeleteDraft={deleteDraft}
      onOpen={p => { goProject(p); }}
      onNew={() => { setOnData({}); setOnStep(0); setActiveDraftId(null); setIsOwnerDraft(true); setScreen("onboard"); }}
      onResumeDraft={draft => { setOnData(draft.data); setOnStep(0); setActiveDraftId(draft.id); setIsOwnerDraft(true); setScreen("onboard"); }}
      onDelete={handleDeleteProject}
      onJoinByCode={handleJoinByCode}
      onJoinRealtimeDraft={async (code) => {
        setOnData({}); setOnStep(0); setActiveDraftId(null); setIsOwnerDraft(false);
        setScreen("onboard");
        setTimeout(() => handleJoinRealtimeDraft(code), 300);
      }}
      onLogout={handleLogout}
      onGoHome={() => setScreen("projects")} /></>
  );
}

// ─── SHARED COMPONENTS ────────────────────────────────────────────────────────
const Toast = ({ T, toast }) => toast ? (
  <div style={{
    position: "fixed", top: 20, right: 20, zIndex: 9999,
    padding: "11px 18px", borderRadius: 10, fontSize: 13, fontWeight: 600,
    background: toast.type === "ok" ? (T === DARK ? "#0a1a0a" : "#f0fdf4") : (T === DARK ? "#1a0a0a" : "#fef2f2"),
    border: `1px solid ${toast.type === "ok" ? "#10b98155" : "#ef444455"}`,
    color: toast.type === "ok" ? "#10b981" : "#ef4444",
    boxShadow: "0 8px 32px rgba(0,0,0,.25)",
  }}>{toast.msg}</div>
) : null;

const SideItem = ({ T, icon, label, active, onClick }) => (
  <div onClick={onClick} style={{
    display: "flex", alignItems: "center", gap: 10,
    padding: "8px 12px", borderRadius: 8, cursor: "pointer", marginBottom: 2,
    background: active ? `${T.accent}18` : "transparent",
    border: active ? `1px solid ${T.accent}33` : "1px solid transparent",
    transition: "all .15s",
  }}>
    <span style={{ fontSize: 14 }}>{icon}</span>
    <span style={{ color: active ? T.accent : T.textSub, fontSize: 13, fontWeight: active ? 700 : 400 }}>{label}</span>
  </div>
);
const ThemeToggle = ({ T, dark, setDark }) => (
  <button onClick={() => setDark(d => !d)} style={{
    width: 32, height: 32, borderRadius: 8, background: T.surfaceHover,
    border: `1px solid ${T.border2}`, cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center", color: T.textSub,
  }}>
    <SVG d={dark ? I.sun : I.moon} size={14} />
  </button>
);
const Inp = ({ T, value, onChange, placeholder, type = "text", style = {}, ...rest }) => (
  <input type={type} value={value} onChange={onChange} placeholder={placeholder}
    style={{ width: "100%", padding: "10px 14px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 8, color: T.text, fontSize: 13, outline: "none", boxSizing: "border-box", fontFamily: "inherit", ...style }}
    {...rest} />
);

// ─── TASK DETAIL MODAL (파일+노트+댓글+데드라인) ─────────────────────────────
function TaskDetailModal({ T, task, members, onClose, onChange, onFileUpload, loginName }) {
  const [noteVal, setNoteVal]       = useState(task.note || "");
  const [commentVal, setCommentVal] = useState("");
  const [editTitle, setEditTitle]   = useState(false);
  const [titleVal, setTitleVal]     = useState(task.title);
  const [deadline, setDeadline]     = useState(task.deadline || "");
  const [memberId, setMemberId]     = useState(task.memberId || "");
  const [status, setStatus]         = useState(task.status || "todo");
  const fileInputRef = useRef();

  const saveNote = () => onChange({ note: noteVal });
  const saveDeadline = () => onChange({ deadline });
  const saveMember = (v) => { setMemberId(v); const m = members.find(x => x.id === v); onChange({ memberId: v, memberName: m?.name || "미할당" }); };
  const cycleStatus = () => { const order = ["todo","doing","done"]; const next = order[(order.indexOf(status)+1)%3]; setStatus(next); onChange({ status: next }); };
  const addComment = () => {
    if (!commentVal.trim()) return;
    const newComments = [...(task.comments || []), { id: uid(), author: loginName, text: commentVal.trim(), createdAt: new Date().toLocaleString("ko-KR") }];
    onChange({ comments: newComments }); setCommentVal("");
  };
  const deleteComment = (id) => { const newC = (task.comments || []).filter(c => c.id !== id); onChange({ comments: newC }); };
  const handleFiles = e => { const fs = Array.from(e.target.files); if (fs.length) { onFileUpload(fs); e.target.value = ""; } };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: 680, maxHeight: "90vh", overflowY: "auto", background: T.surface, borderRadius: 20, border: `1px solid ${T.border}`, boxShadow: "0 24px 80px rgba(0,0,0,0.4)" }}>
        {/* 헤더 */}
        <div style={{ padding: "20px 24px 16px", borderBottom: `1px solid ${T.border}` }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
            <button onClick={cycleStatus} style={{ flexShrink: 0, width: 22, height: 22, borderRadius: 6, border: `2px solid ${SC[status]}`, background: status === "done" ? SC[status] : "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", marginTop: 3 }}>
              {status === "done" && <SVG d={I.check} size={11} style={{ color: "#fff" }} />}
            </button>
            {editTitle ? (
              <input autoFocus value={titleVal} onChange={e => setTitleVal(e.target.value)}
                onBlur={() => { onChange({ title: titleVal }); setEditTitle(false); }}
                onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()}
                style={{ flex: 1, fontSize: 18, fontWeight: 700, color: T.text, background: "transparent", border: "none", borderBottom: `2px solid ${T.accent}`, outline: "none", fontFamily: "inherit" }} />
            ) : (
              <h2 onClick={() => setEditTitle(true)} style={{ flex: 1, fontSize: 18, fontWeight: 700, color: T.text, cursor: "text", textDecoration: status === "done" ? "line-through" : "none" }}>{task.title}</h2>
            )}
            <button onClick={onClose} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 20, lineHeight: 1 }}>×</button>
          </div>
          {/* 메타 정보 row */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {/* 담당자 */}
            <div>
              <label style={{ display: "block", color: T.textMuted, fontSize: 10, fontWeight: 700, marginBottom: 4, textTransform: "uppercase" }}>담당자</label>
              <select value={memberId} onChange={e => saveMember(e.target.value)}
                style={{ padding: "6px 10px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 7, color: T.text, fontSize: 12, outline: "none", fontFamily: "inherit" }}>
                <option value="">미할당</option>
                {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            {/* 상태 */}
            <div>
              <label style={{ display: "block", color: T.textMuted, fontSize: 10, fontWeight: 700, marginBottom: 4, textTransform: "uppercase" }}>상태</label>
              <button onClick={cycleStatus} style={{ padding: "6px 12px", borderRadius: 7, border: `1px solid ${SC[status]}44`, background: `${SC[status]}18`, color: SC[status], fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                {ST[status]}
              </button>
            </div>
            {/* 데드라인 */}
            <div>
              <label style={{ display: "block", color: T.textMuted, fontSize: 10, fontWeight: 700, marginBottom: 4, textTransform: "uppercase" }}>데드라인</label>
              <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)} onBlur={saveDeadline}
                style={{ padding: "6px 10px", background: T.surfaceHover, border: `1px solid ${deadline ? T.accent : T.border2}`, borderRadius: 7, color: deadline ? T.accent : T.textSub, fontSize: 12, outline: "none", fontFamily: "inherit", cursor: "pointer" }} />
            </div>
          </div>
        </div>

        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 22 }}>
          {/* 노트 */}
          <div>
            <label style={{ display: "block", color: T.textSub, fontSize: 12, fontWeight: 700, marginBottom: 8 }}>📝 작업 노트</label>
            <textarea value={noteVal} onChange={e => setNoteVal(e.target.value)} onBlur={saveNote}
              placeholder="이 작업에 대한 메모를 남겨주세요..."
              style={{ width: "100%", minHeight: 100, padding: "12px 14px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 10, color: T.text, fontSize: 13, outline: "none", resize: "vertical", fontFamily: "inherit", lineHeight: 1.6, boxSizing: "border-box" }} />
          </div>

          {/* 파일 */}
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <label style={{ color: T.textSub, fontSize: 12, fontWeight: 700 }}>📎 첨부 파일 ({(task.files || []).length})</label>
              <button onClick={() => fileInputRef.current?.click()} style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 12px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 7, color: T.textSub, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>
                <SVG d={I.upload} size={11} /> 파일 추가
              </button>
              <input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={handleFiles} />
            </div>
            {(task.files || []).length === 0 ? (
              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.background = `${T.accent}08`; }}
                onDragLeave={e => { e.currentTarget.style.borderColor = T.border2; e.currentTarget.style.background = T.surfaceHover; }}
                onDrop={e => { e.preventDefault(); e.currentTarget.style.borderColor = T.border2; e.currentTarget.style.background = T.surfaceHover; const fs = Array.from(e.dataTransfer.files); if (fs.length) onFileUpload(fs); }}
                style={{ padding: "22px 16px", background: T.surfaceHover, border: `2px dashed ${T.border2}`, borderRadius: 10, textAlign: "center", cursor: "pointer", color: T.textMuted, fontSize: 12, transition: "all .15s" }}>
                <div style={{ fontSize: 24, marginBottom: 6 }}>📎</div>
                <p style={{ fontWeight: 600, marginBottom: 2 }}>파일을 드래그하거나 클릭하여 업로드</p>
                <p style={{ fontSize: 10 }}>이미지, PDF, 문서 등 모든 파일 지원</p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {(task.files || []).map(f => {
                  const emoji = f.type?.startsWith("image/") ? "🖼️" : f.type?.includes("pdf") ? "📄" : f.name?.match(/\.(xlsx|xls)$/i) ? "📊" : f.name?.match(/\.(doc|docx)$/i) ? "📝" : "📎";
                  return (
                    <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: T.surfaceHover, borderRadius: 8, border: `1px solid ${T.border}` }}>
                      <span style={{ fontSize: 16 }}>{emoji}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ color: T.text, fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</p>
                        <p style={{ color: T.textMuted, fontSize: 10 }}>{((f.size || 0) / 1024).toFixed(1)}KB · {f.uploadedAt}</p>
                      </div>
                      <a href={f.url} target="_blank" rel="noreferrer" download={f.name} style={{ color: T.accent, fontSize: 11, padding: "3px 8px", background: `${T.accent}15`, borderRadius: 5, border: `1px solid ${T.accent}33`, textDecoration: "none" }}>열기</a>
                      <button onClick={() => onChange({ files: (task.files || []).filter(x => x.id !== f.id) })} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 2 }} onMouseEnter={e => e.currentTarget.style.color = T.danger} onMouseLeave={e => e.currentTarget.style.color = T.textMuted}><SVG d={I.x} size={12} /></button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 댓글 */}
          <div>
            <label style={{ display: "block", color: T.textSub, fontSize: 12, fontWeight: 700, marginBottom: 8 }}>💬 댓글 ({(task.comments || []).length})</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
              {(task.comments || []).map(c => (
                <div key={c.id} style={{ padding: "10px 13px", background: T.surfaceHover, borderRadius: 10, border: `1px solid ${T.border}` }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <div style={{ width: 22, height: 22, borderRadius: "50%", background: T.accent, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 10, fontWeight: 700 }}>{c.author[0]}</div>
                      <span style={{ color: T.text, fontSize: 12, fontWeight: 700 }}>{c.author}</span>
                      <span style={{ color: T.textMuted, fontSize: 10 }}>{c.createdAt}</span>
                    </div>
                    {c.author === loginName && (
                      <button onClick={() => deleteComment(c.id)} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 2 }} onMouseEnter={e => e.currentTarget.style.color = T.danger} onMouseLeave={e => e.currentTarget.style.color = T.textMuted}><SVG d={I.trash} size={11} /></button>
                    )}
                  </div>
                  <p style={{ color: T.text, fontSize: 12, lineHeight: 1.6 }}>{c.text}</p>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input value={commentVal} onChange={e => setCommentVal(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addComment()}
                placeholder="댓글 입력 후 Enter..."
                style={{ flex: 1, padding: "9px 13px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 8, color: T.text, fontSize: 12, outline: "none", fontFamily: "inherit" }} />
              <button onClick={addComment} style={{ padding: "9px 16px", background: T.accent, border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>작성</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
function LoginScreen({ T, dark, setDark, onLogin, onSignup, globalLoading = false, onGoogleLoading }) {
  const [mode, setMode] = useState("login");
  const [loginId, setLoginId] = useState("");
  const [loginPw, setLoginPw] = useState("");
  const [signupId, setSignupId] = useState("");
  const [signupName, setSignupName] = useState("");
  const [signupPw, setSignupPw] = useState("");
  const [signupPwC, setSignupPwC] = useState("");
  const [idChecked, setIdChecked] = useState(false);
  const [idAvail, setIdAvail] = useState(null);
  const [googleLoading, setGoogleLoading] = useState(false);

  const handleGoogleLogin = async () => {
    setGoogleLoading(true);
    if (onGoogleLoading) onGoogleLoading(true); // 앱 로딩 화면 표시
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: window.location.href.split("?")[0].split("#")[0],
          queryParams: { access_type: "offline", prompt: "consent" },
        },
      });
      if (error) throw error;
      // 리디렉션 전까지 로딩 상태 유지
    } catch (e) {
      alert("구글 로그인 실패: " + (e.message || "다시 시도해주세요."));
      setGoogleLoading(false);
      if (onGoogleLoading) onGoogleLoading(false);
    }
  };
  const [idChecking, setIdChecking] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const isDisabled = busy || globalLoading;

  const EYE_ON  = "M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19M1 1l22 22M10.73 10.73A3 3 0 0013.27 13.27";
  const EYE_OFF = "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 9a3 3 0 100 6 3 3 0 000-6z";

  const inputStyle = { width: "100%", padding: "10px 14px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 9, color: T.text, fontSize: 13, outline: "none", boxSizing: "border-box", fontFamily: "inherit", marginBottom: 10, transition: "border-color .2s" };
  const onFocus = e => e.target.style.borderColor = T.accent;
  const onBlur  = e => e.target.style.borderColor = T.border2;
  const Label = ({ children }) => <label style={{ display: "block", color: T.textSub, fontSize: 11, fontWeight: 700, marginBottom: 5, textTransform: "uppercase", letterSpacing: .5 }}>{children}</label>;

  const checkId = async () => {
    if (!signupId.trim()) { setErr("아이디를 입력해주세요."); return; }
    if (signupId.trim().length < 3) { setErr("아이디는 3자 이상이어야 합니다."); return; }
    setIdChecking(true); setErr("");
    try {
      const exists = await sbCheckUsernameExists(signupId.trim());
      setIdAvail(!exists); setIdChecked(true);
      if (exists) setErr("이미 사용 중인 아이디입니다.");
    } catch { setErr("중복 확인 중 오류가 발생했습니다."); }
    finally { setIdChecking(false); }
  };
  const onSignupIdChange = v => { setSignupId(v); setIdChecked(false); setIdAvail(null); setErr(""); };

  const goLogin = async () => {
    setErr("");
    if (!loginId.trim()) { setErr("아이디를 입력해주세요."); return; }
    if (!loginPw) { setErr("비밀번호를 입력해주세요."); return; }
    setBusy(true);
    try { await onLogin(loginId.trim(), loginPw); }
    catch (e) { setErr(e.message?.includes("Failed to fetch") ? "서버에 연결할 수 없습니다." : e.message || "아이디 또는 비밀번호가 올바르지 않습니다."); }
    finally { setBusy(false); }
  };
  const goSignup = async () => {
    setErr("");
    if (!signupId.trim()) { setErr("아이디를 입력해주세요."); return; }
    if (!idChecked) { setErr("아이디 중복 확인을 해주세요."); return; }
    if (!idAvail) { setErr("이미 사용 중인 아이디입니다."); return; }
    if (!signupName.trim()) { setErr("이름을 입력해주세요."); return; }
    if (signupPw.length < 4) { setErr("비밀번호는 4자 이상이어야 합니다."); return; }
    if (signupPw !== signupPwC) { setErr("비밀번호가 일치하지 않습니다."); return; }
    setBusy(true);
    try { await onSignup(signupId.trim(), signupName.trim(), signupPw); }
    catch (e) { setErr(e.message || "회원가입 중 오류가 발생했습니다."); }
    finally { setBusy(false); }
  };
  const switchMode = m => { setMode(m); setErr(""); setLoginId(""); setLoginPw(""); setSignupId(""); setSignupName(""); setSignupPw(""); setSignupPwC(""); setIdChecked(false); setIdAvail(null); };

  return (
    <div style={{ minHeight: "100vh", background: T.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Pretendard','Apple SD Gothic Neo',sans-serif" }}>
      <div style={{ position: "absolute", top: 20, right: 20 }}><ThemeToggle T={T} dark={dark} setDark={setDark} /></div>
      <div style={{ width: 420, padding: "44px 40px", background: T.surface, borderRadius: 24, border: `1px solid ${T.border}`, boxShadow: dark ? "0 32px 80px rgba(0,0,0,.6)" : "0 8px 48px rgba(0,0,0,.1)" }}>
        <div style={{ width: 52, height: 52, background: `linear-gradient(135deg,${T.accent},${T.accentSub})`, borderRadius: 14, margin: "0 auto 18px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>🚀</div>
        <h1 style={{ color: T.text, fontSize: 24, fontWeight: 800, textAlign: "center", marginBottom: 4 }}>Workend</h1>
        <p style={{ color: T.textSub, fontSize: 12, textAlign: "center", marginBottom: 28 }}>팀 프로젝트를 스마트하게 관리하세요</p>
        <div style={{ display: "flex", background: T.surfaceHover, borderRadius: 10, padding: 3, marginBottom: 24, border: `1px solid ${T.border}` }}>
          {[["login","로그인"],["signup","회원가입"]].map(([m, label]) => (
            <button key={m} onClick={() => switchMode(m)} style={{ flex: 1, padding: "8px 0", border: "none", borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700, transition: "all .2s", background: mode === m ? T.surface : "transparent", color: mode === m ? T.text : T.textMuted, boxShadow: mode === m ? "0 1px 4px rgba(0,0,0,.12)" : "none" }}>{label}</button>
          ))}
        </div>
        {mode === "login" && (
          <>
            <Label>아이디</Label>
            <input value={loginId} onChange={e => { setLoginId(e.target.value); setErr(""); }} onKeyDown={e => e.key === "Enter" && goLogin()} onFocus={onFocus} onBlur={onBlur} placeholder="아이디 입력" style={inputStyle} />
            <Label>비밀번호</Label>
            <div style={{ position: "relative", marginBottom: 10 }}>
              <input type={showPw ? "text" : "password"} value={loginPw} onChange={e => { setLoginPw(e.target.value); setErr(""); }} onKeyDown={e => e.key === "Enter" && goLogin()} onFocus={onFocus} onBlur={onBlur} placeholder="비밀번호 입력" style={{ ...inputStyle, marginBottom: 0, paddingRight: 42 }} />
              <button onClick={() => setShowPw(v => !v)} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 2 }}><SVG d={showPw ? EYE_ON : EYE_OFF} size={15} /></button>
            </div>
          </>
        )}
        {mode === "signup" && (
          <>
            <Label>아이디</Label>
            <div style={{ display: "flex", gap: 7, marginBottom: 10 }}>
              <input value={signupId} onChange={e => onSignupIdChange(e.target.value)} onKeyDown={e => e.key === "Enter" && checkId()} onFocus={onFocus} onBlur={onBlur} placeholder="영문/숫자 3자 이상" style={{ ...inputStyle, marginBottom: 0, flex: 1, borderColor: idChecked ? (idAvail ? T.success : T.danger) : T.border2 }} />
              <button onClick={checkId} disabled={idChecking} style={{ padding: "10px 14px", background: idChecked && idAvail ? T.success : T.accent, border: "none", borderRadius: 9, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap", flexShrink: 0 }}>{idChecking ? "확인 중..." : idChecked && idAvail ? "✓ 사용가능" : "중복확인"}</button>
            </div>
            {idChecked && idAvail && <p style={{ color: T.success, fontSize: 11, marginBottom: 8, marginTop: -6 }}>✅ 사용 가능한 아이디입니다.</p>}
            <Label>이름 (표시 이름)</Label>
            <input value={signupName} onChange={e => { setSignupName(e.target.value); setErr(""); }} onFocus={onFocus} onBlur={onBlur} placeholder="홍길동" style={inputStyle} />
            <Label>비밀번호</Label>
            <div style={{ position: "relative", marginBottom: 10 }}>
              <input type={showPw ? "text" : "password"} value={signupPw} onChange={e => { setSignupPw(e.target.value); setErr(""); }} onFocus={onFocus} onBlur={onBlur} placeholder="4자 이상 입력" style={{ ...inputStyle, marginBottom: 0, paddingRight: 42 }} />
              <button onClick={() => setShowPw(v => !v)} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 2 }}><SVG d={showPw ? EYE_ON : EYE_OFF} size={15} /></button>
            </div>
            <Label>비밀번호 확인</Label>
            <div style={{ position: "relative", marginBottom: 10 }}>
              <input type={showPw ? "text" : "password"} value={signupPwC} onChange={e => { setSignupPwC(e.target.value); setErr(""); }} onFocus={onFocus} onBlur={onBlur} placeholder="비밀번호 재입력" style={{ ...inputStyle, marginBottom: 0, paddingRight: 42, borderColor: signupPwC && signupPw !== signupPwC ? T.danger : T.border2 }} />
              {signupPwC && <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: signupPw === signupPwC ? T.success : T.danger }}>{signupPw === signupPwC ? "✓" : "✗"}</span>}
            </div>
          </>
        )}
        {err && <div style={{ padding: "10px 14px", background: `${T.danger}12`, border: `1px solid ${T.danger}44`, borderRadius: 9, color: T.danger, fontSize: 12, marginBottom: 12, fontWeight: 600 }}>⚠️ {err}</div>}
        <button onClick={mode === "login" ? goLogin : goSignup} disabled={isDisabled} style={{ width: "100%", padding: "12px 0", border: "none", borderRadius: 10, cursor: isDisabled ? "default" : "pointer", marginTop: 4, background: isDisabled ? T.border2 : `linear-gradient(135deg,${T.accent},${T.accentSub})`, color: isDisabled ? T.textMuted : "#fff", fontSize: 14, fontWeight: 700, fontFamily: "inherit", transition: "all .2s" }}>
          {(busy || globalLoading) ? "처리 중..." : mode === "login" ? "로그인" : "회원가입"}
        </button>

        {/* 구분선 */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0" }}>
          <div style={{ flex: 1, height: 1, background: T.border2 }} />
          <span style={{ color: T.textMuted, fontSize: 11 }}>또는</span>
          <div style={{ flex: 1, height: 1, background: T.border2 }} />
        </div>

        {/* 구글 로그인 */}
        <button onClick={handleGoogleLogin} disabled={googleLoading || globalLoading}
          style={{ width: "100%", padding: "11px 0", border: `1px solid ${T.border2}`, borderRadius: 10, cursor: googleLoading ? "default" : "pointer", background: T.surfaceHover, color: T.text, fontSize: 13, fontWeight: 600, fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, transition: "all .2s" }}
          onMouseEnter={e => { if (!googleLoading) e.currentTarget.style.borderColor = "#4285f4"; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = T.border2; }}>
          {/* Google G 로고 SVG */}
          <svg width="18" height="18" viewBox="0 0 48 48">
            <path fill="#EA4335" d="M24 9.5c3.2 0 5.9 1.1 8.1 2.9l6-6C34.4 3.1 29.5 1 24 1 14.8 1 6.9 6.3 3.2 14l7 5.4C12.1 13.3 17.6 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.9 7.2l7.5 5.8c4.4-4 6.9-10 6.9-17z"/>
            <path fill="#FBBC05" d="M10.2 28.6A14.7 14.7 0 019.5 24c0-1.6.3-3.1.7-4.6L3.2 14A23.8 23.8 0 001 24c0 3.8.9 7.4 2.2 10.7l7-5.4-.1-.7z"/>
            <path fill="#34A853" d="M24 47c5.4 0 10-1.8 13.3-4.8l-7.5-5.8c-1.8 1.2-4.1 2-5.8 2-6.4 0-11.9-3.8-14-9.4l-7 5.4C6.9 41.7 14.8 47 24 47z"/>
          </svg>
          {googleLoading ? "연결 중..." : "Google 계정으로 계속하기"}
        </button>

        <p style={{ color: T.textMuted, fontSize: 11, textAlign: "center", marginTop: 18 }}>
          {mode === "login" ? "계정이 없으신가요?" : "이미 계정이 있으신가요?"}{" "}
          <button onClick={() => switchMode(mode === "login" ? "signup" : "login")} style={{ background: "none", border: "none", color: T.accent, fontSize: 11, fontWeight: 700, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>
            {mode === "login" ? "회원가입" : "로그인"}
          </button>
        </p>
      </div>
    </div>
  );
}

// ─── PROJECTS LIST ────────────────────────────────────────────────────────────
function ProjectsScreen({ T, dark, setDark, projects, loginName, currentAccount, toast, onOpen, onNew, onDelete, notify, onJoinByCode, onJoinRealtimeDraft, onLogout, onGoHome, notifications, onClearNotif, onAddNotif, sideCollapsed, onSideCollapse, drafts, onDeleteDraft, onResumeDraft }) {
  const sideW = sideCollapsed ? 60 : 220;
  const [joinCode, setJoinCode]   = useState("");
  const [joiningErr, setJoiningErr] = useState("");
  const [joining, setJoining]     = useState(false);
  const [mainTab, setMainTab]     = useState("projects");
  const [rtCode, setRtCode]       = useState("");   // 공동 설정 참가 코드
  const [rtJoining, setRtJoining] = useState(false);
  const [rtErr, setRtErr]         = useState("");

  const handleJoin = async () => {
    if (!joinCode.trim()) return;
    setJoiningErr(""); setJoining(true);
    try { await onJoinByCode(joinCode.trim()); setJoinCode(""); }
    catch (e) { setJoiningErr(e.message || "참여 실패"); }
    finally { setJoining(false); }
  };

  const handleRtJoin = async () => {
    if (!rtCode.trim() || !onJoinRealtimeDraft) return;
    setRtErr(""); setRtJoining(true);
    try { await onJoinRealtimeDraft(rtCode.trim()); }
    catch (e) { setRtErr(e.message || "참가 실패"); }
    finally { setRtJoining(false); }
  };

  // 전체 프로젝트에서 내 작업 수집
  const allMyTasks = projects.flatMap(proj => {
    const me = proj.members.find(m => m.name === loginName || m.accountId === currentAccount?.id);
    return proj.procedures.flatMap(proc =>
      proc.tasks.filter(t => t.memberId === me?.id || t.memberName === loginName)
        .map(t => ({ ...t, procName: proc.name, procIcon: proc.icon, projectName: proj.name, projectId: proj.id }))
    );
  });
  const myByStatus = {
    todo: allMyTasks.filter(t => t.status === "todo"),
    doing: allMyTasks.filter(t => t.status === "doing"),
    done: allMyTasks.filter(t => t.status === "done"),
  };
  const todayStr = new Date().toISOString().slice(0, 10);
  const overdue = allMyTasks.filter(t => t.deadline && t.deadline < todayStr && t.status !== "done");

  return (
    <div style={{ minHeight: "100vh", background: T.bg, display: "flex", fontFamily: "'Pretendard','Apple SD Gothic Neo',sans-serif" }}>
      <Toast T={T} toast={toast} />
      <Sidebar T={T} dark={dark} setDark={setDark} loginName={loginName} currentAccount={currentAccount}
        activeItem={mainTab} notifications={notifications} onClearNotif={onClearNotif} onAddNotif={onAddNotif}
        collapsed={sideCollapsed} onCollapse={onSideCollapse}
        items={[
          { id: "projects", icon: "🏠", label: "프로젝트 목록" },
          { id: "mytasks",  icon: "🙋", label: "내 전체 작업" },
        ]}
        onItemClick={setMainTab}
        onLogout={onLogout} onGoHome={onGoHome || (() => {})} />
      <div style={{ marginLeft: sideW, flex: 1, padding: "32px 36px", minWidth: 0, overflowX: "hidden", transition: "margin-left .2s cubic-bezier(.4,0,.2,1)" }}>
        {mainTab === "projects" ? (<>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
          <div>
            <h1 style={{ color: T.text, fontSize: 26, fontWeight: 800, marginBottom: 4 }}>프로젝트 목록</h1>
            <p style={{ color: T.textSub, fontSize: 13 }}>총 {projects.length}개의 프로젝트</p>
          </div>
          <button onClick={onNew} style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 18px", background: `linear-gradient(135deg,${T.accent},${T.accentSub})`, border: "none", borderRadius: 9, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
            <SVG d={I.plus} size={13} /> 새 프로젝트
          </button>
        </div>
        {/* 임시저장된 초안 카드 목록 */}
        {(drafts || []).length > 0 && (
          <div style={{ marginBottom: 28 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <span style={{ fontSize: 16 }}>💾</span>
              <h3 style={{ color: T.text, fontSize: 14, fontWeight: 700 }}>임시저장된 프로젝트 설정</h3>
              <span style={{ fontSize: 11, color: T.textMuted, padding: "2px 7px", background: T.surfaceHover, borderRadius: 100, border: `1px solid ${T.border2}` }}>{drafts.length}개</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: 10 }}>
              {(drafts || []).map(draft => (
                <div key={draft.id} style={{ background: T.surface, border: `2px dashed ${T.accent}55`, borderRadius: 14, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                    <span style={{ fontSize: 22, flexShrink: 0 }}>📝</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ color: T.text, fontSize: 13, fontWeight: 700, marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{draft.projectName || "이름 없음"}</p>
                      <p style={{ color: T.textMuted, fontSize: 10 }}>마지막 저장: {draft.savedAt}</p>
                      {draft.data?.topic && <p style={{ color: T.textSub, fontSize: 11, marginTop: 3 }}>💡 {draft.data.topic}</p>}
                      {draft.data?.members?.length > 0 && (
                        <p style={{ color: T.textMuted, fontSize: 10, marginTop: 2 }}>👥 {draft.data.members.map(m => m.name).join(", ")}</p>
                      )}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 7 }}>
                    <button onClick={() => onResumeDraft(draft)} style={{ flex: 1, padding: "7px 0", background: `linear-gradient(135deg,${T.accent},${T.accentSub})`, border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>▶ 이어서 작성</button>
                    <button onClick={() => onDeleteDraft(draft.id)} style={{ padding: "7px 12px", background: "transparent", border: `1px solid ${T.border2}`, borderRadius: 8, color: T.textMuted, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = T.danger; e.currentTarget.style.color = T.danger; }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = T.border2; e.currentTarget.style.color = T.textMuted; }}>🗑</button>
                  </div>
                </div>
              ))}
              {/* 새 프로젝트 추가 카드 */}
              <div onClick={onNew} style={{ background: "transparent", border: `2px dashed ${T.border2}`, borderRadius: 14, padding: "16px 18px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, cursor: "pointer", minHeight: 110, transition: "all .15s" }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.background = `${T.accent}06`; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = T.border2; e.currentTarget.style.background = "transparent"; }}>
                <span style={{ fontSize: 24, opacity: 0.5 }}>＋</span>
                <p style={{ color: T.textMuted, fontSize: 12 }}>새 프로젝트 추가</p>
              </div>
            </div>
          </div>
        )}
        <div style={{ marginBottom: 28, padding: "18px 22px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14 }}>
          <p style={{ color: T.text, fontSize: 13, fontWeight: 700, marginBottom: 10 }}>🔗 초대 코드로 프로젝트 참여</p>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={joinCode} onChange={e => { setJoinCode(e.target.value.toUpperCase()); setJoiningErr(""); }} onKeyDown={e => e.key === "Enter" && handleJoin()} placeholder="초대 코드 6자리 입력 (예: AB3X7Z)"
              style={{ flex: 1, padding: "9px 14px", background: T.surfaceHover, border: `1px solid ${joiningErr ? T.danger : T.border2}`, borderRadius: 8, color: T.text, fontSize: 13, outline: "none", fontFamily: "inherit", letterSpacing: 3, fontWeight: 700 }} />
            <button onClick={handleJoin} disabled={!joinCode.trim() || joining} style={{ padding: "9px 20px", background: joinCode.trim() ? T.accent : T.border2, border: "none", borderRadius: 8, color: joinCode.trim() ? "#fff" : T.textMuted, fontSize: 13, fontWeight: 700, cursor: joinCode.trim() ? "pointer" : "default", fontFamily: "inherit" }}>
              {joining ? "참여 중..." : "참여하기"}
            </button>
          </div>
          {joiningErr && <p style={{ color: T.danger, fontSize: 12, marginTop: 7 }}>❌ {joiningErr}</p>}
        </div>

        {/* 공동 프로젝트 설정 참가 */}
        <div style={{ marginBottom: 28, padding: "18px 22px", background: T.surface, border: `1px solid ${T.accent}33`, borderRadius: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span style={{ fontSize: 16 }}>🤝</span>
            <p style={{ color: T.text, fontSize: 13, fontWeight: 700 }}>공동 프로젝트 설정 참가</p>
            <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 100, background: `${T.accent}15`, color: T.accent, fontWeight: 700 }}>실시간</span>
          </div>
          <p style={{ color: T.textMuted, fontSize: 11, marginBottom: 10, lineHeight: 1.5 }}>팀장이 프로젝트를 설정하는 중이라면 공동 작업 코드를 입력해 함께 설정에 참여하세요.</p>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={rtCode} onChange={e => { setRtCode(e.target.value.toUpperCase()); setRtErr(""); }} onKeyDown={e => e.key === "Enter" && handleRtJoin()} placeholder="공동 작업 코드 입력"
              style={{ flex: 1, padding: "9px 14px", background: T.surfaceHover, border: `1px solid ${rtErr ? T.danger : T.accent}44`, borderRadius: 8, color: T.text, fontSize: 13, outline: "none", fontFamily: "inherit", letterSpacing: 3, fontWeight: 700 }} />
            <button onClick={handleRtJoin} disabled={!rtCode.trim() || rtJoining} style={{ padding: "9px 18px", background: rtCode.trim() ? `linear-gradient(135deg,${T.accent},${T.accentSub})` : T.border2, border: "none", borderRadius: 8, color: rtCode.trim() ? "#fff" : T.textMuted, fontSize: 13, fontWeight: 700, cursor: rtCode.trim() ? "pointer" : "default", fontFamily: "inherit" }}>
              {rtJoining ? "참가 중..." : "함께 설정"}
            </button>
          </div>
          {rtErr && <p style={{ color: T.danger, fontSize: 12, marginTop: 7 }}>❌ {rtErr}</p>}
        </div>
        {projects.length === 0 ? (
          <div style={{ textAlign: "center", padding: "80px 40px", background: T.surface, borderRadius: 20, border: `2px dashed ${T.border2}` }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>🚀</div>
            <h2 style={{ color: T.text, fontSize: 18, fontWeight: 700, marginBottom: 8 }}>첫 프로젝트를 시작해볼까요?</h2>
            <p style={{ color: T.textSub, fontSize: 13, marginBottom: 24 }}>새 프로젝트를 만들거나 초대 코드로 팀에 합류하세요.</p>
            <button onClick={onNew} style={{ padding: "11px 28px", background: `linear-gradient(135deg,${T.accent},${T.accentSub})`, border: "none", borderRadius: 10, color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>지금 시작하기</button>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 16 }}>
            {projects.map(p => <ProjCard key={p.id} T={T} project={p} currentAccount={currentAccount} onClick={() => onOpen(p)} onDelete={() => onDelete(p.id)} />)}
          </div>
        )}
        </>) : (
          /* ── 내 전체 작업 뷰 ── */
          <AllTasksView T={T} allMyTasks={allMyTasks} myByStatus={myByStatus} todayStr={todayStr} overdue={overdue} />
        )}
      </div>
    </div>
  );
}

function AllTasksView({ T, allMyTasks, myByStatus, todayStr, overdue }) {
  const [collapsed, setCollapsed] = useState({ todo: false, done: true }); // 기본: 완료는 접힘
  const [viewMode, setViewMode] = useState("kanban"); // kanban | gantt
  const today = new Date();

  const toggle = (status) => setCollapsed(c => ({ ...c, [status]: !c[status] }));

  // 전체 프로젝트 간트용 날짜 범위
  const allDates = allMyTasks.flatMap(t => [t.startDate, t.deadline].filter(Boolean).map(d => new Date(d)));
  const ganttMinDate = allDates.length ? new Date(Math.min(...allDates) - 3*86400000) : new Date(today.getFullYear(), today.getMonth(), 1);
  const ganttMaxDate = allDates.length ? new Date(Math.max(...allDates) + 7*86400000) : new Date(today.getFullYear(), today.getMonth()+2, 0);
  const ganttTotal = Math.max(Math.ceil((ganttMaxDate - ganttMinDate)/86400000), 14);
  const [gStart, setGStart] = useState(0);
  const [gDays,  setGDays]  = useState(Math.min(ganttTotal, 30));
  const gRef = useRef(null);
  const [gW, setGW] = useState(600);
  useEffect(() => {
    if (!gRef.current) return;
    const ro = new ResizeObserver(e => setGW(e[0].contentRect.width - 180));
    ro.observe(gRef.current);
    return () => ro.disconnect();
  }, []);
  const gViewStart = new Date(ganttMinDate); gViewStart.setDate(gViewStart.getDate() + gStart);
  const gDaysArr = Array.from({ length: gDays }, (_, i) => { const d = new Date(gViewStart); d.setDate(d.getDate()+i); return d; });
  const gDayW = Math.max(Math.floor(gW / gDays), 12);
  const todayStr2 = today.toISOString().slice(0,10);
  const goTodayG = () => {
    const off = Math.ceil((today - ganttMinDate)/86400000);
    setGStart(Math.max(0, Math.min(ganttTotal - gDays, off - Math.floor(gDays/2))));
  };
  const handleWheelG = (e) => {
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? Math.floor(gDays*0.15) : -Math.floor(gDays*0.15);
    setGStart(s => Math.max(0, Math.min(ganttTotal - gDays, s + delta)));
  };

  // non-passive wheel
  useEffect(() => {
    const el = gRef.current;
    if (!el) return;
    el.addEventListener("wheel", handleWheelG, { passive: false });
    return () => el.removeEventListener("wheel", handleWheelG);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gDays, ganttTotal]);
  const getGBar = (t) => {
    const s = new Date((t.startDate||todayStr2).slice(0,10));
    const e = new Date((t.deadline || (() => { const d2 = new Date(s); d2.setDate(d2.getDate()+5); return d2.toISOString().slice(0,10); })()).slice(0,10));
    const sOff = Math.ceil((s - gViewStart)/86400000);
    const eOff = Math.ceil((e - gViewStart)/86400000);
    if (eOff < 0 || sOff > gDays) return null;
    return { left: Math.max(0, sOff)*gDayW, width: Math.max((Math.min(gDays, eOff) - Math.max(0, sOff))*gDayW, gDayW*0.8) };
  };
  const PASTEL = ["#a5b4fc","#93c5fd","#6ee7b7","#fcd34d","#f9a8d4","#fca5a5","#c4b5fd","#fdba74","#86efac","#67e8f9"];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ color: T.text, fontSize: 26, fontWeight: 800, marginBottom: 4 }}>내 전체 작업</h1>
          <p style={{ color: T.textSub, fontSize: 13 }}>모든 프로젝트의 내 작업을 한 눈에</p>
        </div>
        <div style={{ display: "flex", background: T.surfaceHover, borderRadius: 9, padding: 3, border: `1px solid ${T.border}` }}>
          {[["kanban","📋 목록"],["gantt","📅 간트"]].map(([v, label]) => (
            <button key={v} onClick={() => setViewMode(v)}
              style={{ padding: "6px 14px", border: "none", borderRadius: 7, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700, background: viewMode === v ? T.surface : "transparent", color: viewMode === v ? T.text : T.textMuted, transition: "all .15s" }}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {/* 요약 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 24 }}>
        {[
          ["전체", allMyTasks.length, T.accent, "📋"],
          ["진행중", myByStatus.doing.length, SC.doing, "⚡"],
          ["미진행", myByStatus.todo.length, SC.todo, "⏳"],
          ["기한초과", overdue.length, T.danger, "⚠️"],
        ].map(([l, v, c, ic]) => (
          <div key={l} style={{ padding: "16px 18px", background: T.card, border: `1px solid ${l==="기한초과"&&v>0 ? T.danger+"55" : T.border}`, borderRadius: 13 }}>
            <div style={{ fontSize: 18, marginBottom: 5 }}>{ic}</div>
            <div style={{ color: c, fontSize: 22, fontWeight: 800, marginBottom: 2 }}>{v}</div>
            <div style={{ color: T.textSub, fontSize: 11 }}>{l}</div>
          </div>
        ))}
      </div>
      {allMyTasks.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px", background: T.surface, borderRadius: 16, border: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 40, marginBottom: 10 }}>🎯</div>
          <p style={{ color: T.textSub, fontSize: 14 }}>할당된 작업이 없습니다.</p>
        </div>
      ) : viewMode === "kanban" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {["doing","todo","done"].map(status => {
            const tasks = myByStatus[status];
            if (tasks.length === 0) return null;
            const isCol = collapsed[status];
            return (
              <div key={status} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 13, overflow: "hidden" }}>
                <div onClick={() => toggle(status)} style={{ padding: "12px 18px", background: T.surface, borderBottom: isCol ? "none" : `1px solid ${T.border}`, display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" }}
                  onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
                  onMouseLeave={e => e.currentTarget.style.background = T.surface}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: SC[status] }} />
                  <span style={{ color: T.text, fontSize: 13, fontWeight: 700 }}>{ST[status]}</span>
                  <span style={{ color: T.textMuted, fontSize: 11 }}>({tasks.length})</span>
                  <span style={{ marginLeft: "auto", color: T.textMuted, fontSize: 12 }}>{isCol ? "▶" : "▼"}</span>
                </div>
                {!isCol && (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: 10, padding: 14 }}>
                    {tasks.map(t => {
                      const isOverdue = t.deadline && t.deadline < todayStr && t.status !== "done";
                      return (
                        <div key={t.id} style={{ padding: "12px 14px", background: T.surface, border: `1px solid ${isOverdue ? T.danger+"44" : T.border}`, borderRadius: 10 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 5 }}>
                            <span style={{ fontSize: 12 }}>{t.procIcon}</span>
                            <span style={{ color: T.textMuted, fontSize: 10 }}>{t.projectName} · {t.procName}</span>
                          </div>
                          <p style={{ color: T.text, fontSize: 12, fontWeight: 600, marginBottom: 6, lineHeight: 1.4, textDecoration: t.status==="done" ? "line-through" : "none" }}>{t.title}</p>
                          {t.deadline && <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 100, background: isOverdue?`${T.danger}15`:`${T.warn}10`, color: isOverdue?T.danger:T.warn, fontWeight: 600 }}>📅 {t.deadline}{isOverdue ? " ⚠" : ""}</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        /* 전체 프로젝트 통합 간트차트 */
        <div>
          <div style={{ display: "flex", gap: 7, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ color: T.textMuted, fontSize: 11 }}>줌:</span>
            {[["−",()=>setGDays(d=>Math.min(ganttTotal,Math.ceil(d*1.5)))],["+",()=>setGDays(d=>Math.max(7,Math.floor(d*0.6)))],["전체",()=>{setGStart(0);setGDays(Math.min(ganttTotal,30));}],["◀",()=>setGStart(s=>Math.max(0,s-Math.floor(gDays*0.3)))],["▶",()=>setGStart(s=>Math.min(ganttTotal-gDays,s+Math.floor(gDays*0.3)))]].map(([l,fn])=>(
              <button key={l} onClick={fn} style={{ padding:"4px 9px",background:T.surfaceHover,border:`1px solid ${T.border2}`,borderRadius:6,color:T.textSub,fontSize:11,cursor:"pointer",fontFamily:"inherit" }}>{l}</button>
            ))}
            <button onClick={goTodayG} style={{ padding:"4px 10px",background:`${T.accent}15`,border:`1px solid ${T.accent}44`,borderRadius:6,color:T.accent,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit" }}>📍 오늘</button>
          </div>
          <div ref={gRef} style={{ background:T.card,border:`1px solid ${T.border}`,borderRadius:13,overflow:"auto" }}>
            <div style={{ display:"flex",borderBottom:`1px solid ${T.border}`,position:"sticky",top:0,background:T.card,zIndex:3 }}>
              <div style={{ width:180,flexShrink:0,padding:"8px 14px",borderRight:`1px solid ${T.border}`,color:T.textMuted,fontSize:11,fontWeight:600 }}>작업 / 프로젝트</div>
              <div style={{ display:"flex",minWidth:gDaysArr.length*gDayW }}>
                {gDaysArr.map((d,i)=>(
                  <div key={i} style={{ width:gDayW,flexShrink:0,textAlign:"center",background:d.toDateString()===today.toDateString()?`${T.accent}20`:(d.getDay()===0||d.getDay()===6)?`${T.border}33`:"transparent",padding:"3px 0" }}>
                    {(i===0||d.getDate()===1)&&<div style={{color:T.textMuted,fontSize:7,fontWeight:700}}>{d.getMonth()+1}월</div>}
                    {gDayW>=14&&<div style={{color:d.toDateString()===today.toDateString()?T.accent:T.textMuted,fontSize:7,fontWeight:d.toDateString()===today.toDateString()?800:400}}>{d.getDate()}</div>}
                  </div>
                ))}
              </div>
            </div>
            {allMyTasks.map((t,ti)=>{
              const bar=getGBar(t);
              const color=PASTEL[ti%PASTEL.length];
              const isOver=t.deadline&&t.deadline<todayStr2&&t.status!=="done";
              return (
                <div key={t.id} style={{display:"flex",borderBottom:`1px solid ${T.border}`,minHeight:44}}>
                  <div style={{width:180,flexShrink:0,padding:"7px 10px",borderRight:`1px solid ${T.border}`,display:"flex",flexDirection:"column",justifyContent:"center",gap:2}}>
                    <p style={{color:T.text,fontSize:10,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",textDecoration:t.status==="done"?"line-through":"none"}}>{t.title}</p>
                    <span style={{color:T.textMuted,fontSize:9}}>{t.projectName}</span>
                  </div>
                  <div style={{position:"relative",flex:1,display:"flex",alignItems:"center",minWidth:gDaysArr.length*gDayW,overflow:"hidden"}}>
                    {(()=>{const off=Math.ceil((today-gViewStart)/86400000);return off>=0&&off<=gDays?<div style={{position:"absolute",left:off*gDayW,top:0,bottom:0,width:1.5,background:T.accent,opacity:.6,zIndex:2}}/>:null;})()}
                    {bar&&<div style={{position:"absolute",left:bar.left+1,width:bar.width-2,height:20,borderRadius:5,background:t.status==="done"?`${T.success}88`:isOver?`${T.danger}88`:`${color}cc`,border:`1px solid ${color}`,display:"flex",alignItems:"center",paddingLeft:5,overflow:"hidden",boxShadow:`0 2px 6px ${color}55`}}>
                      <span style={{color:"#fff",fontSize:8,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",textShadow:"0 1px 2px rgba(0,0,0,.35)"}}>{t.title}</span>
                    </div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 쪽지 작성 컴포넌트 (Gmail 스타일) ──────────────────────────────────────
function MsgComposer({ T, loginName, onSend }) {
  const [open, setOpen]     = useState(false);
  const [to, setTo]         = useState("");
  const [team, setTeam]     = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody]     = useState("");
  const send = () => {
    if (!body.trim()) return;
    onSend({ to: to.trim() || "전체", team: team.trim(), subject: subject.trim() || "(제목 없음)", body: body.trim() });
    setTo(""); setTeam(""); setSubject(""); setBody(""); setOpen(false);
  };
  if (!open) return (
    <button onClick={() => setOpen(true)} style={{ width: "100%", padding: "7px 0", background: `linear-gradient(135deg,#7c6af7,#a855f7)`, border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
      ✏️ 새 쪽지 작성
    </button>
  );
  return (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
      <div style={{ padding: "8px 12px", background: `linear-gradient(135deg,#7c6af7,#a855f7)`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ color: "#fff", fontSize: 12, fontWeight: 700 }}>새 쪽지</span>
        <button onClick={() => setOpen(false)} style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", fontSize: 14, opacity: 0.8 }}>×</button>
      </div>
      <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", borderBottom: `1px solid ${T.border}`, paddingBottom: 5, alignItems: "center", gap: 6 }}>
          <span style={{ color: "#7c6af7", fontSize: 10, fontWeight: 700, minWidth: 28 }}>발신</span>
          <span style={{ color: T.textSub, fontSize: 11 }}>{loginName}</span>
        </div>
        <div style={{ display: "flex", borderBottom: `1px solid ${T.border}`, paddingBottom: 5, alignItems: "center", gap: 6 }}>
          <span style={{ color: T.textMuted, fontSize: 10, fontWeight: 700, minWidth: 28 }}>소속</span>
          <input value={team} onChange={e => setTeam(e.target.value)} placeholder="팀/소속 (예: 개발팀)"
            style={{ flex: 1, background: "none", border: "none", color: T.text, fontSize: 11, outline: "none", fontFamily: "inherit" }} />
        </div>
        <div style={{ display: "flex", borderBottom: `1px solid ${T.border}`, paddingBottom: 5, alignItems: "center", gap: 6 }}>
          <span style={{ color: T.textMuted, fontSize: 10, fontWeight: 700, minWidth: 28 }}>받는</span>
          <input value={to} onChange={e => setTo(e.target.value)} placeholder="팀원 이름 (미입력 시 전체)"
            style={{ flex: 1, background: "none", border: "none", color: T.text, fontSize: 11, outline: "none", fontFamily: "inherit" }} />
        </div>
        <div style={{ display: "flex", borderBottom: `1px solid ${T.border}`, paddingBottom: 5, alignItems: "center", gap: 6 }}>
          <span style={{ color: T.textMuted, fontSize: 10, fontWeight: 700, minWidth: 28 }}>제목</span>
          <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="제목 입력"
            style={{ flex: 1, background: "none", border: "none", color: T.text, fontSize: 11, outline: "none", fontFamily: "inherit" }} />
        </div>
        <textarea value={body} onChange={e => setBody(e.target.value)} placeholder="내용을 입력하세요..."
          rows={4} style={{ width: "100%", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 6, color: T.text, fontSize: 11, padding: "8px 10px", outline: "none", resize: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
        <button onClick={send} style={{ alignSelf: "flex-end", padding: "6px 18px", background: `linear-gradient(135deg,#7c6af7,#a855f7)`, border: "none", borderRadius: 7, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5 }}>
          📤 전송
        </button>
      </div>
    </div>
  );
}

// ─── 쪽지 작성 본문 컴포넌트 (드래그창 + 패널 공용) ──────────────────────────
function ComposeBody({ T, loginName, currentAccount, projectMembers = [], onSend }) {
  const [to, setTo] = useState("");
  const [toAccountId, setToAccountId] = useState(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [suggestions, setSuggestions] = useState([]);

  // 가입된 팀원만 (accountId가 있는 멤버)
  const members = projectMembers.filter(m => m.name !== loginName && m.accountId);

  const handleToChange = (val) => {
    setTo(val);
    setToAccountId(null);
    if (val.length >= 1) {
      setSuggestions(members.filter(m => m.name.includes(val)));
    } else {
      setSuggestions([]);
    }
  };

  const send = () => {
    if (!to.trim()) { alert("받는 사람을 입력하세요."); return; }
    if (!toAccountId) { alert("유효한 팀원을 선택해주세요."); return; }
    if (!subject.trim()) { alert("제목을 입력하세요."); return; }
    onSend({ to, toAccountId, subject, body });
    setTo(""); setToAccountId(null); setSubject(""); setBody(""); setSuggestions([]);
  };

  return (
    <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
      {/* 받는 사람 */}
      <div style={{ position: "relative" }}>
        <div style={{ display: "flex", borderBottom: `1px solid ${T.border}`, paddingBottom: 5, alignItems: "center", gap: 6 }}>
          <span style={{ color: T.textMuted, fontSize: 10, fontWeight: 700, minWidth: 32 }}>받는</span>
          <input value={to} onChange={e => handleToChange(e.target.value)} placeholder="팀원 이름 입력"
            style={{ flex: 1, background: "none", border: "none", color: T.text, fontSize: 11, outline: "none", fontFamily: "inherit" }} />
          {toAccountId && <span style={{ fontSize: 10, color: T.success }}>✓</span>}
        </div>
        {suggestions.length > 0 && (
          <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 7, zIndex: 100, overflow: "hidden", boxShadow: "0 4px 16px rgba(0,0,0,.2)" }}>
            {suggestions.map(m => (
              <div key={m.id} onClick={() => { setTo(m.name); setToAccountId(m.accountId); setSuggestions([]); }}
                style={{ padding: "7px 12px", cursor: "pointer", fontSize: 11, color: T.text }}
                onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <span style={{ fontWeight: 600 }}>{m.name}</span>
                {m.role && <span style={{ color: T.textMuted, fontSize: 10, marginLeft: 6 }}>{m.role}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ display: "flex", borderBottom: `1px solid ${T.border}`, paddingBottom: 5, alignItems: "center", gap: 6 }}>
        <span style={{ color: T.textMuted, fontSize: 10, fontWeight: 700, minWidth: 32 }}>제목</span>
        <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="제목 입력"
          style={{ flex: 1, background: "none", border: "none", color: T.text, fontSize: 11, outline: "none", fontFamily: "inherit" }} />
      </div>
      <textarea value={body} onChange={e => setBody(e.target.value)} placeholder="내용을 입력하세요..."
        rows={5} style={{ width: "100%", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 6, color: T.text, fontSize: 11, padding: "8px 10px", outline: "none", resize: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={send} style={{ padding: "7px 20px", background: `linear-gradient(135deg,#7c6af7,#a855f7)`, border: "none", borderRadius: 7, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
          📤 전송
        </button>
      </div>
    </div>
  );
}

function Sidebar({ T, dark, setDark, loginName, currentAccount, activeItem, items, extra, onItemClick, projectInfo, onLogout, onGoHome, notifications, onClearNotif, onAddNotif, collapsed, onCollapse, projectMembers = [] }) {
  const [showProfile, setShowProfile] = useState(false);
  const [showNotif, setShowNotif] = useState(false);
  const [profileName, setProfileName] = useState(loginName || "");
  const [mailTab, setMailTab] = useState("inbox");
  const [dbMessages, setDbMessages] = useState([]);
  const [selectedMail, setSelectedMail] = useState(null);
  const [showCompose, setShowCompose] = useState(false);
  const [composePos, setComposePos] = useState({ x: null, y: null });
  const [isDraggingCompose, setIsDraggingCompose] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const composeRef = useRef(null);
  // 체크박스 선택 삭제
  const [checkedMails, setCheckedMails] = useState(new Set());
  const toggleCheck = (id) => setCheckedMails(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  const checkAll = (ids) => setCheckedMails(new Set(ids));
  const clearCheck = () => setCheckedMails(new Set());
  const deleteChecked = async (ids) => {
    for (const id of ids) { try { await sbDeleteMessage(id); } catch {} }
    setDbMessages(prev => prev.filter(m => !ids.has(m.id)));
    clearCheck();
  };
  const deleteCheckedNotifs = (indices) => {
    const arr = (notifications||[]).filter((_,i)=>!indices.has(i));
    if (onClearNotif) onClearNotif(arr);
    clearCheck();
  };
  const unread = (notifications || []).filter(n => !n.read).length;
  const unreadMail = dbMessages.filter(m => m.to_account_id === currentAccount?.id && !m.read).length;
  const isCollapsed = collapsed ?? false;
  const w = isCollapsed ? 60 : 220;

  // DB 쪽지 로드
  useEffect(() => {
    if (!currentAccount?.id) return;
    sbGetMessages(currentAccount.id).then(setDbMessages).catch(() => {});
    // Realtime 구독
    const ch = supabase.channel(`messages-${currentAccount.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages",
        filter: `to_account_id=eq.${currentAccount.id}` },
        payload => {
          setDbMessages(prev => [payload.new, ...prev]);
          if (onAddNotif) onAddNotif(`📩 ${payload.new.from_name}: ${payload.new.subject}`, "📩");
        })
      .subscribe();
    return () => supabase.removeChannel(ch);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentAccount?.id]);

  const sentMails = dbMessages.filter(m => m.from_account_id === currentAccount?.id);
  const receivedMails = dbMessages.filter(m => m.to_account_id === currentAccount?.id);

  // 드래그 핸들러
  const onComposeMouseDown = (e) => {
    if (e.target.closest("input,textarea,button,select")) return;
    setIsDraggingCompose(true);
    const rect = composeRef.current?.getBoundingClientRect();
    dragOffset.current = { x: e.clientX - (rect?.left || 0), y: e.clientY - (rect?.top || 0) };
    e.preventDefault();
  };
  useEffect(() => {
    const onMove = (e) => {
      if (!isDraggingCompose) return;
      setComposePos({ x: e.clientX - dragOffset.current.x, y: e.clientY - dragOffset.current.y });
    };
    const onUp = () => setIsDraggingCompose(false);
    if (isDraggingCompose) {
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    }
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [isDraggingCompose]);

  const sysNotifs = (notifications || []).filter(n => n.icon !== "💬" && n.icon !== "📤" && n.icon !== "📩");

  return (
    <>
      <div style={{ width: w, background: T.sidebarBg, borderRight: `1px solid ${T.border}`, padding: isCollapsed ? "24px 0" : "24px 0", display: "flex", flexDirection: "column", position: "fixed", top: 0, bottom: 0, left: 0, zIndex: 50, transition: "width .2s cubic-bezier(.4,0,.2,1)", overflow: "hidden" }}>
        {/* 로고 + collapse 버튼 */}
        <div style={{ padding: isCollapsed ? "0 0 18px" : "0 16px 18px", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", justifyContent: isCollapsed ? "center" : "space-between" }}>
          <div onClick={onGoHome} style={{ display: "flex", alignItems: "center", gap: isCollapsed ? 0 : 10, cursor: "pointer" }} title="프로젝트 홈">
            <div style={{ width: 30, height: 30, background: `linear-gradient(135deg,${T.accent},${T.accentSub})`, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, flexShrink: 0 }}>🚀</div>
            {!isCollapsed && <span style={{ color: T.text, fontWeight: 800, fontSize: 14 }}>Workend</span>}
          </div>
          {!isCollapsed && (
            <button onClick={() => onCollapse && onCollapse(true)} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 3, fontSize: 12 }} title="사이드바 접기">◀</button>
          )}
        </div>
        {isCollapsed && (
          <button onClick={() => onCollapse && onCollapse(false)} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: "8px", fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center" }} title="사이드바 펼치기">▶</button>
        )}
        {!isCollapsed && extra && <div style={{ padding: "0 16px" }}>{extra}</div>}
        {projectInfo && !isCollapsed && (
          <div style={{ padding: "12px 8px", borderBottom: `1px solid ${T.border}` }}>
            <div style={{ padding: "9px 10px", background: `${T.accent}12`, borderRadius: 9, border: `1px solid ${T.accent}33` }}>
              <p style={{ color: T.accent, fontSize: 12, fontWeight: 700, marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{projectInfo.name}</p>
              <div style={{ background: T.border2, borderRadius: 100, height: 2 }}>
                <div style={{ width: `${projectInfo.pct}%`, height: "100%", background: T.accent, borderRadius: 100 }} />
              </div>
              <p style={{ color: T.textMuted, fontSize: 10, marginTop: 3 }}>{projectInfo.pct}% 완료</p>
            </div>
          </div>
        )}
        <div style={{ padding: isCollapsed ? "12px 4px" : "12px 8px", flex: 1 }}>
          {items.map(it => (
            <div key={it.id} onClick={() => onItemClick && onItemClick(it.id)} title={collapsed ? it.label : ""} style={{
              display: "flex", alignItems: "center", gap: isCollapsed ? 0 : 10,
              padding: isCollapsed ? "10px 0" : "8px 12px", borderRadius: 8, cursor: "pointer", marginBottom: 2,
              justifyContent: isCollapsed ? "center" : "flex-start",
              background: activeItem === it.id ? `${T.accent}18` : "transparent",
              border: activeItem === it.id ? `1px solid ${T.accent}33` : "1px solid transparent",
              transition: "all .15s",
            }}>
              <span style={{ fontSize: 14, flexShrink: 0 }}>{it.icon}</span>
              {!collapsed && <span style={{ color: activeItem === it.id ? T.accent : T.textSub, fontSize: 13, fontWeight: activeItem === it.id ? 700 : 400 }}>{it.label}</span>}
            </div>
          ))}
        </div>
        {/* 하단 영역 */}
        <div style={{ padding: isCollapsed ? "12px 4px" : "12px 14px", borderTop: `1px solid ${T.border}` }}>
          <div onClick={() => setShowNotif(s => !s)} title="알림 & 쪽지" style={{ display: "flex", alignItems: "center", gap: isCollapsed ? 0 : 8, justifyContent: isCollapsed ? "center" : "flex-start", padding: isCollapsed ? "8px 0" : "7px 6px", borderRadius: 8, cursor: "pointer", marginBottom: 6, background: showNotif ? `${T.accent}12` : "transparent", position: "relative" }}>
            <span style={{ fontSize: 16, position: "relative" }}>
              🔔
              {(unread + unreadMail) > 0 && <span style={{ position: "absolute", top: -4, right: -4, width: 14, height: 14, background: T.danger, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, color: "#fff", fontWeight: 700 }}>{unread + unreadMail}</span>}
            </span>
            {!collapsed && <span style={{ color: T.textSub, fontSize: 13 }}>알림 & 쪽지 {(unread+unreadMail) > 0 ? `(${unread+unreadMail})` : ""}</span>}
            {/* 쪽지 작성 버튼 */}
            {!collapsed && <button onClick={e => { e.stopPropagation(); setShowCompose(true); setComposePos({ x: null, y: null }); }}
              title="쪽지 작성"
              style={{ marginLeft: "auto", width: 20, height: 20, borderRadius: "50%", background: T.accent, border: "none", color: "#fff", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>✎</button>}
          </div>
          <div onClick={() => setShowProfile(s => !s)} title="내 정보" style={{ display: "flex", alignItems: "center", gap: isCollapsed ? 0 : 8, justifyContent: isCollapsed ? "center" : "flex-start", padding: isCollapsed ? "8px 0" : "7px 6px", borderRadius: 8, cursor: "pointer", marginBottom: 6 }}>
            <div style={{ width: 26, height: 26, borderRadius: "50%", background: T.accent, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#fff", fontWeight: 700, flexShrink: 0 }}>{(loginName || "?")[0]}</div>
            {!collapsed && <span style={{ color: T.textSub, fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", maxWidth: 90 }}>{loginName}</span>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: isCollapsed ? "center" : "space-between" }}>
            <ThemeToggle T={T} dark={dark} setDark={setDark} />
            {!collapsed && onLogout && (
              <button onClick={onLogout} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 5, padding: "6px 0", background: "transparent", border: `1px solid ${T.border2}`, borderRadius: 8, color: T.textSub, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = T.danger; e.currentTarget.style.color = T.danger; e.currentTarget.style.background = `${T.danger}10`; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = T.border2; e.currentTarget.style.color = T.textSub; e.currentTarget.style.background = "transparent"; }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" /></svg>
                로그아웃
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 쪽지 상세 모달 */}
      {selectedMail && (
        <div onClick={() => setSelectedMail(null)} style={{ position: "fixed", inset: 0, zIndex: 500, background: "rgba(0,0,0,.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, width: "100%", maxWidth: 480, boxShadow: "0 24px 80px rgba(0,0,0,.4)", overflow: "hidden" }}>
            <div style={{ padding: "14px 18px", background: `linear-gradient(135deg,#7c6af7,#a855f7)`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ color: "#fff", fontSize: 13, fontWeight: 700 }}>✉️ 쪽지 상세</span>
              <button onClick={() => setSelectedMail(null)} style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", fontSize: 18, opacity: .8 }}>×</button>
            </div>
            <div style={{ padding: "18px 20px" }}>
              {[
                ["발신", `${selectedMail.from}${selectedMail.team ? ` (${selectedMail.team})` : ""}`],
                ["수신", selectedMail.to || "전체"],
                ["제목", selectedMail.subject],
                ["시간", selectedMail.sentAt],
              ].map(([k, v]) => (
                <div key={k} style={{ display: "flex", gap: 10, marginBottom: 8, paddingBottom: 8, borderBottom: `1px solid ${T.border}` }}>
                  <span style={{ color: T.textMuted, fontSize: 11, fontWeight: 700, minWidth: 32 }}>{k}</span>
                  <span style={{ color: T.text, fontSize: 12 }}>{v}</span>
                </div>
              ))}
              <div style={{ marginTop: 12, padding: "12px 14px", background: T.surfaceHover, borderRadius: 9, border: `1px solid ${T.border}` }}>
                <p style={{ color: T.text, fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{selectedMail.body}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 알림 패널 */}
      {showNotif && (
        <div style={{ position: "fixed", left: w + 8, bottom: 60, zIndex: 200, width: 380, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14, boxShadow: "0 8px 40px rgba(0,0,0,.25)", overflow: "hidden" }}>
          <div style={{ padding: "14px 16px", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ color: T.text, fontSize: 13, fontWeight: 700 }}>🔔 알림 & 쪽지</span>
            <div style={{ display: "flex", gap: 6 }}>
              {sysNotifs.length > 0 && mailTab === "inbox" && <button onClick={onClearNotif} style={{ fontSize: 10, color: T.textMuted, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>모두 지우기</button>}
              <button onClick={() => { setShowCompose(true); setComposePos({ x: null, y: null }); }} style={{ fontSize: 10, padding: "2px 8px", background: `${T.accent}15`, border: `1px solid ${T.accent}44`, borderRadius: 6, color: T.accent, cursor: "pointer", fontFamily: "inherit", fontWeight: 700 }}>✎ 쪽지 작성</button>
              <button onClick={() => setShowNotif(false)} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 16 }}>×</button>
            </div>
          </div>
          {/* 탭 */}
          <div style={{ display: "flex", borderBottom: `1px solid ${T.border}`, background: T.surfaceHover }}>
            {[["inbox",`📥 받은쪽지${receivedMails.filter(m=>!m.read).length>0?` (${receivedMails.filter(m=>!m.read).length})`:""}`,],["outbox","📤 보낸쪽지"],["notif","🔔 알림"]].map(([id, label]) => (
              <button key={id} onClick={() => { setMailTab(id); clearCheck(); }} style={{ flex: 1, padding: "8px 0", border: "none", background: mailTab === id ? T.surface : "transparent", color: mailTab === id ? T.accent : T.textSub, fontSize: 10, fontWeight: mailTab === id ? 700 : 400, cursor: "pointer", fontFamily: "inherit", borderBottom: mailTab === id ? `2px solid ${T.accent}` : "2px solid transparent" }}>{label}</button>
            ))}
          </div>

          {/* 받은 쪽지함 */}
          {mailTab === "inbox" && (
            <div>
              {receivedMails.length > 0 && (
                <div style={{ padding:"6px 16px", display:"flex", alignItems:"center", gap:8, borderBottom:`1px solid ${T.border}`, background:T.surfaceHover }}>
                  <input type="checkbox" checked={receivedMails.every(m=>checkedMails.has(m.id))} onChange={e=>{ if(e.target.checked) checkAll(new Set(receivedMails.map(m=>m.id))); else clearCheck(); }} style={{ cursor:"pointer" }} />
                  <span style={{ color:T.textMuted, fontSize:10 }}>전체 선택 ({checkedMails.size}/{receivedMails.length})</span>
                  {checkedMails.size > 0 && (
                    <button onClick={()=>deleteChecked(checkedMails)}
                      style={{ marginLeft:"auto", padding:"2px 10px", background:`${T.danger}15`, border:`1px solid ${T.danger}44`, borderRadius:6, color:T.danger, fontSize:10, cursor:"pointer", fontFamily:"inherit", fontWeight:700 }}>
                      🗑 선택 삭제 ({checkedMails.size})
                    </button>
                  )}
                </div>
              )}
              <div style={{ maxHeight:340, overflowY:"auto" }}>
                {receivedMails.length === 0 ? (
                  <div style={{ padding:"32px 16px", textAlign:"center", color:T.textMuted, fontSize:12 }}>받은 쪽지가 없습니다</div>
                ) : receivedMails.map(m => (
                  <div key={m.id}
                    style={{ padding:"9px 16px", borderBottom:`1px solid ${T.border}`, background:checkedMails.has(m.id)?`${T.accent}10`:m.read?"transparent":`${T.accent}08`, display:"flex", gap:8, alignItems:"flex-start" }}
                    onMouseEnter={e=>e.currentTarget.style.background=T.surfaceHover}
                    onMouseLeave={e=>e.currentTarget.style.background=checkedMails.has(m.id)?`${T.accent}10`:m.read?"transparent":`${T.accent}08`}>
                    <input type="checkbox" checked={checkedMails.has(m.id)} onChange={()=>toggleCheck(m.id)} onClick={e=>e.stopPropagation()} style={{ cursor:"pointer", marginTop:2, flexShrink:0 }} />
                    <div style={{ flex:1, cursor:"pointer", minWidth:0 }} onClick={()=>{ setSelectedMail({from:m.from_name,to:m.to_name,subject:m.subject,body:m.body,sentAt:new Date(m.sent_at).toLocaleString("ko-KR")}); sbMarkMessageRead(m.id).catch(()=>{}); setDbMessages(prev=>prev.map(x=>x.id===m.id?{...x,read:true}:x)); }}>
                      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:2 }}>
                        <div style={{ display:"flex", alignItems:"center", gap:5 }}>
                          <div style={{ width:20,height:20,borderRadius:"50%",background:T.accent,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:9,fontWeight:700,flexShrink:0 }}>{(m.from_name||"?")[0]}</div>
                          <span style={{ color:T.text,fontSize:11,fontWeight:m.read?400:700 }}>{m.from_name}</span>
                          {!m.read&&<span style={{ width:5,height:5,borderRadius:"50%",background:T.accent,display:"inline-block" }} />}
                        </div>
                        <div style={{ display:"flex",alignItems:"center",gap:5 }}>
                          <span style={{ color:T.textMuted,fontSize:9 }}>{new Date(m.sent_at).toLocaleString("ko-KR",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})}</span>
                          <button onClick={e=>{e.stopPropagation();sbDeleteMessage(m.id).catch(()=>{});setDbMessages(prev=>prev.filter(x=>x.id!==m.id));checkedMails.delete(m.id);}}
                            style={{ width:16,height:16,borderRadius:"50%",background:`${T.danger}15`,border:`1px solid ${T.danger}44`,color:T.danger,fontSize:9,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" }} title="삭제">✕</button>
                        </div>
                      </div>
                      <p style={{ color:T.text,fontSize:11,fontWeight:600,marginBottom:1 }}>{m.subject}</p>
                      <p style={{ color:T.textSub,fontSize:10,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{m.body}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 보낸 쪽지함 */}
          {mailTab === "outbox" && (
            <div>
              {sentMails.length > 0 && (
                <div style={{ padding:"6px 16px",display:"flex",alignItems:"center",gap:8,borderBottom:`1px solid ${T.border}`,background:T.surfaceHover }}>
                  <input type="checkbox" checked={sentMails.every(m=>checkedMails.has(m.id))} onChange={e=>{if(e.target.checked)checkAll(new Set(sentMails.map(m=>m.id)));else clearCheck();}} style={{ cursor:"pointer" }} />
                  <span style={{ color:T.textMuted,fontSize:10 }}>전체 선택 ({checkedMails.size}/{sentMails.length})</span>
                  {checkedMails.size>0&&(
                    <button onClick={()=>deleteChecked(checkedMails)}
                      style={{ marginLeft:"auto",padding:"2px 10px",background:`${T.danger}15`,border:`1px solid ${T.danger}44`,borderRadius:6,color:T.danger,fontSize:10,cursor:"pointer",fontFamily:"inherit",fontWeight:700 }}>
                      🗑 선택 삭제 ({checkedMails.size})
                    </button>
                  )}
                </div>
              )}
              <div style={{ maxHeight:340,overflowY:"auto" }}>
                {sentMails.length===0?(
                  <div style={{ padding:"32px 16px",textAlign:"center",color:T.textMuted,fontSize:12 }}>보낸 쪽지가 없습니다</div>
                ):sentMails.map(m=>(
                  <div key={m.id}
                    style={{ padding:"9px 16px",borderBottom:`1px solid ${T.border}`,background:checkedMails.has(m.id)?`${T.accent}10`:"transparent",display:"flex",gap:8,alignItems:"flex-start" }}
                    onMouseEnter={e=>e.currentTarget.style.background=T.surfaceHover}
                    onMouseLeave={e=>e.currentTarget.style.background=checkedMails.has(m.id)?`${T.accent}10`:"transparent"}>
                    <input type="checkbox" checked={checkedMails.has(m.id)} onChange={()=>toggleCheck(m.id)} onClick={e=>e.stopPropagation()} style={{ cursor:"pointer",marginTop:2,flexShrink:0 }} />
                    <div style={{ flex:1,cursor:"pointer",minWidth:0 }} onClick={()=>setSelectedMail({from:m.from_name,to:m.to_name,subject:m.subject,body:m.body,sentAt:new Date(m.sent_at).toLocaleString("ko-KR")})}>
                      <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:2 }}>
                        <div style={{ display:"flex",alignItems:"center",gap:5 }}>
                          <div style={{ width:20,height:20,borderRadius:"50%",background:`linear-gradient(135deg,#7c6af7,#a855f7)`,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:9,fontWeight:700 }}>{(loginName||"?")[0]}</div>
                          <span style={{ color:T.text,fontSize:11,fontWeight:600 }}>→ {m.to_name}</span>
                        </div>
                        <div style={{ display:"flex",alignItems:"center",gap:5 }}>
                          <span style={{ color:T.textMuted,fontSize:9 }}>{new Date(m.sent_at).toLocaleString("ko-KR",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})}</span>
                          <button onClick={e=>{e.stopPropagation();sbDeleteMessage(m.id).catch(()=>{});setDbMessages(prev=>prev.filter(x=>x.id!==m.id));checkedMails.delete(m.id);}}
                            style={{ width:16,height:16,borderRadius:"50%",background:`${T.danger}15`,border:`1px solid ${T.danger}44`,color:T.danger,fontSize:9,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" }} title="삭제">✕</button>
                        </div>
                      </div>
                      <p style={{ color:T.text,fontSize:11,fontWeight:600,marginBottom:1 }}>{m.subject}</p>
                      <p style={{ color:T.textSub,fontSize:10,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{m.body}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 알림 탭 */}
          {mailTab === "notif" && (
            <div>
              {sysNotifs.length > 0 && (
                <div style={{ padding:"6px 16px",display:"flex",alignItems:"center",gap:8,borderBottom:`1px solid ${T.border}`,background:T.surfaceHover }}>
                  <input type="checkbox" checked={sysNotifs.every((_,i)=>checkedMails.has(i))} onChange={e=>{if(e.target.checked)checkAll(new Set(sysNotifs.map((_,i)=>i)));else clearCheck();}} style={{ cursor:"pointer" }} />
                  <span style={{ color:T.textMuted,fontSize:10 }}>전체 선택 ({checkedMails.size}/{sysNotifs.length})</span>
                  {checkedMails.size>0&&(
                    <button onClick={()=>deleteCheckedNotifs(checkedMails)}
                      style={{ marginLeft:"auto",padding:"2px 10px",background:`${T.danger}15`,border:`1px solid ${T.danger}44`,borderRadius:6,color:T.danger,fontSize:10,cursor:"pointer",fontFamily:"inherit",fontWeight:700 }}>
                      🗑 선택 삭제 ({checkedMails.size})
                    </button>
                  )}
                </div>
              )}
              <div style={{ maxHeight:340,overflowY:"auto" }}>
                {sysNotifs.length===0?(
                  <div style={{ padding:"32px 16px",textAlign:"center",color:T.textMuted,fontSize:12 }}>새 알림이 없습니다</div>
                ):sysNotifs.map((n,i)=>(
                  <div key={i}
                    style={{ padding:"9px 16px",borderBottom:`1px solid ${T.border}`,background:checkedMails.has(i)?`${T.accent}10`:n.read?"transparent":`${T.accent}08`,display:"flex",gap:8,alignItems:"flex-start" }}
                    onMouseEnter={e=>e.currentTarget.style.background=T.surfaceHover}
                    onMouseLeave={e=>e.currentTarget.style.background=checkedMails.has(i)?`${T.accent}10`:n.read?"transparent":`${T.accent}08`}>
                    <input type="checkbox" checked={checkedMails.has(i)} onChange={()=>toggleCheck(i)} style={{ cursor:"pointer",marginTop:2,flexShrink:0 }} />
                    <div style={{ flex:1,cursor:"pointer" }} onClick={()=>setSelectedMail({from:"시스템",to:loginName,subject:n.text,body:n.text,sentAt:n.time})}>
                      <div style={{ display:"flex",gap:7,alignItems:"flex-start" }}>
                        <span style={{ fontSize:14,flexShrink:0 }}>{n.icon||"📌"}</span>
                        <div style={{ flex:1 }}>
                          <p style={{ color:T.text,fontSize:11,fontWeight:n.read?400:700,marginBottom:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{n.text}</p>
                          <p style={{ color:T.textMuted,fontSize:9 }}>{n.time}</p>
                        </div>
                        <button onClick={e=>{e.stopPropagation();const idx=i;const arr=(notifications||[]).filter((_,j)=>j!==idx);if(onClearNotif)onClearNotif(arr);}}
                          style={{ width:16,height:16,borderRadius:"50%",background:`${T.danger}15`,border:`1px solid ${T.danger}44`,color:T.danger,fontSize:9,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>✕</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

            {/* ── 우하단 드래그 가능 쪽지 작성창 (Gmail 스타일) ── */}
      {showCompose && (
        <div ref={composeRef}
          style={{
            position: "fixed",
            right: composePos.x !== null ? "auto" : 24,
            bottom: composePos.y !== null ? "auto" : 24,
            left: composePos.x !== null ? composePos.x : "auto",
            top: composePos.y !== null ? composePos.y : "auto",
            width: 360, zIndex: 600,
            background: T.surface, border: `1px solid ${T.border}`,
            borderRadius: 14, boxShadow: "0 12px 48px rgba(0,0,0,.35)",
            overflow: "hidden", display: "flex", flexDirection: "column",
          }}>
          {/* 헤더 — 드래그 핸들 */}
          <div onMouseDown={onComposeMouseDown}
            style={{ padding: "10px 14px", background: `linear-gradient(135deg,${T.accent},${T.accentSub})`, display: "flex", alignItems: "center", justifyContent: "space-between", cursor: isDraggingCompose ? "grabbing" : "grab", userSelect: "none" }}>
            <span style={{ color: "#fff", fontSize: 12, fontWeight: 700 }}>✎ 새 쪽지</span>
            <button onClick={() => setShowCompose(false)} style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", fontSize: 18, opacity: .8 }}>×</button>
          </div>
          {/* 본문 */}
          <ComposeBody T={T} loginName={loginName} currentAccount={currentAccount} projectMembers={projectMembers}
            onSend={async (mail) => {
              try {
                await sbSendMessage({
                  fromAccountId: currentAccount.id,
                  fromName: loginName,
                  toAccountId: mail.toAccountId,
                  toName: mail.to,
                  subject: mail.subject,
                  body: mail.body,
                  team: mail.team || "",
                });
                setDbMessages(prev => [{
                  id: uid(), from_account_id: currentAccount.id, from_name: loginName,
                  to_account_id: mail.toAccountId, to_name: mail.to,
                  subject: mail.subject, body: mail.body,
                  sent_at: new Date().toISOString(), read: false,
                }, ...prev]);
                setShowCompose(false);
                if (onAddNotif) onAddNotif(`📤 ${mail.to}에게 쪽지를 보냈습니다.`, "📤");
              } catch (e) {
                alert("쪽지 전송 실패: " + e.message);
              }
            }} />
        </div>
      )}

      {/* 프로필 편집 모달 */}
      {showProfile && (
        <div onClick={() => setShowProfile(false)} style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div onClick={e => e.stopPropagation()} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, padding: 28, width: 340, boxShadow: "0 16px 60px rgba(0,0,0,.3)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 22 }}>
              <h3 style={{ color: T.text, fontSize: 16, fontWeight: 700 }}>내 정보</h3>
              <button onClick={() => setShowProfile(false)} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 18 }}>×</button>
            </div>
            <div style={{ textAlign: "center", marginBottom: 22 }}>
              <div style={{ width: 64, height: 64, borderRadius: "50%", background: `linear-gradient(135deg,${T.accent},${T.accentSub})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, color: "#fff", fontWeight: 700, margin: "0 auto 10px" }}>{(profileName || loginName || "?")[0]}</div>
              <p style={{ color: T.textMuted, fontSize: 11 }}>아이디: {currentAccount?.username || "-"}</p>
            </div>
            <label style={{ display: "block", color: T.textSub, fontSize: 12, marginBottom: 6, fontWeight: 600 }}>표시 이름</label>
            <input value={profileName} onChange={e => setProfileName(e.target.value)} placeholder="표시 이름"
              style={{ width: "100%", padding: "10px 14px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 8, color: T.text, fontSize: 13, outline: "none", boxSizing: "border-box", fontFamily: "inherit", marginBottom: 16 }} />
            <button onClick={() => { setShowProfile(false); }} style={{ width: "100%", padding: "11px", background: `linear-gradient(135deg,${T.accent},${T.accentSub})`, border: "none", borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>저장</button>
          </div>
        </div>
      )}
    </>
  );
}

function ProjCard({ T, project, currentAccount, onClick, onDelete }) {
  const total   = project.procedures.reduce((a, s) => a + s.tasks.length, 0);
  const done    = project.procedures.reduce((a, s) => a + s.tasks.filter(t => t.status === "done").length, 0);
  const pct     = total ? Math.round(done / total * 100) : 0;
  const isOwner = currentAccount && project.ownerAccountId === currentAccount.id;
  const [hov, setHov]         = useState(false);
  const [confirm, setConfirm] = useState(false);

  return (
    <div style={{ position: "relative" }}>
      {confirm && (
        <div onClick={e => e.stopPropagation()} style={{ position: "absolute", inset: 0, zIndex: 10, borderRadius: 16, background: T.surface, border: `2px solid ${T.danger}55`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "24px 20px" }}>
          <div style={{ fontSize: 28, marginBottom: 10 }}>⚠️</div>
          <p style={{ color: T.text, fontSize: 13, fontWeight: 700, textAlign: "center", marginBottom: 6 }}>프로젝트를 삭제할까요?</p>
          <p style={{ color: T.textSub, fontSize: 11, textAlign: "center", marginBottom: 18, lineHeight: 1.5 }}><strong style={{ color: T.danger }}>{project.name}</strong>의<br/>모든 데이터가 영구 삭제됩니다.</p>
          <div style={{ display: "flex", gap: 8, width: "100%" }}>
            <button onClick={() => setConfirm(false)} style={{ flex: 1, padding: "8px 0", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 8, color: T.textSub, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>취소</button>
            <button onClick={() => { setConfirm(false); onDelete(); }} style={{ flex: 1, padding: "8px 0", background: T.danger, border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>삭제</button>
          </div>
        </div>
      )}
      <div onClick={onClick} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{ background: T.card, border: `1px solid ${hov ? T.accent : T.border}`, borderRadius: 16, padding: 22, cursor: "pointer", position: "relative", transition: "all .2s", transform: hov ? "translateY(-2px)" : "translateY(0)", boxShadow: hov ? `0 8px 32px ${T.accent}22` : "none" }}>
        {isOwner && (
          <button onClick={e => { e.stopPropagation(); setConfirm(true); }} style={{ position: "absolute", top: 12, right: 12, width: 28, height: 28, background: "transparent", border: "none", borderRadius: 6, color: T.textMuted, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
            onMouseEnter={e => { e.currentTarget.style.color = T.danger; e.currentTarget.style.background = `${T.danger}15`; }}
            onMouseLeave={e => { e.currentTarget.style.color = T.textMuted; e.currentTarget.style.background = "transparent"; }}>
            <SVG d={I.trash} size={13} />
          </button>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 26 }}>📁</span>
          <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 100, fontWeight: 700, background: isOwner ? `${T.accent}15` : `${T.success}12`, color: isOwner ? T.accent : T.success }}>{isOwner ? "오너" : "구성원"}</span>
        </div>
        <h3 style={{ color: T.text, fontSize: 15, fontWeight: 700, marginBottom: 3 }}>{project.name}</h3>
        <p style={{ color: T.textMuted, fontSize: 12, marginBottom: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{project.topic || "대주제 미설정"}</p>
        <div style={{ background: T.border, borderRadius: 100, height: 3, marginBottom: 6 }}>
          <div style={{ width: `${pct}%`, height: "100%", background: `linear-gradient(90deg,${T.accent},${T.accentSub})`, borderRadius: 100, transition: "width .6s" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: T.textSub, fontSize: 11 }}>진행률 {pct}%</span>
          <span style={{ color: T.textSub, fontSize: 11 }}>{project.members.length}명</span>
        </div>
      </div>
    </div>
  );
}

// ─── ONBOARD ──────────────────────────────────────────────────────────────────
function OnboardScreen({ T, step, data, setData, onNext, onBack, onGoHome, loginName, loading = false,
  realtimeDraftCode, realtimeDraftId, draftParticipants = [], isOwnerDraft = true,
  onCreateRealtimeDraft, onJoinRealtimeDraft }) {
  const steps = ["팀원 설정", "프로젝트 이름", "대주제 설정", "절차 선택", "역할 분담"];
  const [joinCode, setJoinCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [copied, setCopied] = useState(false);
  const [creatingDraft, setCreatingDraft] = useState(false);

  // 팀장: 처음 진입 시 자동으로 Realtime draft 생성
  useEffect(() => {
    if (isOwnerDraft && !realtimeDraftId && onCreateRealtimeDraft) {
      setCreatingDraft(true);
      onCreateRealtimeDraft().finally(() => setCreatingDraft(false));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCopyCode = () => {
    if (!realtimeDraftCode) return;
    navigator.clipboard.writeText(realtimeDraftCode).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleJoin = async () => {
    if (!joinCode.trim() || !onJoinRealtimeDraft) return;
    setJoining(true);
    await onJoinRealtimeDraft(joinCode.trim());
    setJoining(false);
  };

  // 임시저장 상태 표시용 — 프로젝트 이름이 있으면 저장 중으로 표시
  const hasDraft = !!(data.projectName || data.members?.length || data.topic);

  return (
    <div style={{ minHeight: "100vh", background: T.bg, display: "flex", fontFamily: "'Pretendard','Apple SD Gothic Neo',sans-serif" }}>
      <div style={{ width: 260, background: T.sidebarBg, borderRight: `1px solid ${T.border}`, padding: "40px 24px", display: "flex", flexDirection: "column" }}>
        {/* 로고 — 클릭하면 홈으로 */}
        <div
          onClick={onGoHome}
          title="홈으로 돌아가기"
          style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, cursor: "pointer", padding: "6px 8px", borderRadius: 8, transition: "background .15s" }}
          onMouseEnter={e => e.currentTarget.style.background = `rgba(124,106,247,0.1)`}
          onMouseLeave={e => e.currentTarget.style.background = "transparent"}
        >
          <div style={{ width: 30, height: 30, background: `linear-gradient(135deg,${T.accent},${T.accentSub})`, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, flexShrink: 0 }}>🚀</div>
          <span style={{ color: T.text, fontWeight: 800, fontSize: 14 }}>Workend</span>
        </div>

        {/* 임시저장 상태 배지 */}
        <div style={{ marginBottom: 24, padding: "8px 10px", borderRadius: 8, background: hasDraft ? `${T.accent}12` : T.surfaceHover, border: `1px solid ${hasDraft ? T.accent + "44" : T.border2}`, display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{ fontSize: 13 }}>{hasDraft ? "💾" : "📄"}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ color: hasDraft ? T.accent : T.textMuted, fontSize: 11, fontWeight: hasDraft ? 700 : 400 }}>
              {hasDraft ? "자동 저장 중" : "새 프로젝트"}
            </p>
            {hasDraft && data.projectName && (
              <p style={{ color: T.textMuted, fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{data.projectName}</p>
            )}
          </div>
        </div>

        {/* 실시간 공동 작업 패널 */}
        {realtimeDraftId && isOwnerDraft && (
          <div style={{ marginBottom: 16, padding: "12px 12px", borderRadius: 10, background: `${T.accent}10`, border: `1px solid ${T.accent}44` }}>
            <p style={{ color: T.accent, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>🔗 팀원 초대 코드</p>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <span style={{ flex: 1, color: T.accent, fontSize: 18, fontWeight: 900, letterSpacing: 4, fontFamily: "monospace", background: T.surface, borderRadius: 7, padding: "6px 10px", textAlign: "center" }}>{realtimeDraftCode}</span>
              <button onClick={handleCopyCode} style={{ padding: "6px 10px", background: copied ? T.success : T.accent, border: "none", borderRadius: 7, color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>{copied ? "✓" : "복사"}</button>
            </div>
            <p style={{ color: T.textMuted, fontSize: 9, lineHeight: 1.5 }}>팀원에게 이 코드를 공유하세요. 팀원이 코드를 입력하면 실시간으로 함께 설정할 수 있습니다.</p>
            {/* 참가 중인 팀원 표시 */}
            {draftParticipants.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <p style={{ color: T.textMuted, fontSize: 9, fontWeight: 700, marginBottom: 5 }}>참가 중 ({draftParticipants.length}명)</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {draftParticipants.map((p, i) => (
                    <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 7px", background: T.surface, border: `1px solid ${T.success}44`, borderRadius: 100, fontSize: 10, color: T.success }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: T.success, display: "inline-block" }} />
                      {p.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 팀원: 초대 코드 입력 (Realtime draft에 미참가 상태) */}
        {!realtimeDraftId && !isOwnerDraft && (
          <div style={{ marginBottom: 16, padding: "12px", borderRadius: 10, background: T.surfaceHover, border: `1px solid ${T.border2}` }}>
            <p style={{ color: T.textSub, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>🔗 공동 작업 참가</p>
            <div style={{ display: "flex", gap: 5 }}>
              <input value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())} onKeyDown={e => e.key === "Enter" && handleJoin()} placeholder="초대 코드 입력"
                style={{ flex: 1, padding: "6px 9px", background: T.surface, border: `1px solid ${T.border2}`, borderRadius: 7, color: T.text, fontSize: 12, outline: "none", fontFamily: "inherit", letterSpacing: 2, fontWeight: 700 }} />
              <button onClick={handleJoin} disabled={joining || !joinCode.trim()} style={{ padding: "6px 10px", background: T.accent, border: "none", borderRadius: 7, color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>{joining ? "..." : "참가"}</button>
            </div>
          </div>
        )}

        {/* 공동 작업 중 (팀원) */}
        {realtimeDraftId && !isOwnerDraft && (
          <div style={{ marginBottom: 16, padding: "10px 12px", borderRadius: 10, background: `${T.success}10`, border: `1px solid ${T.success}44` }}>
            <p style={{ color: T.success, fontSize: 11, fontWeight: 700, marginBottom: 3 }}>✅ 공동 작업 중</p>
            <p style={{ color: T.textMuted, fontSize: 9 }}>팀장의 설정이 실시간으로 반영됩니다.</p>
          </div>
        )}

        <p style={{ color: T.textMuted, fontSize: 10, marginBottom: 14, textTransform: "uppercase", letterSpacing: 1 }}>설정 단계</p>
        {steps.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 10px", borderRadius: 8, marginBottom: 2, background: i === step ? `${T.accent}15` : "transparent" }}>
            <div style={{ width: 22, height: 22, borderRadius: "50%", background: i < step ? T.accent : i === step ? T.accent : T.border2, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff", fontWeight: 700, flexShrink: 0 }}>{i < step ? "✓" : i + 1}</div>
            <span style={{ color: i <= step ? T.text : T.textMuted, fontSize: 13, fontWeight: i === step ? 700 : 400 }}>{s}</span>
          </div>
        ))}

        {/* 홈으로 버튼 (하단) */}
        <div style={{ marginTop: "auto", paddingTop: 24 }}>
          <button onClick={onGoHome} style={{ width: "100%", display: "flex", alignItems: "center", gap: 7, padding: "8px 12px", background: "transparent", border: `1px solid ${T.border2}`, borderRadius: 8, color: T.textMuted, fontSize: 12, cursor: "pointer", fontFamily: "inherit", transition: "all .15s" }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = T.danger; e.currentTarget.style.color = T.danger; e.currentTarget.style.background = `${T.danger}08`; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = T.border2; e.currentTarget.style.color = T.textMuted; e.currentTarget.style.background = "transparent"; }}>
            ← 작성 취소하고 홈으로
          </button>
        </div>
      </div>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 48 }}>
        <div style={{ width: "100%", maxWidth: step === 3 ? 900 : 640 }}>
          {step === 0 && <OStep2 T={T} data={data} setData={setData} loginName={loginName} />}
          {step === 1 && <OStep1 T={T} data={data} setData={setData} loginName={loginName} />}
          {step === 2 && <OStep3 T={T} data={data} setData={setData} />}
          {step === 3 && <OStep4 T={T} data={data} setData={setData} />}
          {step === 4 && <OStep5 T={T} data={data} setData={setData} />}
          <div style={{ display: "flex", gap: 10, marginTop: 28 }}>
            <button onClick={onBack} disabled={loading} style={{ padding: "11px 24px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 8, color: T.textSub, fontSize: 13, cursor: loading ? "default" : "pointer", fontFamily: "inherit", fontWeight: 600 }}>← 이전</button>
            <button onClick={onNext} disabled={loading} style={{ flex: 1, padding: "11px 24px", border: "none", borderRadius: 8, background: loading ? T.border2 : `linear-gradient(135deg,${T.accent},${T.accentSub})`, color: loading ? T.textMuted : "#fff", fontSize: 13, fontWeight: 700, cursor: loading ? "default" : "pointer", fontFamily: "inherit" }}>
              {loading && step === 4
                ? "생성 중..."
                : step === 4 && realtimeDraftId && !isOwnerDraft
                  ? "⏳ 팀장 생성 대기 중"
                  : step === 4
                    ? "🚀 프로젝트 생성"
                    : "다음 →"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SH({ T, n, title, sub }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <p style={{ color: T.accent, fontSize: 11, fontWeight: 700, marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>Step {n}</p>
      <h2 style={{ color: T.text, fontSize: 24, fontWeight: 800, marginBottom: 6 }}>{title}</h2>
      <p style={{ color: T.textSub, fontSize: 13 }}>{sub}</p>
    </div>
  );
}

function OStep1({ T, data, setData, loginName }) {
  // 로컬 state로 관리 — IME 입력 간섭 방지
  const [projectName, setProjectName] = useState(data.projectName || "");
  const [startDate, setStartDate] = useState(data.startDate || "");
  const [endDate, setEndDate] = useState(data.endDate || "");

  // Realtime으로 data가 바뀌면 (다른 팀원이 입력) 로컬 state도 갱신
  useEffect(() => {
    if (data.projectName !== undefined && data.projectName !== projectName) {
      setProjectName(data.projectName);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.projectName]);

  useEffect(() => { if (data.startDate !== undefined) setStartDate(data.startDate || ""); }, [data.startDate]);
  useEffect(() => { if (data.endDate !== undefined) setEndDate(data.endDate || ""); }, [data.endDate]);

  const syncName = (val) => setData(d => ({ ...d, projectName: val }));
  const syncDate = (key, val) => setData(d => ({ ...d, [key]: val }));

  return (
    <div>
      <SH T={T} n={2} title={`안녕하세요, ${loginName}님! 👋`} sub="프로젝트 이름과 기간을 설정해주세요." />
      <label style={{ display: "block", color: T.textSub, fontSize: 12, marginBottom: 6, fontWeight: 600 }}>프로젝트 이름</label>
      <Inp T={T} value={projectName}
        onChange={e => setProjectName(e.target.value)}
        onBlur={e => syncName(e.target.value)}
        onCompositionEnd={e => { setProjectName(e.target.value); syncName(e.target.value); }}
        placeholder="예: 스마트 환경 모니터링 시스템" style={{ marginBottom: 18 }} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        {[["시작일","startDate",startDate,setStartDate],["종료일","endDate",endDate,setEndDate]].map(([label, key, val, setter]) => (
          <div key={key}>
            <label style={{ display: "block", color: T.textSub, fontSize: 12, marginBottom: 6, fontWeight: 600 }}>{label}</label>
            <Inp T={T} type="date" value={val}
              onChange={e => { setter(e.target.value); syncDate(key, e.target.value); }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function OStep2({ T, data, setData, loginName }) {
  const [inp, setInp] = useState("");
  const members = data.members || [];
  const myName = loginName;
  useEffect(() => {
    setData(d => {
      const cur = d.members || [];
      if (cur.some(m => m.name === myName)) return d;
      return { ...d, members: [{ id: "self", name: myName }, ...cur] };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const add = () => {
    const name = inp.trim(); if (!name) return;
    if (name === myName && members.some(m => m.id === "self")) { setInp(""); return; }
    setData(d => ({ ...d, members: [...(d.members || []), { id: uid(), name }] }));
    setInp("");
  };
  const remove = id => setData(d => ({ ...d, members: (d.members || []).filter(m => m.id !== id) }));

  return (
    <div>
      <SH T={T} n={1} title="팀원을 추가하세요 👥" sub="나는 자동으로 포함됩니다. 나머지 팀원 이름을 추가하세요." />
      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <input value={inp} onChange={e => setInp(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.nativeEvent.isComposing) add(); }}
          placeholder="팀원 이름 입력 후 Enter"
          style={{ flex: 1, padding: "10px 14px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 8, color: T.text, fontSize: 13, outline: "none", fontFamily: "inherit" }} />
        <button onClick={add} style={{ padding: "10px 18px", background: T.accent, border: "none", borderRadius: 8, color: "#fff", fontSize: 13, cursor: "pointer", fontWeight: 700, fontFamily: "inherit" }}>추가</button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {members.map(m => {
          const isSelf = m.name === myName;
          return (
            <span key={m.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px 4px 5px", background: isSelf ? `${T.accent}25` : `${T.accent}15`, border: `1px solid ${isSelf ? T.accent : T.accent + "44"}`, borderRadius: 100, color: T.accent, fontSize: 12 }}>
              <span style={{ width: 20, height: 20, borderRadius: "50%", background: isSelf ? T.accent : T.accentSub, display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 10, fontWeight: 700, flexShrink: 0 }}>{m.name[0]}</span>
              {m.name}
              {isSelf ? <span style={{ fontSize: 9, color: T.accent, fontWeight: 700, marginLeft: 2 }}>나</span>
                : <button onClick={() => remove(m.id)} style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0, lineHeight: 1 }}>×</button>}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function OStep3({ T, data, setData }) {
  const [ideaInp, setIdeaInp] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSuggestions, setAiSuggestions] = useState([]);
  const ideas = data.ideas || [];
  const addIdea = () => {
    if (!ideaInp.trim()) return;
    setData(d => ({ ...d, ideas: [...(d.ideas || []), { id: uid(), text: ideaInp.trim() }] }));
    setIdeaInp("");
  };

  const washIdeas = async () => {
    if (ideas.length === 0) return;
    setAiLoading(true); setAiSuggestions([]);
    try {
      const resp = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: `다음 아이디어들을 바탕으로 프로젝트 대주제 후보 3개를 추천해줘. 각 후보는 명확하고 구체적인 한 문장이어야 해. 반드시 아래 JSON 형식만 출력해:\n{"suggestions":["후보1","후보2","후보3"]}\n\n아이디어 목록:\n${ideas.map(i=>i.text).join("\n")}`,
          maxTokens: 1000,
        }),
      });
      const { text, error } = await resp.json();
      if (error) throw new Error(error);
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      setAiSuggestions(parsed.suggestions || []);
    } catch { setAiSuggestions(["AI 추천 실패 — 직접 입력해주세요"]); }
    finally { setAiLoading(false); }
  };
  return (
    <div>
      <SH T={T} n={3} title="대주제를 설정하세요 💡" sub="아이디어를 모아 워싱한 뒤, 최종 대주제를 선택하거나 직접 입력하세요." />
      <div style={{ background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 12, padding: "14px 16px", marginBottom: 20 }}>
        <p style={{ color: T.text, fontSize: 12, fontWeight: 700, marginBottom: 10 }}>💭 아이디어 워싱</p>
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <input value={ideaInp} onChange={e => setIdeaInp(e.target.value)} onKeyDown={e => e.key === "Enter" && addIdea()} placeholder="주제 아이디어 입력 후 Enter"
            style={{ flex: 1, padding: "10px 13px", background: T.surface, border: `1px solid ${T.border2}`, borderRadius: 8, color: T.text, fontSize: 13, outline: "none", fontFamily: "inherit" }} />
          <button onClick={addIdea} style={{ padding: "10px 16px", background: T.accent, border: "none", borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>추가</button>
        </div>
        {ideas.length === 0 ? (
          <p style={{ color: T.textMuted, fontSize: 12, textAlign: "center", padding: "12px 0" }}>아이디어를 입력해보세요</p>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {ideas.map(idea => {
              const sel = data.topic === idea.text;
              return (
                <div key={idea.id} onClick={() => setData(d => ({ ...d, topic: idea.text }))}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 13px", background: sel ? `${T.accent}15` : T.surface, border: `1px solid ${sel ? T.accent : T.border2}`, borderRadius: 10, cursor: "pointer", transition: "all .15s" }}>
                  <span style={{ fontSize: 16, flexShrink: 0 }}>💡</span>
                  <span style={{ flex: 1, color: sel ? T.accent : T.text, fontSize: 13, fontWeight: sel ? 700 : 400 }}>{idea.text}</span>
                  {sel && <span style={{ width: 18, height: 18, borderRadius: "50%", background: T.accent, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 10 }}>✓</span>}
                  <button onClick={e => { e.stopPropagation(); setData(d => ({ ...d, ideas: ideas.filter(x => x.id !== idea.id), topic: data.topic === idea.text ? "" : data.topic })); }}
                    style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 2, fontSize: 14 }}
                    onMouseEnter={e => e.currentTarget.style.color = T.danger} onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>×</button>
                </div>
              );
            })}
          </div>
        )}
        {/* AI 주제 워싱 버튼 */}
        {ideas.length >= 2 && (
          <div style={{ marginTop: 14 }}>
            <button onClick={washIdeas} disabled={aiLoading}
              style={{ width: "100%", padding: "10px 0", background: aiLoading ? T.border2 : `linear-gradient(135deg,${T.accent},${T.accentSub})`, border: "none", borderRadius: 9, color: aiLoading ? T.textMuted : "#fff", fontSize: 13, fontWeight: 700, cursor: aiLoading ? "default" : "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 7 }}>
              {aiLoading ? "🤖 AI 분석 중..." : "✨ AI로 주제 정제하기"}
            </button>
            {aiSuggestions.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <p style={{ color: T.textSub, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>🤖 AI 추천 주제</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  {aiSuggestions.map((s, i) => (
                    <div key={i} onClick={() => setData(d => ({ ...d, topic: s }))}
                      style={{ padding: "10px 14px", background: data.topic === s ? `${T.accent}15` : T.surface, border: `1px solid ${data.topic === s ? T.accent : T.border2}`, borderRadius: 9, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, transition: "all .15s" }}>
                      <span style={{ fontSize: 14 }}>🎯</span>
                      <span style={{ color: data.topic === s ? T.accent : T.text, fontSize: 13, fontWeight: data.topic === s ? 700 : 400, flex: 1 }}>{s}</span>
                      {data.topic === s && <span style={{ color: T.accent, fontSize: 11, fontWeight: 700 }}>✓ 선택됨</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <label style={{ display: "block", color: T.textSub, fontSize: 12, marginBottom: 6, fontWeight: 600 }}>최종 대주제 {data.topic && <span style={{ color: T.accent }}>✓</span>}</label>
      <input value={data.topic || ""} onChange={e => setData(d => ({ ...d, topic: e.target.value }))} placeholder="아이디어를 클릭하거나 직접 입력하세요"
        style={{ width: "100%", padding: "12px 14px", background: T.surfaceHover, border: `1px solid ${data.topic ? T.accent : T.border2}`, borderRadius: 10, color: T.text, fontSize: 14, fontWeight: data.topic ? 700 : 400, outline: "none", boxSizing: "border-box", fontFamily: "inherit" }} />
    </div>
  );
}

// ─── OSTEP4: DAG 플로우차트 에디터 ───────────────────────────────────────────
// 데이터 구조 (data.flowGraph):
//   nodes: [{ id, procId, x, y }]   — 캔버스 위 노드 위치
//   edges: [{ id, from, to }]        — 방향 연결선
// data.procedures: [{ id, name, icon, color, customTasks }] — 절차 정보
//
// 기능:
//  - 노드 드래그 이동 (ref 기반 — 매 frame 상태 업데이트 없이 부드러운 드래그)
//  - 노드 클릭 → 연결 시작 노드 선택 → 다른 노드 클릭 → 연결 완성
//  - 연결된 엣지 클릭 → 삭제
//  - 노드 클릭 → 작업 편집
//  - 초기화 버튼, 자동 레이아웃, 줌/패닝

function OStep4({ T, data, setData }) {
  const procs   = data.procedures || [];
  const members = data.members    || [];

  const graph = data.flowGraph || { nodes: [], edges: [] };

  const [taskInps,   setTaskInps]   = useState({});
  const [customInp,  setCustomInp]  = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [connectFrom, setConnectFrom] = useState(null); // 클릭-클릭 연결: 시작 노드 id

  // 캔버스 상태
  const [pan,  setPan]  = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const svgRef     = useRef(null);
  const canvasRef  = useRef(null); // 캔버스 컨테이너 div — wheel 등록용
  // 드래그: ref로 임시 위치 관리 (setState 없이 DOM 직접 — 부드러운 드래그)
  const dragStateRef     = useRef(null);
  const isPanning        = useRef(null);
  const [dragPos, setDragPos] = useState({});

  const NODE_W = 120;
  const NODE_H = 50;

  // ── flowGraph setter
  const setGraph = (fn) => setData(d => ({ ...d, flowGraph: fn(d.flowGraph || { nodes: [], edges: [] }) }));

  // ── 절차 추가/제거
  const toggleTpl = (t) => {
    setData(d => {
      const curProcs = d.procedures || [];
      const fg = d.flowGraph || { nodes: [], edges: [] };
      const exists = curProcs.find(p => p.id === t.id);
      if (exists) {
        const removedNodeIds = fg.nodes.filter(n => n.procId === t.id).map(n => n.id);
        return {
          ...d,
          procedures: curProcs.filter(p => p.id !== t.id),
          flowGraph: {
            nodes: fg.nodes.filter(n => n.procId !== t.id),
            edges: fg.edges.filter(e => !removedNodeIds.includes(e.from) && !removedNodeIds.includes(e.to)),
          },
        };
      } else {
        const nodeId = uid();
        const curNodes = fg.nodes || [];
        const x = curNodes.length === 0 ? 60 : Math.max(...curNodes.map(n => n.x)) + NODE_W + 40;
        return {
          ...d,
          procedures: [...curProcs, { ...t, customTasks: [], parallelGroup: null }],
          flowGraph: {
            nodes: [...curNodes, { id: nodeId, procId: t.id, x, y: 100 }],
            edges: fg.edges || [],
          },
        };
      }
    });
  };

  const addCustomProc = () => {
    const name = customInp.trim(); if (!name) return;
    const newId = uid();
    const nodeId = uid();
    setData(d => {
      const curNodes = (d.flowGraph || { nodes: [] }).nodes || [];
      const x = curNodes.length === 0 ? 60 : Math.max(...curNodes.map(n => n.x)) + NODE_W + 40;
      return {
        ...d,
        procedures: [...(d.procedures || []), { id: newId, name, icon: "📌", color: "#6366f1", isCustom: true, customTasks: [], parallelGroup: null }],
        flowGraph: {
          nodes: [...curNodes, { id: nodeId, procId: newId, x, y: 100 }],
          edges: (d.flowGraph || { edges: [] }).edges || [],
        },
      };
    });
    setCustomInp(""); setShowCustom(false);
  };

  const removeProc = (procId) => {
    setData(d => {
      const fg = d.flowGraph || { nodes: [], edges: [] };
      const removedNodeIds = fg.nodes.filter(n => n.procId === procId).map(n => n.id);
      return {
        ...d,
        procedures: d.procedures.filter(p => p.id !== procId),
        flowGraph: {
          nodes: fg.nodes.filter(n => n.procId !== procId),
          edges: fg.edges.filter(e => !removedNodeIds.includes(e.from) && !removedNodeIds.includes(e.to)),
        },
      };
    });
    if (selectedNodeId && graph.nodes.find(n => n.id === selectedNodeId)?.procId === procId) setSelectedNodeId(null);
  };

  // ── 초기화
  const resetGraph = () => {
    setGraph(() => ({
      nodes: procs.map((p, i) => ({ id: uid(), procId: p.id, x: 60 + i * (NODE_W + 40), y: 100 })),
      edges: [],
    }));
    setSelectedNodeId(null); setSelectedEdgeId(null);
  };

  // ── 자동 레이아웃 (위상 정렬 기반 계층 배치 — 캔버스 정중앙 정렬)
  const autoLayout = () => {
    const nodes = graph.nodes;
    const edges = graph.edges;
    if (nodes.length === 0) return;

    const inDeg = Object.fromEntries(nodes.map(n => [n.id, 0]));
    edges.forEach(e => { if (inDeg[e.to] !== undefined) inDeg[e.to]++; });
    const adj = Object.fromEntries(nodes.map(n => [n.id, []]));
    edges.forEach(e => { if (adj[e.from]) adj[e.from].push(e.to); });

    const layers = {};
    const queue = nodes.filter(n => inDeg[n.id] === 0).map(n => n.id);
    const visited = new Set();
    queue.forEach(id => { layers[id] = 0; });
    let q = [...queue];
    while (q.length > 0) {
      const cur = q.shift();
      if (visited.has(cur)) continue;
      visited.add(cur);
      (adj[cur] || []).forEach(next => { layers[next] = Math.max(layers[next] || 0, (layers[cur] || 0) + 1); q.push(next); });
    }
    nodes.forEach(n => { if (layers[n.id] === undefined) layers[n.id] = 0; });

    const layerGroups = {};
    nodes.forEach(n => {
      const l = layers[n.id] || 0;
      if (!layerGroups[l]) layerGroups[l] = [];
      layerGroups[l].push(n.id);
    });

    const HGAP = NODE_W + 70;
    const VGAP = NODE_H + 36;
    const numLayers = Math.max(...Object.keys(layerGroups).map(Number)) + 1;
    const totalW = numLayers * HGAP - 70;
    const maxPerLayer = Math.max(...Object.values(layerGroups).map(g => g.length));
    const totalH = maxPerLayer * VGAP - 36;

    // 캔버스 중심에서 전체 그래프를 중앙 정렬
    const startX = (SVG_W - totalW) / 2;
    const startY = (SVG_H - totalH) / 2;

    const newNodes = nodes.map(n => {
      const layer = layers[n.id] || 0;
      const group = layerGroups[layer] || [n.id];
      const pos = group.indexOf(n.id);
      const layerH = group.length * VGAP - 36;
      return {
        ...n,
        x: startX + layer * HGAP,
        y: startY + (totalH - layerH) / 2 + pos * VGAP,
      };
    });

    setGraph(g => ({ ...g, nodes: newNodes }));
    // 정렬 후 zoom/pan 리셋
    setZoom(1); setPan({ x: 0, y: 0 });
  };

  // ── SVG 좌표 변환
  const toSVGCoords = (clientX, clientY) => {
    if (!svgRef.current) return { x: clientX, y: clientY };
    const rect = svgRef.current.getBoundingClientRect();
    return {
      x: (clientX - rect.left - pan.x) / zoom,
      y: (clientY - rect.top  - pan.y) / zoom,
    };
  };

  // ── 포트 위치 계산
  const getPortPos = (node, portType) => {
    // portType: "in" (왼쪽 중앙), "out" (오른쪽 중앙)
    // 추가 포트: "out-top" (오른쪽 위), "out-bot" (오른쪽 아래)
    const cx = node.x + NODE_W / 2;
    const cy = node.y + NODE_H / 2;
    if (portType === "in")      return { x: node.x,           y: cy };
    if (portType === "out")     return { x: node.x + NODE_W,  y: cy };
    if (portType === "out-top") return { x: node.x + NODE_W,  y: node.y + NODE_H * 0.25 };
    if (portType === "out-bot") return { x: node.x + NODE_W,  y: node.y + NODE_H * 0.75 };
    if (portType === "in-top")  return { x: node.x,           y: node.y + NODE_H * 0.25 };
    if (portType === "in-bot")  return { x: node.x,           y: node.y + NODE_H * 0.75 };
    return { x: cx, y: cy };
  };

  // ── 엣지 SVG 경로 (베지어 곡선)
  const edgePath = (x1, y1, x2, y2) => {
    const dx = Math.abs(x2 - x1) * 0.5 + 30;
    return `M${x1},${y1} C${x1+dx},${y1} ${x2-dx},${y2} ${x2},${y2}`;
  };

  // ── pointer 이벤트 처리
  const onSVGPointerDown = (e) => {
    if (e.target === svgRef.current || e.target.dataset.canvas === "1") {
      isPanning.current = { startX: e.clientX, startY: e.clientY, origPanX: pan.x, origPanY: pan.y };
      setSelectedNodeId(null); setSelectedEdgeId(null);
      setConnectFrom(null); // 연결 모드 취소
    }
  };

  const onSVGPointerMove = (e) => {
    if (isPanning.current) {
      const dx = e.clientX - isPanning.current.startX;
      const dy = e.clientY - isPanning.current.startY;
      setPan({ x: isPanning.current.origPanX + dx, y: isPanning.current.origPanY + dy });
      return;
    }
    if (dragStateRef.current) {
      const { nodeId, startX, startY, origX, origY } = dragStateRef.current;
      const svgStart = toSVGCoords(startX, startY);
      const svgCur   = toSVGCoords(e.clientX, e.clientY);
      const nx = origX + (svgCur.x - svgStart.x);
      const ny = origY + (svgCur.y - svgStart.y);
      // ref에 기록 + React state는 throttle (16ms)
      dragStateRef.current.curX = nx;
      dragStateRef.current.curY = ny;
      setDragPos(prev => ({ ...prev, [nodeId]: { x: nx, y: ny } }));
    }
  };

  const onSVGPointerUp = () => {
    if (isPanning.current) { isPanning.current = null; return; }
    if (dragStateRef.current) {
      const { nodeId, curX, curY } = dragStateRef.current;
      if (curX !== undefined) {
        // 드래그 완료 → graph에 저장 (1번만 setState)
        setGraph(g => ({ ...g, nodes: g.nodes.map(n => n.id === nodeId ? { ...n, x: curX, y: curY } : n) }));
      }
      dragStateRef.current = null;
      setDragPos({});
    }
  };

  const onWheel = (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setZoom(z => Math.max(0.3, Math.min(2.5, z * delta)));
  };

  // non-passive wheel — canvasRef 컨테이너에 등록 (svgRef는 조건부 렌더링이라 null일 수 있음)
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const handler = (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      setZoom(z => Math.max(0.3, Math.min(2.5, z * delta)));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 노드 클릭 — 드래그 시작 or 연결 처리
  const onNodePointerDown = (e, nodeId) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const node = graph.nodes.find(n => n.id === nodeId);
    if (!node) return;
    dragStateRef.current = { nodeId, startX: e.clientX, startY: e.clientY, origX: node.x, origY: node.y };
  };

  const onNodeClick = (e, nodeId) => {
    e.stopPropagation();
    // 드래그가 있었으면 클릭 무시
    if (dragStateRef.current && dragStateRef.current.curX !== undefined) return;

    if (connectFrom) {
      // 연결 완성
      if (connectFrom !== nodeId) {
        const exists = graph.edges.find(edge => edge.from === connectFrom && edge.to === nodeId);
        if (!exists) setGraph(g => ({ ...g, edges: [...g.edges, { id: uid(), from: connectFrom, to: nodeId }] }));
      }
      setConnectFrom(null);
    } else {
      setSelectedNodeId(nodeId); setSelectedEdgeId(null);
    }
  };

  // ── 엣지 클릭 → 삭제
  const deleteEdge = (edgeId) => {
    setGraph(g => ({ ...g, edges: g.edges.filter(e => e.id !== edgeId) }));
    setSelectedEdgeId(null);
  };

  // ── 작업 편집
  const addTask = (procId) => {
    const t = (taskInps[procId] || "").trim(); if (!t) return;
    setData(d => ({ ...d, procedures: d.procedures.map(p => p.id === procId ? { ...p, customTasks: [...(p.customTasks || []), { id: uid(), title: t, memberId: "", deadline: "" }] } : p) }));
    setTaskInps(i => ({ ...i, [procId]: "" }));
  };
  const removeTask = (procId, tid) => setData(d => ({ ...d, procedures: d.procedures.map(p => p.id === procId ? { ...p, customTasks: (p.customTasks || []).filter(t => t.id !== tid) } : p) }));

  const selectedNode = graph.nodes.find(n => n.id === selectedNodeId);
  const selectedProc = selectedNode ? procs.find(p => p.id === selectedNode.procId) : null;

  // ── SVG 뷰박스
  const SVG_W = 800;
  const SVG_H = 440;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 200px)", minHeight: 580 }}>
      <SH T={T} n={4} title="절차 흐름을 설계하세요 📋" sub="노드를 선택하고 포트(●)를 드래그해 연결선을 만드세요. 복잡한 분기·병렬 구조 모두 가능합니다." />

      {/* ── 상단 팔레트 고정 ── */}
      <div style={{ flexShrink: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 5, marginBottom: 6 }}>
          {PROC_TEMPLATES.map(t => {
            const sel = procs.some(p => p.id === t.id);
            return (
              <div key={t.id} onClick={() => toggleTpl(t)}
                style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 9px", background: sel ? `${t.color}15` : T.surfaceHover, border: `2px solid ${sel ? t.color : T.border2}`, borderRadius: 8, cursor: "pointer", transition: "all .12s", boxShadow: sel ? `0 0 8px ${t.color}22` : "none", position: "relative" }}>
                <span style={{ fontSize: 12 }}>{t.icon}</span>
                <span style={{ color: sel ? t.color : T.textSub, fontSize: 10, fontWeight: sel ? 700 : 400, flex: 1 }}>{t.name}</span>
                {sel ? (
                  <button onClick={e => { e.stopPropagation(); toggleTpl(t); }}
                    style={{ width: 16, height: 16, borderRadius: "50%", background: T.danger, border: "none", color: "#fff", fontSize: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>×</button>
                ) : null}
              </div>
            );
          })}
        </div>
        {/* 커스텀 단계 목록 표시 */}
        {procs.filter(p => p.isCustom).length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 6 }}>
            {procs.filter(p => p.isCustom).map(p => (
              <span key={p.id} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 8px", background: `${p.color}15`, border: `1px solid ${p.color}55`, borderRadius: 7, color: p.color, fontSize: 11, fontWeight: 600 }}>
                {p.icon} {p.name}
                <button onClick={() => removeProc(p.id)} style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0, fontSize: 13, lineHeight: 1, opacity: 0.7 }}>×</button>
              </span>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: 6, marginBottom: 7 }}>
          {showCustom ? (
            <>
              <input autoFocus value={customInp} onChange={e => setCustomInp(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") addCustomProc(); if (e.key === "Escape") { setShowCustom(false); setCustomInp(""); } }}
                placeholder="새 단계 이름 후 Enter"
                style={{ flex: 1, padding: "6px 10px", background: T.surfaceHover, border: `1px solid ${T.accent}`, borderRadius: 7, color: T.text, fontSize: 12, outline: "none", fontFamily: "inherit" }} />
              <button onClick={addCustomProc} style={{ padding: "6px 11px", background: T.accent, border: "none", borderRadius: 7, color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>추가</button>
              <button onClick={() => { setShowCustom(false); setCustomInp(""); }} style={{ padding: "6px 9px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 7, color: T.textSub, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>취소</button>
            </>
          ) : (
            <button onClick={() => setShowCustom(true)} style={{ padding: "6px 12px", background: T.surfaceHover, border: `1px dashed ${T.border2}`, borderRadius: 7, color: T.textMuted, fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontFamily: "inherit" }}>
              <SVG d={I.plus} size={10} /> 직접 추가
            </button>
          )}
          <div style={{ flex: 1 }} />
          {/* 툴바 버튼들 */}
          <button onClick={autoLayout} title="자동 정렬"
            style={{ padding: "6px 11px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 7, color: T.textSub, fontSize: 11, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4 }}>
            ⚡ 자동 정렬
          </button>
          <button onClick={() => setZoom(z => Math.min(2.5, z * 1.2))} style={{ width: 28, height: 28, background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 6, color: T.textSub, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
          <button onClick={() => setZoom(z => Math.max(0.3, z * 0.85))} style={{ width: 28, height: 28, background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 6, color: T.textSub, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
          <button onClick={() => {
            // ⊙ fitView: 노드 바운딩박스 계산 후 캔버스에 맞춤
            const nodes = graph.nodes;
            if (nodes.length === 0) { setZoom(1); setPan({ x: 40, y: 40 }); return; }
            const canvasEl = svgRef.current?.closest("div");
            const cW = canvasEl ? canvasEl.clientWidth : SVG_W;
            const cH = canvasEl ? canvasEl.clientHeight : SVG_H;
            const PADDING = 60;
            const minX = Math.min(...nodes.map(n => n.x));
            const minY = Math.min(...nodes.map(n => n.y));
            const maxX = Math.max(...nodes.map(n => n.x + NODE_W));
            const maxY = Math.max(...nodes.map(n => n.y + NODE_H));
            const contentW = maxX - minX || 1;
            const contentH = maxY - minY || 1;
            const scaleX = (cW - PADDING * 2) / contentW;
            const scaleY = (cH - PADDING * 2) / contentH;
            const newZoom = Math.min(Math.max(Math.min(scaleX, scaleY), 0.25), 1.5);
            const newPanX = (cW - contentW * newZoom) / 2 - minX * newZoom;
            const newPanY = (cH - contentH * newZoom) / 2 - minY * newZoom;
            setZoom(newZoom); setPan({ x: newPanX, y: newPanY });
          }} style={{ width: 28, height: 28, background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 6, color: T.textSub, fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }} title="전체 보기">⊙</button>
          <button onClick={resetGraph} title="초기화"
            style={{ padding: "6px 11px", background: `${T.danger}12`, border: `1px solid ${T.danger}44`, borderRadius: 7, color: T.danger, fontSize: 11, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4 }}>
            🗑 초기화
          </button>
        </div>

        {/* 안내 */}
        <div style={{ padding: "5px 10px", background: connectFrom ? `${T.accent}12` : `${T.accent}08`, border: `1px solid ${connectFrom ? T.accent : T.accent+"18"}`, borderRadius: 7, marginBottom: 7 }}>
          {connectFrom ? (
            <p style={{ color: T.accent, fontSize: 9.5, fontWeight: 700 }}>
              🔗 연결 모드: 도착 노드를 클릭하세요 &nbsp;·&nbsp; <span style={{ cursor: "pointer", textDecoration: "underline" }} onClick={() => setConnectFrom(null)}>취소</span>
            </p>
          ) : (
            <p style={{ color: T.textSub, fontSize: 9.5 }}>
              <strong>노드 클릭</strong> 선택 → <strong>→ 버튼</strong> 연결 모드 → <strong>다른 노드 클릭</strong> 연결 완성 &nbsp;·&nbsp;
              <strong>연결선 클릭</strong> 삭제 &nbsp;·&nbsp;
              <strong>노드 드래그</strong> 이동 &nbsp;·&nbsp;
              <strong>빈 공간 드래그</strong> 패닝 &nbsp;·&nbsp;
              <strong>스크롤</strong> 줌
            </p>
          )}
        </div>
      </div>

      {/* ── 메인 영역: 캔버스 + 우측 패널 ── */}
      <div style={{ flex: 1, display: "flex", gap: 10, minHeight: 0 }}>

        {/* SVG 캔버스 */}
        <div ref={canvasRef} style={{ flex: 1, background: T.surfaceHover, borderRadius: 14, border: `1px solid ${T.border}`, overflow: "hidden", position: "relative", cursor: isPanning.current ? "grabbing" : "default" }}>
          {/* 격자 배경 */}
          <svg width="100%" height="100%" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            <defs>
              <pattern id="grid" width={20*zoom} height={20*zoom} patternUnits="userSpaceOnUse" x={pan.x % (20*zoom)} y={pan.y % (20*zoom)}>
                <path d={`M ${20*zoom} 0 L 0 0 0 ${20*zoom}`} fill="none" stroke={T.border} strokeWidth="0.5" opacity="0.5" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#grid)" />
          </svg>

          {procs.length === 0 ? (
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
              <div style={{ fontSize: 32, marginBottom: 10 }}>📋</div>
              <p style={{ color: T.textMuted, fontSize: 13 }}>위에서 절차를 선택하면 노드가 추가됩니다</p>
            </div>
          ) : (
            <svg
              ref={svgRef}
              width="100%" height="100%"
              style={{ display: "block", touchAction: "none" }}
              onPointerDown={onSVGPointerDown}
              onPointerMove={onSVGPointerMove}
              onPointerUp={onSVGPointerUp}
              onPointerLeave={onSVGPointerUp}
            >
              <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
                {/* 화살표 마커 */}
                <defs>
                  <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                    <path d="M0,0 L0,6 L8,3 z" fill={T.textMuted} />
                  </marker>
                  <marker id="arr-sel" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                    <path d="M0,0 L0,6 L8,3 z" fill={T.danger} />
                  </marker>
                </defs>

                {/* 엣지 */}
                {graph.edges.map(edge => {
                  const fromNode = graph.nodes.find(n => n.id === edge.from);
                  const toNode   = graph.nodes.find(n => n.id === edge.to);
                  if (!fromNode || !toNode) return null;
                  // 드래그 중이면 임시 위치 사용
                  const fn = { ...fromNode, x: dragPos[fromNode.id]?.x ?? fromNode.x, y: dragPos[fromNode.id]?.y ?? fromNode.y };
                  const tn = { ...toNode,   x: dragPos[toNode.id]?.x   ?? toNode.x,   y: dragPos[toNode.id]?.y   ?? toNode.y };
                  const p1 = getPortPos(fn, "out");
                  const p2 = getPortPos(tn, "in");
                  const isSel = selectedEdgeId === edge.id;
                  return (
                    <g key={edge.id} onClick={e => { e.stopPropagation(); setSelectedEdgeId(isSel ? null : edge.id); setSelectedNodeId(null); }}>
                      {/* 투명한 넓은 히트영역 */}
                      <path d={edgePath(p1.x, p1.y, p2.x, p2.y)} fill="none" stroke="transparent" strokeWidth={14} style={{ cursor: "pointer" }} />
                      <path d={edgePath(p1.x, p1.y, p2.x, p2.y)} fill="none"
                        stroke={isSel ? T.danger : T.textMuted}
                        strokeWidth={isSel ? 2.5 : 1.8}
                        strokeDasharray={isSel ? "6,3" : "none"}
                        markerEnd={isSel ? "url(#arr-sel)" : "url(#arr)"}
                        style={{ cursor: "pointer" }}
                      />
                      {/* 선택됐을 때 삭제 버튼 */}
                      {isSel && (() => {
                        const mx = (p1.x + p2.x) / 2;
                        const my = (p1.y + p2.y) / 2;
                        return (
                          <g onClick={e => { e.stopPropagation(); deleteEdge(edge.id); }}>
                            <circle cx={mx} cy={my} r={9} fill={T.danger} style={{ cursor: "pointer" }} />
                            <text x={mx} y={my+1} textAnchor="middle" dominantBaseline="middle" fill="#fff" fontSize={11} style={{ cursor: "pointer", userSelect: "none" }}>✕</text>
                          </g>
                        );
                      })()}
                    </g>
                  );
                })}

                {/* 연결 모드 안내선 제거됨 — 클릭-클릭 방식으로 변경 */}

                {/* 노드 */}
                {graph.nodes.map(node => {
                  const proc = procs.find(p => p.id === node.procId);
                  if (!proc) return null;
                  const isSel  = selectedNodeId === node.id;
                  const isFrom = connectFrom === node.id; // 연결 시작 노드
                  const color  = proc.color || T.accent;
                  const taskCnt = (proc.customTasks || []).length;
                  // 드래그 중이면 임시 위치 사용
                  const nx = dragPos[node.id]?.x ?? node.x;
                  const ny = dragPos[node.id]?.y ?? node.y;

                  return (
                    <g key={node.id}
                      onPointerDown={e => onNodePointerDown(e, node.id)}
                      onClick={e => onNodeClick(e, node.id)}
                      style={{ cursor: connectFrom ? (connectFrom === node.id ? "not-allowed" : "crosshair") : "grab" }}>

                      {/* 연결 대기 중 글로우 */}
                      {isFrom && <rect x={nx-4} y={ny-4} width={NODE_W+8} height={NODE_H+8} rx={13} fill="none" stroke={T.accent} strokeWidth={2} strokeDasharray="6,3" opacity={0.8} />}

                      {/* 노드 바디 */}
                      <rect x={nx} y={ny} width={NODE_W} height={NODE_H} rx={9} ry={9}
                        fill={isFrom ? `${T.accent}25` : isSel ? `${color}18` : T.surface}
                        stroke={isFrom ? T.accent : isSel ? color : T.border2}
                        strokeWidth={isFrom ? 2.5 : isSel ? 2.5 : 1.5}
                        filter={isSel || isFrom ? `drop-shadow(0 0 6px ${isFrom ? T.accent : color}55)` : "none"}
                      />

                      {/* 아이콘 + 이름 */}
                      <text x={nx + 10} y={ny + NODE_H/2 - 5} fontSize={14} dominantBaseline="middle" style={{ userSelect: "none", pointerEvents: "none" }}>{proc.icon}</text>
                      <text x={nx + 30} y={ny + NODE_H/2 - 4} fontSize={11} fontWeight={700} fill={isFrom ? T.accent : isSel ? color : T.text} dominantBaseline="middle" style={{ userSelect: "none", pointerEvents: "none" }}>
                        {proc.name.length > 8 ? proc.name.slice(0, 8) + "…" : proc.name}
                      </text>
                      {taskCnt > 0 && (
                        <text x={nx + 30} y={ny + NODE_H/2 + 11} fontSize={8} fill={T.textMuted} style={{ userSelect: "none", pointerEvents: "none" }}>{taskCnt}개 작업</text>
                      )}

                      {/* 연결 버튼 (선택된 노드에 표시) — 클릭하면 연결 모드 시작 */}
                      {isSel && !isFrom && (
                        <g onClick={e => { e.stopPropagation(); setConnectFrom(node.id); setSelectedNodeId(null); }} style={{ cursor: "crosshair" }}>
                          <circle cx={nx + NODE_W} cy={ny + NODE_H/2} r={11} fill={T.accent} opacity={0.9} />
                          <text x={nx + NODE_W} y={ny + NODE_H/2 + 1} textAnchor="middle" dominantBaseline="middle" fill="#fff" fontSize={12} fontWeight={700} style={{ userSelect: "none", pointerEvents: "none" }}>→</text>
                        </g>
                      )}

                      {/* 노드 위 삭제 버튼 (선택됐을 때) */}
                      {isSel && (
                        <g onClick={e => { e.stopPropagation(); removeProc(proc.id); }} style={{ cursor: "pointer" }}>
                          <circle cx={nx + NODE_W - 1} cy={ny + 1} r={8} fill={T.danger} />
                          <text x={nx + NODE_W - 1} y={ny + 2} textAnchor="middle" dominantBaseline="middle" fill="#fff" fontSize={10} style={{ userSelect: "none" }}>✕</text>
                        </g>
                      )}
                    </g>
                  );
                })}
              </g>
            </svg>
          )}

          {/* 줌 표시 */}
          <div style={{ position: "absolute", bottom: 8, right: 10, fontSize: 10, color: T.textMuted, background: T.surface, padding: "2px 7px", borderRadius: 5, border: `1px solid ${T.border}` }}>
            {Math.round(zoom * 100)}%
          </div>
        </div>

        {/* 우측 패널: 선택된 노드 작업 편집 */}
        {selectedProc ? (
          <div style={{ width: 220, flexShrink: 0, background: T.surface, border: `2px solid ${selectedProc.color || T.accent}`, borderRadius: 12, padding: "14px 14px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ fontSize: 18 }}>{selectedProc.icon}</span>
              <span style={{ color: T.text, fontSize: 13, fontWeight: 700, flex: 1 }}>{selectedProc.name}</span>
              <button onClick={() => setSelectedNodeId(null)} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer" }}><SVG d={I.x} size={12} /></button>
            </div>
            {/* 색상 변경 */}
            <div>
              <p style={{ color: T.textMuted, fontSize: 10, fontWeight: 700, marginBottom: 6 }}>🎨 절차 색상</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 5 }}>
                {["#6366f1","#7c6af7","#a855f7","#ec4899","#ef4444","#f97316","#f59e0b","#10b981","#3b82f6","#06b6d4","#8b5cf6","#64748b"].map(c => (
                  <div key={c} onClick={() => setData(d => ({ ...d, procedures: d.procedures.map(p => p.id === selectedProc.id ? { ...p, color: c } : p) }))}
                    style={{ width: 20, height: 20, borderRadius: "50%", background: c, cursor: "pointer", border: `2px solid ${selectedProc.color === c ? "#fff" : "transparent"}`, outline: selectedProc.color === c ? `2px solid ${c}` : "none", transition: "all .12s" }} />
                ))}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: T.textMuted, fontSize: 9 }}>직접 입력</span>
                <input type="color" value={selectedProc.color || "#6366f1"}
                  onChange={e => setData(d => ({ ...d, procedures: d.procedures.map(p => p.id === selectedProc.id ? { ...p, color: e.target.value } : p) }))}
                  style={{ width: 28, height: 22, border: "none", borderRadius: 4, cursor: "pointer", padding: 0, background: "none" }} />
              </div>
            </div>
            <div style={{ width: "100%", height: 1, background: T.border }} />
            <p style={{ color: T.textMuted, fontSize: 10, fontWeight: 700 }}>📝 작업 목록</p>
            {(selectedProc.customTasks || []).map(task => (
              <div key={task.id} style={{ padding: "6px 8px", background: T.surfaceHover, borderRadius: 7, border: `1px solid ${T.border}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ color: T.text, fontSize: 11, flex: 1 }}>{task.title}</span>
                  <button onClick={() => removeTask(selectedProc.id, task.id)} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 1 }}
                    onMouseEnter={e => e.currentTarget.style.color = T.danger} onMouseLeave={e => e.currentTarget.style.color = T.textMuted}><SVG d={I.x} size={9} /></button>
                </div>
                {members.length > 0 && (
                  <select value={task.memberId || ""} onChange={e => { const m = members.find(x => x.id === e.target.value); setData(d => ({ ...d, procedures: d.procedures.map(p => p.id === selectedProc.id ? { ...p, customTasks: p.customTasks.map(t => t.id === task.id ? { ...t, memberId: e.target.value, memberName: m?.name || "" } : t) } : p) })); }}
                    style={{ marginTop: 4, width: "100%", padding: "3px 5px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 5, color: T.textSub, fontSize: 10, outline: "none", fontFamily: "inherit" }}>
                    <option value="">담당자 미정</option>
                    {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                )}
                <input type="date" value={task.deadline || ""} onChange={e => setData(d => ({ ...d, procedures: d.procedures.map(p => p.id === selectedProc.id ? { ...p, customTasks: p.customTasks.map(t => t.id === task.id ? { ...t, deadline: e.target.value } : t) } : p) }))}
                  style={{ marginTop: 4, width: "100%", padding: "3px 5px", background: T.surfaceHover, border: `1px solid ${task.deadline ? T.accent : T.border2}`, borderRadius: 5, color: task.deadline ? T.accent : T.textSub, fontSize: 10, outline: "none", fontFamily: "inherit" }} />
              </div>
            ))}
            <div style={{ display: "flex", gap: 5 }}>
              <input value={taskInps[selectedProc.id] || ""} onChange={e => setTaskInps(i => ({ ...i, [selectedProc.id]: e.target.value }))} onKeyDown={e => e.key === "Enter" && addTask(selectedProc.id)} placeholder="작업 입력 후 Enter"
                style={{ flex: 1, padding: "6px 8px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 7, color: T.text, fontSize: 11, outline: "none", fontFamily: "inherit" }} />
              <button onClick={() => addTask(selectedProc.id)} style={{ padding: "6px 10px", background: T.accent, border: "none", borderRadius: 7, color: "#fff", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>+</button>
            </div>
            {/* 엣지 삭제 안내 */}
            {selectedEdgeId && (
              <div style={{ padding: "8px 10px", background: `${T.danger}10`, border: `1px solid ${T.danger}33`, borderRadius: 7 }}>
                <p style={{ color: T.danger, fontSize: 10, marginBottom: 6 }}>연결선이 선택됨</p>
                <button onClick={() => deleteEdge(selectedEdgeId)} style={{ width: "100%", padding: "5px 0", background: T.danger, border: "none", borderRadius: 6, color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>연결 삭제</button>
              </div>
            )}
          </div>
        ) : selectedEdgeId ? (
          <div style={{ width: 180, flexShrink: 0, background: T.surface, border: `2px solid ${T.danger}`, borderRadius: 12, padding: "14px 14px" }}>
            <p style={{ color: T.danger, fontSize: 12, fontWeight: 700, marginBottom: 10 }}>🔗 연결선 선택됨</p>
            <p style={{ color: T.textSub, fontSize: 11, marginBottom: 12 }}>이 연결을 삭제하시겠습니까?</p>
            <button onClick={() => deleteEdge(selectedEdgeId)} style={{ width: "100%", padding: "8px 0", background: T.danger, border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>🗑 삭제</button>
          </div>
        ) : (
          <div style={{ width: 160, flexShrink: 0, background: T.surfaceHover, border: `1px dashed ${T.border2}`, borderRadius: 12, padding: "14px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <span style={{ fontSize: 24, opacity: 0.4 }}>👆</span>
            <p style={{ color: T.textMuted, fontSize: 11, textAlign: "center", lineHeight: 1.5 }}>
              노드를 클릭하면 작업을 편집할 수 있어요
            </p>
            <div style={{ width: "100%", height: 1, background: T.border }} />
            <p style={{ color: T.textMuted, fontSize: 10, textAlign: "center", lineHeight: 1.6 }}>
              오른쪽 <span style={{ color: T.accent }}>● 포트</span>에서 드래그해 연결하세요
            </p>
          </div>
        )}
      </div>
    </div>
  );
}


function OStep5({ T, data, setData }) {
  const roles   = data.roles || BASE_ROLES.map(r => ({ ...r }));
  const members = data.members || [];
  const assigns = data.roleAssignments || {};
  // 멤버별 서포트 슬롯 개수 (기본 2)
  const [supportCounts, setSupportCounts] = useState({});
  const [showRoleInp,   setShowRoleInp]   = useState(false);
  const [roleInp,       setRoleInp]       = useState("");
  const [editingEmoji,  setEditingEmoji]  = useState(null); // 이모지 편집 중인 role id
  const [emojiInp,      setEmojiInp]      = useState("");
  const ROLE_COLORS = ["#6366f1","#10b981","#f59e0b","#ec4899","#3b82f6","#ef4444","#8b5cf6","#f97316"];
  const EMOJI_PRESETS = ["⭐","🔥","💡","🎯","🛠️","📊","🎤","🖥️","🔍","🏆","✍️","🤝","🎨","📋","⚙️","🚀"];

  const getSupportCount = mId => supportCounts[mId] ?? 2;

  const upd = (mId, key, rId) => setData(d => ({ ...d, roleAssignments: { ...d.roleAssignments, [mId]: { ...(d.roleAssignments?.[mId] || {}), [key]: rId } } }));

  const addRole = () => {
    const name = roleInp.trim(); if (!name) return;
    const newRole = { id: uid(), name, icon: "⭐", color: ROLE_COLORS[roles.length % ROLE_COLORS.length] };
    setData(d => ({ ...d, roles: [...(d.roles || BASE_ROLES.map(x => ({ ...x }))), newRole] }));
    setRoleInp(""); setShowRoleInp(false);
  };
  const deleteRole = roleId => {
    const newAssigns = { ...assigns };
    Object.keys(newAssigns).forEach(mId => {
      const a = { ...newAssigns[mId] };
      Object.keys(a).forEach(k => { if (a[k] === roleId) delete a[k]; });
      newAssigns[mId] = a;
    });
    setData(d => ({ ...d, roles: (d.roles || BASE_ROLES.map(x => ({ ...x }))).filter(r => r.id !== roleId), roleAssignments: newAssigns }));
  };
  const updateRoleEmoji = (roleId, emoji) => {
    setData(d => ({ ...d, roles: (d.roles || BASE_ROLES.map(x => ({ ...x }))).map(r => r.id === roleId ? { ...r, icon: emoji } : r) }));
    setEditingEmoji(null); setEmojiInp("");
  };

  const addSupport = mId => setSupportCounts(c => ({ ...c, [mId]: (c[mId] ?? 2) + 1 }));
  const removeSupport = mId => {
    const cur = getSupportCount(mId);
    if (cur <= 0) return;
    // 마지막 서포트 슬롯 값도 제거
    const key = `support${cur}`;
    const newAssigns = { ...assigns, [mId]: { ...(assigns[mId] || {}) } };
    delete newAssigns[mId][key];
    setData(d => ({ ...d, roleAssignments: newAssigns }));
    setSupportCounts(c => ({ ...c, [mId]: cur - 1 }));
  };

  return (
    <div>
      <SH T={T} n={5} title="역할을 분담하세요 🎭" sub="리드 역할과 서포트 역할을 팀원별로 지정하세요. 서포트 슬롯은 자유롭게 추가/제거 가능합니다." />

      {/* 역할 목록 */}
      <div style={{ background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 12, padding: "13px 14px", marginBottom: 20 }}>
        <p style={{ color: T.textSub, fontSize: 11, fontWeight: 700, marginBottom: 10, textTransform: "uppercase", letterSpacing: .5 }}>역할 목록</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 10 }}>
          {roles.map(r => (
            <span key={r.id} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 8px 5px 10px", background: `${r.color}18`, border: `1px solid ${r.color}55`, borderRadius: 100, color: r.color, fontSize: 12, fontWeight: 600 }}>
              {/* 이모지 클릭 → 편집 */}
              <button onClick={() => { setEditingEmoji(r.id); setEmojiInp(r.icon); }}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 14, lineHeight: 1 }}
                title="이모지 변경">
                {r.icon}
              </button>
              {r.name}
              <button onClick={() => deleteRole(r.id)} style={{ width: 15, height: 15, borderRadius: "50%", background: `${r.color}30`, border: "none", color: r.color, cursor: "pointer", padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 10 }}
                onMouseEnter={e => { e.currentTarget.style.background = T.danger+"33"; e.currentTarget.style.color = T.danger; }}
                onMouseLeave={e => { e.currentTarget.style.background = `${r.color}30`; e.currentTarget.style.color = r.color; }}>×</button>
            </span>
          ))}
        </div>

        {/* 이모지 편집 팝업 */}
        {editingEmoji && (
          <div style={{ padding: "12px 14px", background: T.surface, border: `1px solid ${T.accent}`, borderRadius: 10, marginBottom: 10 }}>
            <p style={{ color: T.textSub, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>이모지 선택</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
              {EMOJI_PRESETS.map(e => (
                <button key={e} onClick={() => updateRoleEmoji(editingEmoji, e)}
                  style={{ width: 34, height: 34, fontSize: 18, background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 8, cursor: "pointer" }}>
                  {e}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 7 }}>
              <input autoFocus value={emojiInp} onChange={e => setEmojiInp(e.target.value)} placeholder="직접 입력"
                style={{ width: 60, padding: "6px 10px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 7, color: T.text, fontSize: 14, outline: "none", fontFamily: "inherit", textAlign: "center" }} />
              <button onClick={() => updateRoleEmoji(editingEmoji, emojiInp || "⭐")} style={{ padding: "6px 13px", background: T.accent, border: "none", borderRadius: 7, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>적용</button>
              <button onClick={() => setEditingEmoji(null)} style={{ padding: "6px 11px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 7, color: T.textSub, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>취소</button>
            </div>
          </div>
        )}

        {showRoleInp ? (
          <div style={{ display: "flex", gap: 7 }}>
            <input autoFocus value={roleInp} onChange={e => setRoleInp(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") addRole(); if (e.key === "Escape") { setShowRoleInp(false); setRoleInp(""); } }}
              placeholder="역할 이름 입력 후 Enter"
              style={{ flex: 1, padding: "7px 11px", background: T.surface, border: `1px solid ${T.accent}`, borderRadius: 8, color: T.text, fontSize: 12, outline: "none", fontFamily: "inherit" }} />
            <button onClick={addRole} style={{ padding: "7px 14px", background: T.accent, border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>추가</button>
            <button onClick={() => { setShowRoleInp(false); setRoleInp(""); }} style={{ padding: "7px 11px", background: T.surface, border: `1px solid ${T.border2}`, borderRadius: 8, color: T.textSub, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>취소</button>
          </div>
        ) : (
          <button onClick={() => setShowRoleInp(true)} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 12px", background: T.surface, border: `1px dashed ${T.border2}`, borderRadius: 100, color: T.textMuted, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
            <SVG d={I.plus} size={11} /> 역할 추가
          </button>
        )}
      </div>

      {/* 팀원별 역할 배정 */}
      {members.length === 0 ? <p style={{ color: T.textMuted, fontSize: 13 }}>팀원이 없습니다.</p>
        : members.map(m => {
          const supCount = getSupportCount(m.id);
          return (
            <div key={m.id} style={{ padding: "13px 15px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: 11, marginBottom: 9 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <div style={{ width: 26, height: 26, borderRadius: "50%", background: T.accent, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 11, fontWeight: 700 }}>{m.name[0]}</div>
                  <span style={{ color: T.text, fontSize: 13, fontWeight: 700 }}>{m.name}</span>
                </div>
                {/* 서포트 슬롯 +/- */}
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ color: T.textMuted, fontSize: 10 }}>서포트 {supCount}개</span>
                  <button onClick={() => removeSupport(m.id)} disabled={supCount <= 0}
                    style={{ width: 22, height: 22, borderRadius: 6, background: supCount > 0 ? T.surfaceHover : T.border, border: `1px solid ${T.border2}`, color: supCount > 0 ? T.textSub : T.textMuted, fontSize: 14, cursor: supCount > 0 ? "pointer" : "default", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" }}>−</button>
                  <button onClick={() => addSupport(m.id)}
                    style={{ width: 22, height: 22, borderRadius: 6, background: T.surfaceHover, border: `1px solid ${T.border2}`, color: T.textSub, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" }}>+</button>
                </div>
              </div>

              {/* 리드 + 서포트 슬롯들 */}
              <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(supCount + 1, 4)}, 1fr)`, gap: 8 }}>
                {/* 리드 */}
                <div>
                  <label style={{ display: "block", color: T.textMuted, fontSize: 10, marginBottom: 4, fontWeight: 700 }}>🌟 리드</label>
                  <select value={(assigns[m.id] || {}).lead || ""} onChange={e => upd(m.id, "lead", e.target.value)}
                    style={{ width: "100%", padding: "6px 8px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 7, color: T.text, fontSize: 11, outline: "none", fontFamily: "inherit" }}>
                    <option value="">선택</option>
                    {roles.map(r => <option key={r.id} value={r.id}>{r.icon} {r.name}</option>)}
                  </select>
                </div>
                {/* 서포트 슬롯들 */}
                {Array.from({ length: supCount }, (_, i) => {
                  const key = `support${i + 1}`;
                  return (
                    <div key={key}>
                      <label style={{ display: "block", color: T.textMuted, fontSize: 10, marginBottom: 4, fontWeight: 700 }}>🤝 서포트 {i + 1}</label>
                      <select value={(assigns[m.id] || {})[key] || ""} onChange={e => upd(m.id, key, e.target.value)}
                        style={{ width: "100%", padding: "6px 8px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 7, color: T.text, fontSize: 11, outline: "none", fontFamily: "inherit" }}>
                        <option value="">선택</option>
                        {roles.map(r => <option key={r.id} value={r.id}>{r.icon} {r.name}</option>)}
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })
      }
    </div>
  );
}

// ─── PROJECT SCREEN ───────────────────────────────────────────────────────────
function ProjectScreen({ T, dark, setDark, project, tab, setTab, loginName, currentAccount, onUpdate, onUpdateProject, onDeleteProject, onRegenCode, onTaskChange, onAddTask, onDeleteTask, onAddProcedure, onUpdateProcedure, onDeleteProcedure, onReorderProcedures, onFileUpload, notify, onBack, onGoHome, notifications, onClearNotif, onAddNotif, sideCollapsed, onSideCollapse }) {
  const isOwner = currentAccount && project.ownerAccountId === currentAccount.id;
  const total = project.procedures.reduce((a, s) => a + s.tasks.length, 0);
  const done  = project.procedures.reduce((a, s) => a + s.tasks.filter(t => t.status === "done").length, 0);
  const pct   = total ? Math.round(done / total * 100) : 0;
  const sideW = sideCollapsed ? 60 : 220;

  const TABS = [
    { id: "dashboard", icon: "📊", label: "대시보드" },
    { id: "tasks",     icon: "✅", label: "작업 관리" },
    { id: "gantt",     icon: "📅", label: "스케줄" },
    { id: "mytasks",   icon: "🙋", label: "내 작업" },
    { id: "settings",  icon: "⚙️", label: "설정" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: T.bg, display: "flex", fontFamily: "'Pretendard','Apple SD Gothic Neo',sans-serif" }}>
      <Sidebar T={T} dark={dark} setDark={setDark} loginName={loginName} currentAccount={currentAccount}
        activeItem={tab} items={TABS} onItemClick={t => {
          setTab(t);
          try { const raw = localStorage.getItem(SESSION_KEY); const sess = raw ? JSON.parse(raw) : {}; localStorage.setItem(SESSION_KEY, JSON.stringify({ ...sess, lastTab: t })); } catch {}
        }}
        projectInfo={{ name: project.name, pct }}
        notifications={notifications} onClearNotif={onClearNotif} onAddNotif={onAddNotif}
        collapsed={sideCollapsed} onCollapse={onSideCollapse}
        onGoHome={onGoHome || onBack}
        projectMembers={project.members.map(m => ({ id: m.id, name: m.name, accountId: m.accountId, role: m.role }))}
        extra={
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            <button onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 5, color: T.textMuted, fontSize: 11, background: "none", border: `1px solid ${T.border2}`, borderRadius: 6, cursor: "pointer", padding: "4px 8px", fontFamily: "inherit" }}>← 목록</button>
            {isOwner
              ? <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 100, background: `${T.accent}20`, color: T.accent, fontWeight: 700 }}>오너</span>
              : <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 100, background: `${T.success}15`, color: T.success, fontWeight: 700 }}>구성원</span>}
          </div>
        } />
      <div style={{ marginLeft: sideW, flex: 1, padding: "32px 36px", minWidth: 0, overflowX: "hidden", transition: "margin-left .2s cubic-bezier(.4,0,.2,1)" }}>
        {tab === "dashboard" && <DashTab T={T} project={project} pct={pct} onAddProcedure={onAddProcedure} onUpdateProcedure={onUpdateProcedure} onDeleteProcedure={onDeleteProcedure} onReorderProcedures={onReorderProcedures} onTaskChange={onTaskChange} notify={notify} onUpdateFlowGraph={async (newGraph) => { try { await supabase.from("projects").update({ flow_graph: newGraph }).eq("id", project.id); } catch(e) { notify("흐름 저장 실패: "+e.message, "err"); } }} />}
        {tab === "tasks"     && <TasksTab T={T} project={project} loginName={loginName} onTaskChange={onTaskChange} onAddTask={onAddTask} onDeleteTask={onDeleteTask} onAddProcedure={onAddProcedure} onUpdateProcedure={onUpdateProcedure} onDeleteProcedure={onDeleteProcedure} onFileUpload={onFileUpload} notify={notify} />}
        {tab === "gantt"     && <GanttTab T={T} project={project} onTaskChange={onTaskChange} onAddTask={onAddTask} onUpdateProject={onUpdateProject} notify={notify} isOwner={isOwner} currentAccount={currentAccount} />}
        {tab === "calendar"  && <CalendarTab T={T} project={project} onTaskChange={onTaskChange} isOwner={isOwner} />}
        {tab === "mytasks"   && <MyTasksTab T={T} project={project} loginName={loginName} onTaskChange={onTaskChange} onDeleteTask={onDeleteTask} onFileUpload={onFileUpload} notify={notify} />}
        {tab === "settings"  && <SettingsTab T={T} project={project} isOwner={isOwner} onUpdateProject={onUpdateProject} onDeleteProject={onDeleteProject} onRegenCode={onRegenCode} notify={notify} onBack={onBack} />}
      </div>
    </div>
  );
}

// ─── SETTINGS TAB ─────────────────────────────────────────────────────────────
function SettingsTab({ T, project, isOwner, onUpdateProject, onDeleteProject, onRegenCode, notify, onBack }) {
  const [name, setName]           = useState(project.name);
  const [topic, setTopic]         = useState(project.topic || "");
  const [startDate, setStartDate] = useState(project.startDate || "");
  const [endDate, setEndDate]     = useState(project.endDate || "");
  const [saving, setSaving]       = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [copied, setCopied]       = useState(false);
  const [regenning, setRegenning] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) { notify("프로젝트 이름을 입력해주세요.", "err"); return; }
    setSaving(true); await onUpdateProject({ name: name.trim(), topic, startDate, endDate }); setSaving(false);
  };
  const handleCopy = () => {
    if (!project.inviteCode) return;
    navigator.clipboard.writeText(project.inviteCode).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  const field = (label, val, set, type = "text") => (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", color: T.textSub, fontSize: 11, fontWeight: 700, marginBottom: 6, textTransform: "uppercase", letterSpacing: .5 }}>{label}</label>
      <input type={type} value={val} onChange={e => set(e.target.value)} disabled={!isOwner}
        style={{ width: "100%", padding: "10px 14px", background: isOwner ? T.surfaceHover : T.surface, border: `1px solid ${T.border2}`, borderRadius: 8, color: isOwner ? T.text : T.textSub, fontSize: 13, outline: "none", boxSizing: "border-box", fontFamily: "inherit", cursor: isOwner ? "text" : "not-allowed" }} />
    </div>
  );

  return (
    <div style={{ maxWidth: 640 }}>
      <h1 style={{ color: T.text, fontSize: 24, fontWeight: 800, marginBottom: 4 }}>프로젝트 설정</h1>
      <p style={{ color: T.textSub, fontSize: 13, marginBottom: 32 }}>{isOwner ? "프로젝트 정보를 수정하고, 팀원을 초대하거나 프로젝트를 삭제할 수 있습니다." : "프로젝트 정보를 확인합니다. 수정은 오너만 가능합니다."}</p>
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14, padding: "22px 24px", marginBottom: 20 }}>
        <h3 style={{ color: T.text, fontSize: 14, fontWeight: 700, marginBottom: 18 }}>📝 기본 정보</h3>
        {field("프로젝트 이름", name, setName)}
        {field("대주제", topic, setTopic)}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          {field("시작일", startDate, setStartDate, "date")}
          {field("종료일", endDate, setEndDate, "date")}
        </div>
        {isOwner && <button onClick={handleSave} disabled={saving} style={{ padding: "10px 22px", background: `linear-gradient(135deg,${T.accent},${T.accentSub})`, border: "none", borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", marginTop: 4 }}>{saving ? "저장 중..." : "💾 저장"}</button>}
      </div>
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14, padding: "22px 24px", marginBottom: 20 }}>
        <h3 style={{ color: T.text, fontSize: 14, fontWeight: 700, marginBottom: 6 }}>🔗 팀원 초대</h3>
        <p style={{ color: T.textMuted, fontSize: 12, marginBottom: 16 }}>이 코드를 팀원에게 공유하세요.</p>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, padding: "14px 20px", background: `${T.accent}10`, border: `2px dashed ${T.accent}55`, borderRadius: 10, textAlign: "center" }}>
            <span style={{ color: T.accent, fontSize: 28, fontWeight: 900, letterSpacing: 8, fontFamily: "monospace" }}>{project.inviteCode || "------"}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <button onClick={handleCopy} style={{ padding: "8px 16px", background: copied ? T.success : T.accent, border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>{copied ? "✓ 복사됨" : "📋 복사"}</button>
            {isOwner && <button onClick={async () => { setRegenning(true); await onRegenCode(); setRegenning(false); }} disabled={regenning} style={{ padding: "8px 16px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 8, color: T.textSub, fontSize: 12, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>{regenning ? "..." : "🔄 재발급"}</button>}
          </div>
        </div>
      </div>
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14, padding: "22px 24px", marginBottom: 20 }}>
        <h3 style={{ color: T.text, fontSize: 14, fontWeight: 700, marginBottom: 16 }}>👥 구성원 ({project.members.length}명)</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {project.members.map((m, idx) => {
            const avatarColor = `hsl(${(idx * 57 + 200) % 360}, 60%, 52%)`;
            const mr = m.memberRoles || {};
            const roleChips = [
              mr.lead     ? { label: mr.lead.name,     icon: mr.lead.icon,     color: mr.lead.color,     tag: "리드" } : null,
              mr.support1 ? { label: mr.support1.name, icon: mr.support1.icon, color: mr.support1.color, tag: "서포트" } : null,
              mr.support2 ? { label: mr.support2.name, icon: mr.support2.icon, color: mr.support2.color, tag: "서포트" } : null,
            ].filter(Boolean);
            return (
              <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", background: T.surfaceHover, borderRadius: 10, border: `1px solid ${T.border}` }}>
                <div style={{ width: 32, height: 32, borderRadius: "50%", background: avatarColor, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 13, fontWeight: 700 }}>{m.name[0]}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ color: T.text, fontSize: 13, fontWeight: 700 }}>{m.name}</span>
                  {roleChips.length > 0 && (
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                      {roleChips.map((rc, i) => (
                        <span key={i} style={{ fontSize: 10, padding: "2px 7px", borderRadius: 100, fontWeight: 700, background: `${rc.color || T.accent}20`, color: rc.color || T.accent, border: `1px solid ${rc.color || T.accent}44` }}>
                          {rc.icon} {rc.tag === "리드" ? "★ " : ""}{rc.label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 100, fontWeight: 700, flexShrink: 0, background: m.accountId ? `${T.success}15` : `${T.warn}15`, color: m.accountId ? T.success : T.warn }}>{m.accountId ? "✓ 가입됨" : "미가입"}</span>
                <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 100, fontWeight: 700, flexShrink: 0, background: m.role === "owner" ? `${T.accent}15` : T.border, color: m.role === "owner" ? T.accent : T.textSub }}>{m.role === "owner" ? "오너" : "멤버"}</span>
              </div>
            );
          })}
        </div>
      </div>
      {isOwner && (
        <div style={{ background: `${T.danger}08`, border: `1px solid ${T.danger}33`, borderRadius: 14, padding: "22px 24px" }}>
          <h3 style={{ color: T.danger, fontSize: 14, fontWeight: 700, marginBottom: 8 }}>⚠️ 위험 구역</h3>
          <p style={{ color: T.textMuted, fontSize: 12, marginBottom: 16 }}>프로젝트를 삭제하면 모든 데이터가 영구 삭제됩니다.</p>
          {!confirmDel ? (
            <button onClick={() => setConfirmDel(true)} style={{ padding: "9px 20px", background: "transparent", border: `1px solid ${T.danger}`, borderRadius: 8, color: T.danger, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>🗑️ 프로젝트 삭제</button>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", background: `${T.danger}12`, borderRadius: 10, border: `1px solid ${T.danger}44` }}>
              <span style={{ color: T.danger, fontSize: 13, fontWeight: 600, flex: 1 }}>정말로 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.</span>
              <button onClick={async () => { await onDeleteProject(); onBack(); }} style={{ padding: "8px 18px", background: T.danger, border: "none", borderRadius: 7, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>삭제 확인</button>
              <button onClick={() => setConfirmDel(false)} style={{ padding: "8px 14px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 7, color: T.textSub, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>취소</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function DashTab({ T, project, pct, onAddProcedure, onUpdateProcedure, onDeleteProcedure, onReorderProcedures, onTaskChange, notify, onUpdateFlowGraph }) {
  const total = project.procedures.reduce((a, s) => a + s.tasks.length, 0);
  const done  = project.procedures.reduce((a, s) => a + s.tasks.filter(t => t.status === "done").length, 0);
  const doing = project.procedures.reduce((a, s) => a + s.tasks.filter(t => t.status === "doing").length, 0);

  return (
    <div>
      {/* 헤더 */}
      <div style={{ marginBottom: 22 }}>
        <h1 style={{ color: T.text, fontSize: 26, fontWeight: 800, marginBottom: 4 }}>{project.name}</h1>
        <p style={{ color: T.textSub, fontSize: 13 }}>💡 {project.topic || "대주제 미설정"}</p>
      </div>

      {/* 스탯 카드 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 18 }}>
        {[["전체 진행률",`${pct}%`,"📊"],["전체 작업",total,"📋"],["진행중",doing,"⚡"],["완료",done,"✅"]].map(([label, value, icon], i) => (
          <div key={i} style={{ padding: "16px 18px", background: T.card, border: `1px solid ${T.border}`, borderRadius: 13 }}>
            <div style={{ fontSize: 18, marginBottom: 5 }}>{icon}</div>
            <div style={{ color: T.text, fontSize: 22, fontWeight: 800, marginBottom: 2 }}>{value}</div>
            <div style={{ color: T.textSub, fontSize: 11 }}>{label}</div>
          </div>
        ))}
      </div>

      {/* 진행 현황 바 */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 13, padding: "15px 18px", marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ color: T.text, fontSize: 13, fontWeight: 700 }}>전체 진행 현황</span>
          <span style={{ color: T.accent, fontSize: 13, fontWeight: 800 }}>{pct}%</span>
        </div>
        <div style={{ background: T.border, borderRadius: 100, height: 6, overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: `linear-gradient(90deg,${T.accent},${T.accentSub})`, borderRadius: 100, transition: "width .8s" }} />
        </div>
        <div style={{ display: "flex", gap: 14, marginTop: 8 }}>
          {[["미진행", total-done-doing, "#94a3b8"],["진행중", doing, T.warn],["완료", done, T.success]].map(([l,v,c]) => (
            <div key={l} style={{ display:"flex", alignItems:"center", gap:5 }}>
              <div style={{ width:7, height:7, borderRadius:"50%", background:c }} />
              <span style={{ color:T.textSub, fontSize:11 }}>{l} {v}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── DAG 흐름 위젯 ── */}
      <DashFlowWidget T={T} project={project}
        onUpdateProcedure={onUpdateProcedure}
        onDeleteProcedure={onDeleteProcedure}
        onTaskChange={onTaskChange}
        onUpdateFlowGraph={onUpdateFlowGraph}
        notify={notify} />

      {/* 팀원 현황 */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 13, padding: 18 }}>
        <h3 style={{ color: T.text, fontSize: 13, fontWeight: 700, marginBottom: 13 }}>👥 팀원 현황</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: 9 }}>
          {project.members.map(m => {
            const mt = project.procedures.flatMap(p => p.tasks.filter(t => t.memberId === m.id));
            const md = mt.filter(t => t.status === "done").length;
            const mp = mt.length ? Math.round(md / mt.length * 100) : 0;
            return (
              <div key={m.id} style={{ padding: "12px 13px", background: T.surfaceHover, border: `1px solid ${T.border}`, borderRadius: 9 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 7 }}>
                  <div style={{ width: 26, height: 26, borderRadius: "50%", background: T.accent, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 11, fontWeight: 700 }}>{m.name[0]}</div>
                  <span style={{ color: T.text, fontSize: 12, fontWeight: 700 }}>{m.name}</span>
                </div>
                <div style={{ background: T.border, borderRadius: 100, height: 2, marginBottom: 3 }}>
                  <div style={{ width: `${mp}%`, height: "100%", background: T.accent, borderRadius: 100 }} />
                </div>
                <span style={{ color: T.textMuted, fontSize: 10 }}>{md}/{mt.length} 완료</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── DASH FLOW WIDGET: DAG 뷰어 + 노션 스타일 슬라이드 패널 ──────────────────
function DashFlowWidget({ T, project, onUpdateProcedure, onDeleteProcedure, onTaskChange, onUpdateFlowGraph, notify }) {
  const [selectedProcId, setSelectedProcId] = useState(null);
  const [panelW, setPanelW]               = useState(320);
  const [isResizing, setIsResizing]       = useState(false);
  const [pan,  setPan]   = useState({ x: 20, y: 20 });
  const [zoom, setZoom]  = useState(0.85);
  const [localNodes, setLocalNodes]       = useState(null);
  const [localEdges, setLocalEdges]       = useState(null); // 로컬 edge 즉시 반영
  const svgRef           = useRef(null);
  const containerRef     = useRef(null);
  const isPanning        = useRef(null);
  const isDraggingNode   = useRef(null);
  const resizeStartX     = useRef(null);
  const resizeStartW     = useRef(null);
  const [editingNodeId, setEditingNodeId] = useState(null);
  const [editName, setEditName]           = useState("");
  const [confirmDelId, setConfirmDelId]   = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null); // 선택된 엣지
  const [connectFrom, setConnectFrom]     = useState(null); // 클릭-클릭 연결 시작 노드

  const graph  = project.flowGraph || { nodes: [], edges: [] };
  const procs  = project.procedures || [];
  const NODE_W = 120, NODE_H = 50;

  // flowGraph 업데이트 — 로컬 즉시 반영 + DB 저장
  const updateGraph = (newGraph) => {
    setLocalNodes(newGraph.nodes);
    setLocalEdges(newGraph.edges);
    if (onUpdateFlowGraph) onUpdateFlowGraph(newGraph);
  };

  const selectedProc = selectedProcId ? procs.find(p => p.id === selectedProcId) : null;
  const selectedProcTasks = selectedProc
    ? (project.procedures.find(p => p.id === selectedProcId)?.tasks || [])
    : [];

  // flowGraph가 비어 있으면 절차 목록 기반 선형 레이아웃으로 자동 생성
  // 저장된 flowGraph가 있으면 그것을 그대로 사용 (병렬 구조 보존)
  const effectiveGraph = (() => {
    const baseNodes = localNodes || graph.nodes;
    const baseEdges = localEdges !== null ? localEdges : graph.edges;
    if (baseNodes.length > 0) return { nodes: baseNodes, edges: baseEdges };
    // 자동 생성 (뷰 전용, 저장 안 함) - 직렬 레이아웃
    return {
      nodes: procs.map((p, i) => ({ id: "auto_" + p.id, procId: p.id, x: 40 + i * (NODE_W + 50), y: 80 })),
      edges: procs.slice(0, -1).map((p, i) => ({ id: "ae_" + i, from: "auto_" + p.id, to: "auto_" + procs[i+1].id })),
    };
  })();

  // 포트 위치
  const getPortPos = (node, portType) => {
    if (portType === "in")      return { x: node.x,          y: node.y + NODE_H/2 };
    if (portType === "out")     return { x: node.x + NODE_W, y: node.y + NODE_H/2 };
    if (portType === "out-top") return { x: node.x + NODE_W, y: node.y + NODE_H * 0.28 };
    if (portType === "out-bot") return { x: node.x + NODE_W, y: node.y + NODE_H * 0.72 };
    return { x: node.x + NODE_W/2, y: node.y + NODE_H/2 };
  };

  const edgePath = (x1,y1,x2,y2) => {
    const dx = Math.abs(x2-x1)*0.5 + 24;
    return `M${x1},${y1} C${x1+dx},${y1} ${x2-dx},${y2} ${x2},${y2}`;
  };

  const toSVG = (cx, cy) => {
    if (!svgRef.current) return { x:cx, y:cy };
    const r = svgRef.current.getBoundingClientRect();
    return { x: (cx - r.left - pan.x)/zoom, y: (cy - r.top - pan.y)/zoom };
  };

  // ── pointer 이벤트
  const onSVGDown = e => {
    if (e.target === svgRef.current || e.target.dataset?.canvas === "1") {
      isPanning.current = { sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y };
      setSelectedProcId(null);
      setSelectedEdgeId(null);
      setConnectFrom(null);
    }
  };
  const onSVGMove = e => {
    if (isPanning.current) {
      setPan({ x: isPanning.current.ox + e.clientX - isPanning.current.sx, y: isPanning.current.oy + e.clientY - isPanning.current.sy });
      return;
    }
    if (isDraggingNode.current) {
      const { nodeId, sx, sy, ox, oy } = isDraggingNode.current;
      const s0 = toSVG(sx, sy), s1 = toSVG(e.clientX, e.clientY);
      const dx = s1.x - s0.x, dy = s1.y - s0.y;
      isDraggingNode.current.curX = ox + dx;
      isDraggingNode.current.curY = oy + dy;
      isDraggingNode.current.moved = true;
      setPan(p => ({ ...p }));
      return;
    }
  };
  const onSVGUp = e => {
    if (isPanning.current) { isPanning.current = null; return; }
    if (isDraggingNode.current && isDraggingNode.current.moved) {
      const { nodeId, curX, curY } = isDraggingNode.current;
      setLocalNodes(prev => {
        const base = prev || effectiveGraph.nodes;
        return base.map(n => n.id === nodeId ? { ...n, x: curX, y: curY } : n);
      });
      isDraggingNode.current = null;
      return;
    }
    if (isDraggingNode.current) { isDraggingNode.current = null; }
  };

  const onNodeDown = (e, nodeId) => {
    e.stopPropagation();
    const node = effectiveGraph.nodes.find(n => n.id === nodeId);
    if (!node) return;
    isDraggingNode.current = { nodeId, sx: e.clientX, sy: e.clientY, ox: node.x, oy: node.y, moved: false, curX: node.x, curY: node.y };
  };
  const onNodeClick = (e, node) => {
    e.stopPropagation();
    if (isDraggingNode.current?.moved) return;

    if (connectFrom) {
      // 연결 완성
      if (connectFrom !== node.id) {
        const curGraph = { nodes: effectiveGraph.nodes, edges: effectiveGraph.edges };
        const exists = curGraph.edges.find(edge => edge.from === connectFrom && edge.to === node.id);
        if (!exists) {
          const newGraph = { ...curGraph, edges: [...curGraph.edges, { id: uid(), from: connectFrom, to: node.id }] };
          updateGraph(newGraph);
        }
      }
      setConnectFrom(null);
    } else {
      const proc = procs.find(p => p.id === node.procId);
      if (!proc) return;
      setSelectedProcId(prev => prev === proc.id ? null : proc.id);
      setEditingNodeId(null);
    }
  };

  // ── 리사이저 드래그
  const onResizerDown = e => {
    e.preventDefault();
    setIsResizing(true);
    resizeStartX.current = e.clientX;
    resizeStartW.current = panelW;
    const onMove = ev => {
      const delta = resizeStartX.current - ev.clientX;
      setPanelW(Math.max(180, Math.min(520, resizeStartW.current + delta)));
    };
    const onUp = () => { setIsResizing(false); window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // ── 이름 편집 저장
  const saveEdit = async () => {
    if (!editName.trim() || !editingNodeId) { setEditingNodeId(null); return; }
    const node = effectiveGraph.nodes.find(n => n.id === editingNodeId);
    if (node) await onUpdateProcedure(node.procId, { name: editName });
    setEditingNodeId(null);
    notify("절차 이름이 수정되었습니다.");
  };

  const WIDGET_H = 400;
  const panelOpen = !!selectedProcId;

  // 노드 바운딩박스 기준으로 pan/zoom을 계산해 화면 중앙에 맞춤
  const fitView = useCallback(() => {
    const nodes = effectiveGraph.nodes;
    if (nodes.length === 0) { setZoom(0.85); setPan({ x: 40, y: 40 }); return; }

    const canvasEl = containerRef.current;
    if (!canvasEl) { setZoom(0.85); setPan({ x: 40, y: 40 }); return; }

    const canvasW = canvasEl.clientWidth - (panelOpen ? panelW : 0);
    const canvasH = WIDGET_H;
    const PADDING = 40;

    const minX = Math.min(...nodes.map(n => n.x));
    const minY = Math.min(...nodes.map(n => n.y));
    const maxX = Math.max(...nodes.map(n => n.x + NODE_W));
    const maxY = Math.max(...nodes.map(n => n.y + NODE_H));
    const contentW = maxX - minX;
    const contentH = maxY - minY;

    const scaleX = (canvasW - PADDING * 2) / contentW;
    const scaleY = (canvasH - PADDING * 2) / contentH;
    const newZoom = Math.min(Math.max(Math.min(scaleX, scaleY), 0.3), 1.2);

    // 콘텐츠 중앙을 캔버스 중앙에 맞추는 pan 계산
    const newPanX = (canvasW - contentW * newZoom) / 2 - minX * newZoom;
    const newPanY = (canvasH - contentH * newZoom) / 2 - minY * newZoom;

    setZoom(newZoom);
    setPan({ x: newPanX, y: newPanY });
  }, [effectiveGraph.nodes, panelOpen, panelW]);

  // 최초 마운트 & 노드 변경 시 자동 fitView
  useEffect(() => {
    const timer = setTimeout(fitView, 50);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveGraph.nodes.length]);

  // non-passive wheel 이벤트 (React onWheel은 passive라 preventDefault 불가)
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const handler = (e) => {
      e.preventDefault();
      setZoom(z => Math.max(0.3, Math.min(2, z * (e.deltaY > 0 ? 0.92 : 1.09))));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, marginBottom: 18, overflow: "hidden" }}>
      {/* 헤더 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 18px", borderBottom: `1px solid ${T.border}` }}>
        <h3 style={{ color: T.text, fontSize: 13, fontWeight: 700 }}>📍 프로젝트 흐름</h3>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => {
            // 자동 정렬: 위상 정렬 기반 계층 배치
            const nodes = effectiveGraph.nodes;
            const edges = effectiveGraph.edges;
            if (nodes.length === 0) return;
            const inDeg = Object.fromEntries(nodes.map(n => [n.id, 0]));
            edges.forEach(e => { if (inDeg[e.to] !== undefined) inDeg[e.to]++; });
            const adj = Object.fromEntries(nodes.map(n => [n.id, []]));
            edges.forEach(e => { if (adj[e.from]) adj[e.from].push(e.to); });
            const layers = {};
            nodes.filter(n => inDeg[n.id] === 0).forEach(n => { layers[n.id] = 0; });
            const q = nodes.filter(n => inDeg[n.id] === 0).map(n => n.id);
            const vis = new Set();
            let qi = [...q];
            while (qi.length > 0) {
              const cur = qi.shift();
              if (vis.has(cur)) continue;
              vis.add(cur);
              (adj[cur] || []).forEach(next => { layers[next] = Math.max(layers[next] || 0, (layers[cur] || 0) + 1); qi.push(next); });
            }
            nodes.forEach(n => { if (layers[n.id] === undefined) layers[n.id] = 0; });
            const layerGroups = {};
            nodes.forEach(n => { const l = layers[n.id] || 0; if (!layerGroups[l]) layerGroups[l] = []; layerGroups[l].push(n.id); });
            const NODE_W2 = 120, NODE_H2 = 50;
            const newNodes = nodes.map(n => {
              const layer = layers[n.id] || 0;
              const group = layerGroups[layer] || [n.id];
              const pos = group.indexOf(n.id);
              return { ...n, x: 40 + layer * (NODE_W2 + 60), y: 60 + pos * (NODE_H2 + 30) - ((group.length - 1) * (NODE_H2 + 30)) / 2 + 150 };
            });
            setLocalNodes(newNodes);
            // 정렬 후 중앙 맞춤 — newNodes로 직접 계산 (state 업데이트 대기 불필요)
            const canvasEl = containerRef.current;
            if (canvasEl && newNodes.length > 0) {
              const cW = canvasEl.clientWidth - (panelOpen ? panelW : 0);
              const cH = WIDGET_H;
              const PADDING = 40;
              const minX = Math.min(...newNodes.map(n => n.x));
              const minY = Math.min(...newNodes.map(n => n.y));
              const maxX = Math.max(...newNodes.map(n => n.x + NODE_W2));
              const maxY = Math.max(...newNodes.map(n => n.y + NODE_H2));
              const scaleX = (cW - PADDING * 2) / (maxX - minX || 1);
              const scaleY = (cH - PADDING * 2) / (maxY - minY || 1);
              const nz = Math.min(Math.max(Math.min(scaleX, scaleY), 0.3), 1.2);
              setZoom(nz);
              setPan({ x: (cW - (maxX - minX) * nz) / 2 - minX * nz, y: (cH - (maxY - minY) * nz) / 2 - minY * nz });
            }
          }} style={{ padding: "4px 10px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 6, color: T.textSub, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>⚡ 정렬</button>
          <button onClick={() => setZoom(z => Math.min(2, z * 1.2))} style={{ width: 26, height: 26, background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 6, color: T.textSub, fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
          <button onClick={() => setZoom(z => Math.max(0.3, z * 0.85))} style={{ width: 26, height: 26, background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 6, color: T.textSub, fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
          <button onClick={fitView} title="화면 맞춤" style={{ width: 26, height: 26, background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 6, color: T.textSub, fontSize: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>⊙</button>
          {panelOpen && (
            <button onClick={() => setSelectedProcId(null)} style={{ padding: "4px 10px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 6, color: T.textSub, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>패널 닫기 ×</button>
          )}
        </div>
      </div>

      {/* 본문: 캔버스 + 슬라이드 패널 */}
      <div ref={containerRef} style={{ display: "flex", height: WIDGET_H, position: "relative", overflow: "hidden" }}>

        {/* SVG 캔버스 */}
        <div style={{ flex: 1, position: "relative", overflow: "hidden", cursor: isPanning.current ? "grabbing" : "default" }}>
          {/* 격자 */}
          <svg width="100%" height="100%" style={{ position:"absolute", inset:0, pointerEvents:"none" }}>
            <defs>
              <pattern id="dgrid" width={20*zoom} height={20*zoom} patternUnits="userSpaceOnUse" x={pan.x%(20*zoom)} y={pan.y%(20*zoom)}>
                <path d={`M${20*zoom} 0 L0 0 0 ${20*zoom}`} fill="none" stroke={T.border} strokeWidth="0.4" opacity="0.6" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#dgrid)" />
          </svg>

          <svg ref={svgRef} width="100%" height="100%"
            style={{ display:"block", touchAction:"none", userSelect:"none" }}
            onPointerDown={onSVGDown} onPointerMove={onSVGMove} onPointerUp={onSVGUp} onPointerLeave={onSVGUp}>

            <defs>
              <marker id="darr" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto">
                <path d="M0,0 L0,6 L7,3 z" fill={T.textMuted} />
              </marker>
              <marker id="darr-sel" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto">
                <path d="M0,0 L0,6 L7,3 z" fill={T.danger} />
              </marker>
            </defs>

            <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
              {/* 엣지 */}
              {effectiveGraph.edges.map(edge => {
                const fn = effectiveGraph.nodes.find(n => n.id === edge.from);
                const tn = effectiveGraph.nodes.find(n => n.id === edge.to);
                if (!fn || !tn) return null;
                const fx = isDraggingNode.current?.nodeId === fn.id ? isDraggingNode.current.curX : fn.x;
                const fy = isDraggingNode.current?.nodeId === fn.id ? isDraggingNode.current.curY : fn.y;
                const tx = isDraggingNode.current?.nodeId === tn.id ? isDraggingNode.current.curX : tn.x;
                const ty = isDraggingNode.current?.nodeId === tn.id ? isDraggingNode.current.curY : tn.y;
                const p1 = getPortPos({ ...fn, x:fx, y:fy }, "out");
                const p2 = getPortPos({ ...tn, x:tx, y:ty }, "in");
                const mx = (p1.x + p2.x) / 2;
                const my = (p1.y + p2.y) / 2;
                const isEdgeSel = selectedEdgeId === edge.id;
                return (
                  <g key={edge.id}>
                    {/* 투명 히트영역 — 클릭으로 선택 */}
                    <path d={edgePath(p1.x,p1.y,p2.x,p2.y)} fill="none" stroke="transparent" strokeWidth={14} style={{ cursor:"pointer" }}
                      onClick={e => { e.stopPropagation(); setSelectedEdgeId(isEdgeSel ? null : edge.id); setSelectedProcId(null); setConnectFrom(null); }} />
                    <path d={edgePath(p1.x,p1.y,p2.x,p2.y)} fill="none"
                      stroke={isEdgeSel ? T.danger : T.textMuted}
                      strokeWidth={isEdgeSel ? 2.2 : 1.6}
                      strokeDasharray={isEdgeSel ? "6,3" : "none"}
                      markerEnd={isEdgeSel ? "url(#darr-sel)" : "url(#darr)"}
                      style={{ pointerEvents:"none" }} />
                    {/* 선택된 엣지에만 삭제 버튼 표시 */}
                    {isEdgeSel && (
                      <g onClick={e => { e.stopPropagation(); if (onUpdateFlowGraph) { const newG = { nodes: effectiveGraph.nodes, edges: effectiveGraph.edges.filter(ed => ed.id !== edge.id) }; updateGraph(newG); setSelectedEdgeId(null); } }} style={{ cursor:"pointer" }}>
                        <circle cx={mx} cy={my} r={10} fill={T.danger} />
                        <text x={mx} y={my+1} textAnchor="middle" dominantBaseline="middle" fill="#fff" fontSize={12} fontWeight={700} style={{ userSelect:"none" }}>✕</text>
                      </g>
                    )}
                  </g>
                );
              })}

              {/* 노드 */}
              {effectiveGraph.nodes.map(node => {
                const proc = procs.find(p => p.id === node.procId);
                if (!proc) return null;
                const nx = isDraggingNode.current?.nodeId === node.id ? isDraggingNode.current.curX : node.x;
                const ny = isDraggingNode.current?.nodeId === node.id ? isDraggingNode.current.curY : node.y;
                const isSel  = selectedProcId === proc.id;
                const isFrom = connectFrom === node.id;
                const color  = proc.color || T.accent;
                const tasks  = proc.tasks || [];
                const doneT  = tasks.filter(t => t.status === "done").length;
                const pct2   = tasks.length ? Math.round(doneT / tasks.length * 100) : 0;

                return (
                  <g key={node.id}
                    onPointerDown={e => onNodeDown(e, node.id)}
                    onClick={e => onNodeClick(e, node)}
                    style={{ cursor: connectFrom ? (connectFrom === node.id ? "not-allowed" : "crosshair") : "pointer" }}>

                    {/* 선택 후광 */}
                    {isSel && <rect x={nx-4} y={ny-4} width={NODE_W+8} height={NODE_H+8} rx={13} fill={`${color}22`} stroke={color} strokeWidth={2} />}

                    {/* 노드 배경 */}
                    <rect x={nx} y={ny} width={NODE_W} height={NODE_H} rx={10}
                      fill={isSel ? `${color}12` : T.surface}
                      stroke={isSel ? color : T.border2}
                      strokeWidth={isSel ? 2 : 1.5}
                    />

                    {/* 완료율 바 (하단) */}
                    {tasks.length > 0 && (
                      <>
                        <rect x={nx} y={ny+NODE_H-5} width={NODE_W} height={5} rx={0}
                          fill={T.border} style={{ borderRadius:"0 0 10px 10px" }} />
                        <rect x={nx} y={ny+NODE_H-5} width={NODE_W * pct2/100} height={5}
                          fill={pct2===100 ? T.success : color} opacity={0.8} />
                      </>
                    )}

                    {/* 아이콘 + 이름 */}
                    <text x={nx+10} y={ny+NODE_H/2-4} fontSize={14} dominantBaseline="middle" style={{ pointerEvents:"none", userSelect:"none" }}>{proc.icon}</text>
                    {editingNodeId === node.id ? (
                      <foreignObject x={nx+28} y={ny+8} width={NODE_W-36} height={20}>
                        <input autoFocus value={editName}
                          onChange={e => setEditName(e.target.value)}
                          onBlur={saveEdit}
                          onKeyDown={e => e.key==="Enter" && saveEdit()}
                          style={{ width:"100%", fontSize:11, fontWeight:700, color:T.text, background:"transparent", border:"none", borderBottom:`1px solid ${T.accent}`, outline:"none", fontFamily:"inherit" }} />
                      </foreignObject>
                    ) : (
                      <text x={nx+28} y={ny+NODE_H/2-4} fontSize={11} fontWeight={700}
                        fill={isSel ? color : T.text} dominantBaseline="middle"
                        style={{ pointerEvents:"none", userSelect:"none" }}>
                        {proc.name.length > 7 ? proc.name.slice(0,7)+"…" : proc.name}
                      </text>
                    )}
                    {/* 작업 수 */}
                    <text x={nx+28} y={ny+NODE_H/2+10} fontSize={8.5} fill={T.textMuted}
                      style={{ pointerEvents:"none", userSelect:"none" }}>
                      {doneT}/{tasks.length} · {pct2}%
                    </text>

                    {/* 이름 편집 버튼 (선택 시) */}
                    {isSel && !connectFrom && (
                      <g onClick={e => { e.stopPropagation(); setEditingNodeId(node.id); setEditName(proc.name); }}
                        style={{ cursor:"pointer" }}>
                        <circle cx={nx+NODE_W-16} cy={ny+12} r={8} fill={`${T.accent}22`} stroke={T.accent} strokeWidth={1} />
                        <text x={nx+NODE_W-16} y={ny+12} textAnchor="middle" dominantBaseline="middle" fontSize={9} fill={T.accent} style={{ userSelect:"none" }}>✏</text>
                      </g>
                    )}

                    {/* 연결 버튼 (선택 시) — 클릭하면 연결 모드 시작 */}
                    {isSel && !connectFrom && (
                      <g onClick={e => { e.stopPropagation(); setConnectFrom(node.id); setSelectedProcId(null); }} style={{ cursor:"crosshair" }}>
                        <circle cx={nx + NODE_W} cy={ny + NODE_H/2} r={11} fill={T.accent} opacity={0.9} />
                        <text x={nx + NODE_W} y={ny + NODE_H/2 + 1} textAnchor="middle" dominantBaseline="middle" fill="#fff" fontSize={12} fontWeight={700} style={{ userSelect:"none", pointerEvents:"none" }}>→</text>
                      </g>
                    )}

                    {/* 연결 대기 글로우 */}
                    {isFrom && <rect x={nx-4} y={ny-4} width={NODE_W+8} height={NODE_H+8} rx={13} fill="none" stroke={T.accent} strokeWidth={2} strokeDasharray="6,3" opacity={0.8} />}
                  </g>
                );
              })}
            </g>
          </svg>

          {/* 줌 표시 */}
          <div style={{ position:"absolute", bottom:8, left:10, fontSize:10, color:T.textMuted, background:T.surface, padding:"2px 7px", borderRadius:5, border:`1px solid ${T.border}`, pointerEvents:"none" }}>
            {Math.round(zoom*100)}% · 클릭으로 절차 선택
          </div>
        </div>

        {/* ── 노션 스타일 슬라이드 패널 ── */}
        <div style={{
          width: panelOpen ? panelW : 0,
          minWidth: 0,
          overflow: "hidden",
          transition: isResizing ? "none" : "width 0.28s cubic-bezier(.4,0,.2,1)",
          borderLeft: panelOpen ? `1px solid ${T.border}` : "none",
          position: "relative",
          background: T.surface,
          display: "flex",
          flexDirection: "column",
        }}>
          {/* 리사이저 핸들 */}
          {panelOpen && (
            <div onMouseDown={onResizerDown}
              style={{ position:"absolute", left:0, top:0, bottom:0, width:5, cursor:"col-resize", zIndex:10, background:"transparent",
                borderLeft: isResizing ? `2px solid ${T.accent}` : `2px solid transparent`,
                transition: "border-color .15s" }}
              onMouseEnter={e => e.currentTarget.style.borderLeftColor = T.accent}
              onMouseLeave={e => { if (!isResizing) e.currentTarget.style.borderLeftColor = "transparent"; }}
            />
          )}

          {panelOpen && selectedProc && (
            <div style={{ flex:1, overflowY:"auto", padding:"18px 16px 18px 20px", minWidth: 180 }}>
              {/* 패널 헤더 */}
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:16 }}>
                <span style={{ fontSize:20 }}>{selectedProc.icon}</span>
                <div style={{ flex:1 }}>
                  <h3 style={{ color:T.text, fontSize:14, fontWeight:800, marginBottom:2 }}>{selectedProc.name}</h3>
                  <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                    <span style={{ fontSize:10, padding:"1px 7px", borderRadius:100, background:`${T.accent}15`, color:T.accent, fontWeight:700 }}>
                      {selectedProcTasks.filter(t=>t.status==="done").length}/{selectedProcTasks.length} 완료
                    </span>
                    {selectedProcTasks.length > 0 && (
                      <span style={{ fontSize:10, padding:"1px 7px", borderRadius:100, background:`${T.success}12`, color:T.success, fontWeight:700 }}>
                        {Math.round(selectedProcTasks.filter(t=>t.status==="done").length/selectedProcTasks.length*100)}%
                      </span>
                    )}
                  </div>
                </div>
                <button onClick={() => setSelectedProcId(null)}
                  style={{ width:24, height:24, borderRadius:6, background:T.surfaceHover, border:`1px solid ${T.border2}`, color:T.textSub, fontSize:13, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>×</button>
              </div>

              {/* 진행 바 */}
              {selectedProcTasks.length > 0 && (
                <div style={{ marginBottom:16 }}>
                  <div style={{ background:T.border, borderRadius:100, height:4, overflow:"hidden" }}>
                    <div style={{ width:`${Math.round(selectedProcTasks.filter(t=>t.status==="done").length/selectedProcTasks.length*100)}%`, height:"100%", background:`linear-gradient(90deg,${T.accent},${T.accentSub})`, borderRadius:100, transition:"width .5s" }} />
                  </div>
                </div>
              )}

              {/* 상태별 작업 */}
              {["todo","doing","done"].map(status => {
                const statusTasks = selectedProcTasks.filter(t => t.status === status);
                if (statusTasks.length === 0) return null;
                return (
                  <div key={status} style={{ marginBottom:14 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:5, marginBottom:7 }}>
                      <div style={{ width:6, height:6, borderRadius:"50%", background:SC[status] }} />
                      <span style={{ color:T.textSub, fontSize:10, fontWeight:700 }}>{ST[status]}</span>
                      <span style={{ color:T.textMuted, fontSize:10 }}>({statusTasks.length})</span>
                    </div>
                    <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
                      {statusTasks.map(task => {
                        const member = project.members.find(m => m.id === task.memberId);
                        const isOverdue = task.deadline && task.status !== "done" && task.deadline < new Date().toISOString().slice(0,10);
                        const cycle = { todo:"doing", doing:"done", done:"todo" };
                        return (
                          <div key={task.id} style={{ padding:"9px 11px", background:T.surfaceHover, border:`1px solid ${task.status==="doing" ? T.warn+"55" : task.status==="done" ? T.success+"44" : T.border}`, borderRadius:9 }}>
                            <div style={{ display:"flex", alignItems:"flex-start", gap:7 }}>
                              {/* 상태 토글 버튼 */}
                              <button onClick={() => onTaskChange(selectedProcId, task.id, { status: cycle[task.status] })}
                                style={{ width:14, height:14, borderRadius:4, border:`1.5px solid ${SC[task.status]}`, background:task.status==="done" ? SC[task.status] : "transparent", cursor:"pointer", flexShrink:0, marginTop:2, display:"flex", alignItems:"center", justifyContent:"center" }}>
                                {task.status==="done" && <SVG d={I.check} size={8} style={{ color:"#fff" }} />}
                              </button>
                              <div style={{ flex:1, minWidth:0 }}>
                                <p style={{ color:task.status==="done" ? T.textMuted : T.text, fontSize:11, fontWeight:600, lineHeight:1.4, textDecoration:task.status==="done"?"line-through":"none", marginBottom:3 }}>{task.title}</p>
                                <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
                                  {member && <span style={{ fontSize:9, padding:"1px 5px", borderRadius:100, background:`${T.accent}12`, color:T.accent, fontWeight:600 }}>👤 {member.name}</span>}
                                  {task.deadline && <span style={{ fontSize:9, padding:"1px 5px", borderRadius:100, background:isOverdue?`${T.danger}12`:`${T.warn}10`, color:isOverdue?T.danger:T.warn, fontWeight:600 }}>📅 {task.deadline}</span>}
                                  {(task.files||[]).length>0 && <span style={{ fontSize:9, color:T.textMuted }}>📎 {task.files.length}</span>}
                                  {(task.comments||[]).length>0 && <span style={{ fontSize:9, color:T.textMuted }}>💬 {task.comments.length}</span>}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {selectedProcTasks.length === 0 && (
                <div style={{ textAlign:"center", padding:"24px 0", color:T.textMuted, fontSize:12 }}>
                  <div style={{ fontSize:24, marginBottom:8 }}>📭</div>
                  작업이 없습니다
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── TASKS TAB (칸반 + 상세모달, 피드백 3) ───────────────────────────────────
function TasksTab({ T, project, loginName, onTaskChange, onAddTask, onDeleteTask, onAddProcedure, onUpdateProcedure, onDeleteProcedure, onFileUpload, notify }) {
  const [expanded, setExpanded]         = useState({});
  const [editingPId, setEditingPId]     = useState(null);
  const [editPName, setEditPName]       = useState("");
  const [confirmDelId, setConfirmDelId] = useState(null);
  const [addingTaskId, setAddingTaskId] = useState(null); // 작업 추가 모달용 procId
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskMember, setNewTaskMember] = useState(""); // 담당자
  const [selectedTask, setSelectedTask] = useState(null);
  const [filterMember, setFilterMember] = useState("");
  const [filterStatus, setFilterStatus] = useState("");

  const savePName = async id => {
    if (!editPName.trim()) { setEditingPId(null); return; }
    await onUpdateProcedure(id, { name: editPName }); setEditingPId(null); notify("수정되었습니다.");
  };

  // 필터링된 태스크
  const getFilteredTasks = (tasks) => tasks.filter(t => {
    if (filterMember && t.memberId !== filterMember) return false;
    if (filterStatus && t.status !== filterStatus) return false;
    return true;
  });

  return (
    <div>
      {/* 작업 상세 모달 */}
      {selectedTask && (
        <TaskDetailModal T={T} task={selectedTask.task} members={project.members}
          loginName={loginName}
          onClose={() => setSelectedTask(null)}
          onChange={ch => { onTaskChange(selectedTask.procId, selectedTask.task.id, ch); setSelectedTask(prev => ({ ...prev, task: { ...prev.task, ...ch } })); }}
          onFileUpload={files => onFileUpload(selectedTask.procId, selectedTask.task, files).then(newFiles => setSelectedTask(prev => ({ ...prev, task: { ...prev.task, files: newFiles } })))} />
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ color: T.text, fontSize: 24, fontWeight: 800, marginBottom: 4 }}>작업 관리</h1>
          <p style={{ color: T.textSub, fontSize: 13 }}>절차별 세부 작업을 관리하세요</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {/* 담당자 필터 */}
          <select value={filterMember} onChange={e => setFilterMember(e.target.value)}
            style={{ padding: "7px 11px", background: T.surfaceHover, border: `1px solid ${filterMember ? T.accent : T.border2}`, borderRadius: 8, color: filterMember ? T.accent : T.textSub, fontSize: 12, outline: "none", fontFamily: "inherit" }}>
            <option value="">👤 전체 담당자</option>
            {project.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          {/* 상태 필터 */}
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
            style={{ padding: "7px 11px", background: T.surfaceHover, border: `1px solid ${filterStatus ? T.accent : T.border2}`, borderRadius: 8, color: filterStatus ? T.accent : T.textSub, fontSize: 12, outline: "none", fontFamily: "inherit" }}>
            <option value="">📊 전체 상태</option>
            {Object.entries(ST).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button onClick={() => onAddProcedure("새 단계")} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 8, color: T.textSub, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
            <SVG d={I.plus} size={12} /> 단계 추가
          </button>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
        {project.procedures.map(proc => {
          const isOpen = expanded[proc.id] !== false;
          const filteredTasks = getFilteredTasks(proc.tasks);
          const doneC = proc.tasks.filter(t => t.status === "done").length;
          const procPct = proc.tasks.length ? Math.round(doneC / proc.tasks.length * 100) : 0;

          return (
            <div key={proc.id} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 13, overflow: "hidden" }}>
              {/* 절차 헤더 */}
              <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "13px 16px", borderBottom: isOpen ? `1px solid ${T.border}` : "none", background: T.surface }}>
                <div onClick={() => setExpanded(e => ({ ...e, [proc.id]: !isOpen }))} style={{ cursor: "pointer", color: T.textMuted }}>
                  <SVG d={isOpen ? I.chevD : I.chevR} size={12} />
                </div>
                <span style={{ fontSize: 15 }}>{proc.icon}</span>
                {editingPId === proc.id ? (
                  <input autoFocus value={editPName} onChange={e => setEditPName(e.target.value)} onBlur={() => savePName(proc.id)} onKeyDown={e => e.key === "Enter" && savePName(proc.id)}
                    style={{ flex: 1, background: "transparent", border: "none", borderBottom: `1px solid ${T.accent}`, color: T.text, fontSize: 13, fontWeight: 700, outline: "none", fontFamily: "inherit" }} />
                ) : (
                  <span onClick={() => setExpanded(e => ({ ...e, [proc.id]: !isOpen }))} style={{ flex: 1, color: T.text, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>{proc.name}</span>
                )}
                {/* 미니 진행바 */}
                <div style={{ width: 60, background: T.border, borderRadius: 100, height: 4 }}>
                  <div style={{ width: `${procPct}%`, height: "100%", background: procPct === 100 ? T.success : T.accent, borderRadius: 100 }} />
                </div>
                <span style={{ color: T.textMuted, fontSize: 11, minWidth: 32, textAlign: "right" }}>{doneC}/{proc.tasks.length}</span>
                <button onClick={() => { setEditingPId(proc.id); setEditPName(proc.name); }} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 3 }} onMouseEnter={e => e.currentTarget.style.color = T.accent} onMouseLeave={e => e.currentTarget.style.color = T.textMuted}><SVG d={I.edit} size={12} /></button>
                {confirmDelId === proc.id ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <button onClick={() => { onDeleteProcedure(proc.id); setConfirmDelId(null); }} style={{ padding: "2px 8px", background: T.danger, border: "none", borderRadius: 5, color: "#fff", fontSize: 10, cursor: "pointer", fontFamily: "inherit" }}>삭제</button>
                    <button onClick={() => setConfirmDelId(null)} style={{ padding: "2px 7px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 5, color: T.textSub, fontSize: 10, cursor: "pointer", fontFamily: "inherit" }}>취소</button>
                  </span>
                ) : (
                  <button onClick={() => setConfirmDelId(proc.id)} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 3 }} onMouseEnter={e => e.currentTarget.style.color = T.danger} onMouseLeave={e => e.currentTarget.style.color = T.textMuted}><SVG d={I.trash} size={12} /></button>
                )}
              </div>

              {/* 작업 목록 - 칸반 스타일 */}
              {isOpen && (
                <div style={{ padding: "10px 14px 13px" }}>
                  {filteredTasks.length === 0 && (filterMember || filterStatus)
                    ? <p style={{ color: T.textMuted, fontSize: 12, padding: "6px 2px" }}>필터 조건에 맞는 작업이 없습니다.</p>
                    : filteredTasks.length === 0
                    ? <p style={{ color: T.textMuted, fontSize: 12, padding: "6px 2px" }}>작업이 없습니다.</p>
                    : null}

                  {/* 상태별 그룹 */}
                  {filteredTasks.length > 0 && (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                      {["todo","doing","done"].map(status => {
                        const statusTasks = filteredTasks.filter(t => t.status === status);
                        return (
                          <div key={status}>
                            <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 6 }}>
                              <div style={{ width: 6, height: 6, borderRadius: "50%", background: SC[status] }} />
                              <span style={{ color: T.textSub, fontSize: 10, fontWeight: 700 }}>{ST[status]}</span>
                              <span style={{ color: T.textMuted, fontSize: 10 }}>({statusTasks.length})</span>
                            </div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                              {statusTasks.map(task => (
                                <TaskCard key={task.id} T={T} task={task} members={project.members}
                                  onClick={() => setSelectedTask({ task, procId: proc.id })}
                                  onChange={ch => onTaskChange(proc.id, task.id, ch)}
                                  onDelete={() => onDeleteTask(proc.id, task.id)} />
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* 작업 추가 */}
                  {addingTaskId === proc.id ? (
                    <div style={{ marginTop:9, background:T.surfaceHover, borderRadius:10, border:`1px solid ${T.accent}44`, padding:"12px 14px", display:"flex", flexDirection:"column", gap:8 }}>
                      <input autoFocus value={newTaskTitle} onChange={e=>setNewTaskTitle(e.target.value)}
                        onKeyDown={e=>{ if(e.key==="Enter"&&!e.nativeEvent.isComposing){ if(newTaskTitle.trim()){ onAddTask(proc.id, newTaskTitle, newTaskMember||null); } setAddingTaskId(null); setNewTaskTitle(""); setNewTaskMember(""); } if(e.key==="Escape"){ setAddingTaskId(null); setNewTaskTitle(""); setNewTaskMember(""); } }}
                        placeholder="작업 이름 입력"
                        style={{ padding:"7px 10px", background:T.surface, border:`1px solid ${T.accent}`, borderRadius:7, color:T.text, fontSize:12, outline:"none", fontFamily:"inherit" }} />
                      <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                        <select value={newTaskMember} onChange={e=>setNewTaskMember(e.target.value)}
                          style={{ flex:1, padding:"5px 8px", background:T.surface, border:`1px solid ${T.border2}`, borderRadius:7, color:T.text, fontSize:11, outline:"none", fontFamily:"inherit" }}>
                          <option value="">👤 담당자 없음</option>
                          {project.members.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}
                        </select>
                        <button onClick={()=>{ if(newTaskTitle.trim()){ onAddTask(proc.id, newTaskTitle, newTaskMember||null); } setAddingTaskId(null); setNewTaskTitle(""); setNewTaskMember(""); }}
                          style={{ padding:"6px 14px", background:T.accent, border:"none", borderRadius:7, color:"#fff", fontSize:12, cursor:"pointer", fontFamily:"inherit", fontWeight:700 }}>추가</button>
                        <button onClick={()=>{ setAddingTaskId(null); setNewTaskTitle(""); setNewTaskMember(""); }}
                          style={{ padding:"6px 10px", background:T.surfaceHover, border:`1px solid ${T.border2}`, borderRadius:7, color:T.textSub, fontSize:12, cursor:"pointer", fontFamily:"inherit" }}>취소</button>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => { setAddingTaskId(proc.id); setNewTaskTitle(""); setNewTaskMember(""); }} style={{ marginTop: 9, display: "flex", alignItems: "center", gap: 5, color: T.textMuted, fontSize: 11, background: "none", border: "none", cursor: "pointer", padding: "4px 0", fontFamily: "inherit" }}>
                      <SVG d={I.plus} size={11} /> 작업 추가
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── TASK CARD (칸반용) ───────────────────────────────────────────────────────
function TaskCard({ T, task, members, onClick, onChange, onDelete }) {
  const fCount = (task.files || []).length;
  const cCount = (task.comments || []).length;
  const isOverdue = task.deadline && task.status !== "done" && new Date(task.deadline) < new Date();

  return (
    <div onClick={onClick} style={{ background: T.surface, border: `1px solid ${task.status === "doing" ? T.warn + "55" : task.status === "done" ? T.success + "44" : T.border}`, borderRadius: 9, padding: "10px 11px", cursor: "pointer", transition: "all .15s" }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.boxShadow = `0 0 0 2px ${T.accent}22`; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = task.status === "doing" ? T.warn + "55" : task.status === "done" ? T.success + "44" : T.border; e.currentTarget.style.boxShadow = "none"; }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 7, marginBottom: 7 }}>
        <button onClick={e => { e.stopPropagation(); const cycle = { todo: "doing", doing: "done", done: "todo" }; onChange({ status: cycle[task.status] }); }}
          style={{ width: 14, height: 14, borderRadius: 4, flexShrink: 0, cursor: "pointer", border: `1.5px solid ${SC[task.status]}`, background: task.status === "done" ? SC[task.status] : "transparent", display: "flex", alignItems: "center", justifyContent: "center", marginTop: 2 }}>
          {task.status === "done" && <SVG d={I.check} size={8} style={{ color: "#fff" }} />}
        </button>
        <span style={{ flex: 1, color: task.status === "done" ? T.textMuted : T.text, fontSize: 11, fontWeight: 600, lineHeight: 1.4, textDecoration: task.status === "done" ? "line-through" : "none" }}>{task.title}</span>
        <button onClick={e => { e.stopPropagation(); onDelete(); }} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 1, flexShrink: 0 }} onMouseEnter={e => { e.stopPropagation(); e.currentTarget.style.color = T.danger; }} onMouseLeave={e => e.currentTarget.style.color = T.textMuted}><SVG d={I.trash} size={10} /></button>
      </div>
      {/* 메타 행 */}
      <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
        {task.memberId && (
          <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 100, background: `${T.accent}15`, color: T.accent, fontWeight: 600 }}>
            {members.find(m => m.id === task.memberId)?.name || "미할당"}
          </span>
        )}
        {task.deadline && (
          <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 100, background: isOverdue ? `${T.danger}15` : `${T.warn}12`, color: isOverdue ? T.danger : T.warn, fontWeight: 600 }}>
            📅 {task.deadline}
          </span>
        )}
        {fCount > 0 && <span style={{ fontSize: 9, color: T.textMuted }}>📎 {fCount}</span>}
        {cCount > 0 && <span style={{ fontSize: 9, color: T.textMuted }}>💬 {cCount}</span>}
      </div>
    </div>
  );
}

// ─── GANTT TAB (작업별 데드라인 + 줌인/아웃 + 사람 필터, 피드백 4·5) ─────────
// ─── GANTT TAB (시작일+마감일 바, 시간 지원, 반응형, 줌/필터) ────────────────
// ─── CALENDAR TAB (노션 스타일) ───────────────────────────────────────────────
function CalendarTab({ T, project, onTaskChange, isOwner = false }) {
  const today = new Date();
  const [viewYear,  setViewYear]  = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth()); // 0-11
  const [selectedDay, setSelectedDay] = useState(null);
  const [detailTask,  setDetailTask]  = useState(null);

  const allTasks = project.procedures.flatMap(proc =>
    proc.tasks.map(t => ({ ...t, procName: proc.name, procIcon: proc.icon, procId: proc.id, procColor: proc.color || "#6366f1" }))
  );

  // 날짜별 작업 맵 (deadline 기준)
  const tasksByDate = {};
  allTasks.forEach(t => {
    if (t.deadline) {
      const key = t.deadline.slice(0, 10);
      if (!tasksByDate[key]) tasksByDate[key] = [];
      tasksByDate[key].push(t);
    }
    if (t.startDate && t.startDate !== t.deadline) {
      const key = t.startDate.slice(0, 10);
      if (!tasksByDate[key]) tasksByDate[key] = [];
      tasksByDate[key].push({ ...t, _isStart: true });
    }
  });

  const firstDay = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const todayStr = today.toISOString().slice(0, 10);

  const prevMonth = () => { if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); } else setViewMonth(m => m - 1); };
  const nextMonth = () => { if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); } else setViewMonth(m => m + 1); };

  const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
  const SC = { todo: "#94a3b8", doing: "#f59e0b", done: "#10b981" };

  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const selKey = selectedDay ? `${viewYear}-${String(viewMonth+1).padStart(2,"0")}-${String(selectedDay).padStart(2,"0")}` : null;
  const selTasks = selKey ? (tasksByDate[selKey] || []) : [];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ color: T.text, fontSize: 24, fontWeight: 800, marginBottom: 4 }}>🗓 캘린더</h1>
          <p style={{ color: T.textSub, fontSize: 13 }}>작업의 시작일·마감일을 한눈에 확인하세요</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={prevMonth} style={{ width: 32, height: 32, borderRadius: 8, background: T.surfaceHover, border: `1px solid ${T.border2}`, color: T.textSub, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>‹</button>
          <span style={{ color: T.text, fontSize: 16, fontWeight: 700, minWidth: 120, textAlign: "center" }}>{viewYear}년 {viewMonth + 1}월</span>
          <button onClick={nextMonth} style={{ width: 32, height: 32, borderRadius: 8, background: T.surfaceHover, border: `1px solid ${T.border2}`, color: T.textSub, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>›</button>
          <button onClick={() => { setViewYear(today.getFullYear()); setViewMonth(today.getMonth()); setSelectedDay(today.getDate()); }}
            style={{ padding: "6px 14px", background: `${T.accent}15`, border: `1px solid ${T.accent}44`, borderRadius: 8, color: T.accent, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>오늘</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 20 }}>
        {/* 캘린더 그리드 */}
        <div style={{ flex: 1, background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, overflow: "hidden" }}>
          {/* 요일 헤더 */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", borderBottom: `1px solid ${T.border}` }}>
            {WEEKDAYS.map((d, i) => (
              <div key={d} style={{ padding: "10px 0", textAlign: "center", fontSize: 12, fontWeight: 700, color: i === 0 ? "#ef4444" : i === 6 ? "#3b82f6" : T.textSub }}>
                {d}
              </div>
            ))}
          </div>
          {/* 날짜 셀 */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)" }}>
            {cells.map((d, i) => {
              if (!d) return <div key={`e${i}`} style={{ minHeight: 90, borderRight: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, background: T.surfaceHover + "44" }} />;
              const dayKey = `${viewYear}-${String(viewMonth+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
              const dayTasks = tasksByDate[dayKey] || [];
              const isToday = dayKey === todayStr;
              const isSel = selectedDay === d;
              const dow = (firstDay + d - 1) % 7;
              return (
                <div key={d} onClick={() => setSelectedDay(isSel ? null : d)}
                  style={{ minHeight: 90, borderRight: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, padding: "6px", cursor: "pointer", background: isSel ? `${T.accent}10` : isToday ? `${T.accent}06` : "transparent", transition: "background .1s" }}
                  onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = T.surfaceHover; }}
                  onMouseLeave={e => { e.currentTarget.style.background = isSel ? `${T.accent}10` : isToday ? `${T.accent}06` : "transparent"; }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{
                      width: 24, height: 24, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 12, fontWeight: isToday ? 800 : 500,
                      background: isToday ? T.accent : "transparent",
                      color: isToday ? "#fff" : dow === 0 ? "#ef4444" : dow === 6 ? "#3b82f6" : T.text,
                    }}>{d}</span>
                  </div>
                  {dayTasks.slice(0, 3).map((t, ti) => (
                    <div key={`${t.id}${ti}`} onClick={e => { e.stopPropagation(); setDetailTask(t); }}
                      style={{ fontSize: 9, padding: "2px 5px", borderRadius: 4, marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer",
                        background: t._isStart ? `${t.procColor}18` : t.status === "done" ? `${T.success}18` : `${t.procColor}22`,
                        color: t._isStart ? t.procColor : t.status === "done" ? T.success : t.procColor,
                        border: `1px solid ${t._isStart ? t.procColor : t.procColor}33`,
                        textDecoration: t.status === "done" ? "line-through" : "none",
                      }}>
                      {t._isStart ? "▶" : "■"} {t.title}
                    </div>
                  ))}
                  {dayTasks.length > 3 && <div style={{ fontSize: 9, color: T.textMuted, paddingLeft: 4 }}>+{dayTasks.length - 3}개</div>}
                </div>
              );
            })}
          </div>
        </div>

        {/* 우측 패널: 선택일 작업 목록 */}
        {selectedDay && (
          <div style={{ width: 260, flexShrink: 0, background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "16px", overflowY: "auto", maxHeight: "70vh" }}>
            <p style={{ color: T.text, fontSize: 14, fontWeight: 700, marginBottom: 12 }}>
              {viewMonth + 1}월 {selectedDay}일 · {selTasks.length}개
            </p>
            {selTasks.length === 0 ? (
              <p style={{ color: T.textMuted, fontSize: 12, textAlign: "center", marginTop: 24 }}>일정이 없습니다</p>
            ) : selTasks.map((t, i) => (
              <div key={`${t.id}${i}`} onClick={() => setDetailTask(t)}
                style={{ padding: "10px 12px", background: T.surface, border: `1px solid ${t._isStart ? t.procColor+"44" : t.procColor+"33"}`, borderRadius: 10, marginBottom: 8, cursor: "pointer" }}
                onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
                onMouseLeave={e => e.currentTarget.style.background = T.surface}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <span style={{ fontSize: 12 }}>{t.procIcon}</span>
                  <span style={{ color: T.textMuted, fontSize: 10 }}>{t.procName}</span>
                  <span style={{ marginLeft: "auto", fontSize: 9, padding: "1px 5px", borderRadius: 100, background: `${SC[t.status] || T.border}18`, color: SC[t.status] || T.textMuted, fontWeight: 700 }}>
                    {t._isStart ? "시작" : t.status === "todo" ? "미진행" : t.status === "doing" ? "진행중" : "완료"}
                  </span>
                </div>
                <p style={{ color: T.text, fontSize: 11, fontWeight: 600, textDecoration: t.status === "done" ? "line-through" : "none" }}>{t.title}</p>
                {(t.startTime || t.deadlineTime) && (
                  <p style={{ color: T.textMuted, fontSize: 9, marginTop: 3 }}>
                    {t._isStart && t.startTime ? `▶ ${t.startTime}` : ""}{!t._isStart && t.deadlineTime ? `■ ${t.deadlineTime}` : ""}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 작업 상세 모달 */}
      {detailTask && (
        <div onClick={() => setDetailTask(null)} style={{ position: "fixed", inset: 0, zIndex: 400, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div onClick={e => e.stopPropagation()} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, padding: 28, width: 380, boxShadow: "0 16px 60px rgba(0,0,0,.3)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
              <span style={{ fontSize: 18 }}>{detailTask.procIcon}</span>
              <span style={{ color: T.textMuted, fontSize: 12 }}>{detailTask.procName}</span>
              <button onClick={() => setDetailTask(null)} style={{ marginLeft: "auto", background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 18 }}>×</button>
            </div>
            <p style={{ color: T.text, fontSize: 16, fontWeight: 700, marginBottom: 16 }}>{detailTask.title}</p>
            {[
              ["시작일", detailTask.startDate ? `${detailTask.startDate.slice(0,10)}${detailTask.startTime ? " " + detailTask.startTime : ""}` : "-"],
              ["마감일", detailTask.deadline ? `${detailTask.deadline.slice(0,10)}${detailTask.deadlineTime ? " " + detailTask.deadlineTime : ""}` : "-"],
              ["상태", detailTask.status === "todo" ? "미진행" : detailTask.status === "doing" ? "진행중" : "완료"],
              ["담당자", project.members.find(m => m.id === detailTask.memberId)?.name || "미할당"],
            ].map(([k, v]) => (
              <div key={k} style={{ display: "flex", gap: 12, marginBottom: 10, paddingBottom: 10, borderBottom: `1px solid ${T.border}` }}>
                <span style={{ color: T.textMuted, fontSize: 11, fontWeight: 700, minWidth: 40 }}>{k}</span>
                <span style={{ color: T.text, fontSize: 12 }}>{v}</span>
              </div>
            ))}
            {isOwner && (
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                {["todo", "doing", "done"].map(s => (
                  <button key={s} onClick={() => { onTaskChange(detailTask.procId, detailTask.id, { status: s }); setDetailTask(prev => ({...prev, status: s})); }}
                    style={{ flex: 1, padding: "7px 0", background: detailTask.status === s ? `${SC[s]}18` : T.surfaceHover, border: `1px solid ${detailTask.status === s ? SC[s] : T.border2}`, borderRadius: 7, color: detailTask.status === s ? SC[s] : T.textMuted, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                    {s === "todo" ? "미진행" : s === "doing" ? "진행중" : "완료"}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function GanttTab({ T, project, onTaskChange, onAddTask, onUpdateProject, notify, isOwner = false, currentAccount }) {
  // 스케줄 수정 권한: 팀장 또는 DB에 저장된 ganttEditPerm이 true인 멤버
  const ganttEditPerm = project.ganttEditPerm || false;
  const canEdit = isOwner || ganttEditPerm;
  const today    = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  // 담당자별 색상 맵 (캘린더 + 간트 공용)
  const PASTEL_COLORS = ["#a5b4fc","#93c5fd","#6ee7b7","#fcd34d","#f9a8d4","#fca5a5","#c4b5fd","#fdba74","#86efac","#67e8f9"];
  const memberColorMap = {};
  project.members.forEach((m, idx) => { memberColorMap[m.id] = PASTEL_COLORS[idx % PASTEL_COLORS.length]; });
  const getMemberColor = (task) => task.memberId && memberColorMap[task.memberId] ? memberColorMap[task.memberId] : "#94a3b8";

  const allTasks = project.procedures.flatMap(proc =>
    proc.tasks.map(t => ({
      ...t, procName: proc.name, procIcon: proc.icon, procId: proc.id,
      procColor: proc.color || T.accent,
      memberColor: getMemberColor(t), // 담당자 색상 (캘린더용)
    }))
  );

  // 날짜 범위 계산
  const taskDates = allTasks.flatMap(t => [t.startDate, t.deadline].filter(Boolean).map(d => new Date(d.slice(0,10))));
  const minDate = (() => {
    if (project.startDate) return new Date(project.startDate);
    if (taskDates.length) return new Date(Math.min(...taskDates) - 3 * 86400000);
    return new Date(today.getFullYear(), today.getMonth(), 1);
  })();
  const maxDate = (() => {
    if (project.endDate) return new Date(project.endDate);
    if (taskDates.length) return new Date(Math.max(...taskDates) + 7 * 86400000);
    return new Date(today.getFullYear(), today.getMonth() + 2, 0);
  })();

  const totalDiff = Math.max(Math.ceil((maxDate - minDate) / 86400000), 14);
  const [zoomStart, setZoomStart] = useState(0);
  const [zoomDays,  setZoomDays]  = useState(Math.min(totalDiff, 60));
  const [filterMember, setFilterMember] = useState("");
  const [editingTask, setEditingTask]   = useState(null);
  const [showTime, setShowTime]         = useState({});
  const [timeInputs, setTimeInputs]     = useState({});
  const [ganttCollapsed, setGanttCollapsed] = useState(false); // 간트 접기/펼치기

  // 캘린더 상태
  const [calViewYear, setCalViewYear]   = useState(today.getFullYear());
  const [calViewMonth, setCalViewMonth] = useState(today.getMonth());
  const [calSelDay, setCalSelDay]       = useState(today.getDate());
  const [calDetailTask, setCalDetailTask] = useState(null);
  // 날짜 클릭 → 작업 추가 모달
  const [newTaskModal, setNewTaskModal] = useState(null); // { dateKey }
  const [ntTitle, setNtTitle]           = useState("");
  const [ntMemberId, setNtMemberId]     = useState("");
  const [ntProcId, setNtProcId]         = useState("");
  const [ntStartDate, setNtStartDate]   = useState("");
  const [ntEndDate, setNtEndDate]       = useState("");
  const [ntSaving, setNtSaving]         = useState(false);

  const viewStart = new Date(minDate); viewStart.setDate(viewStart.getDate() + zoomStart);
  const days      = Array.from({ length: zoomDays }, (_, i) => { const d = new Date(viewStart); d.setDate(d.getDate() + i); return d; });
  const containerRef = useRef(null);
  const ganttScrollRef = useRef(null);
  const [containerW, setContainerW] = useState(700);

  // non-passive wheel handler (containerRef div)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e) => {
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? Math.floor(zoomDays * 0.15) : -Math.floor(zoomDays * 0.15);
      setZoomStart(s => Math.max(0, Math.min(totalDiff - zoomDays, s + delta)));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomDays, totalDiff]);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(entries => { setContainerW(entries[0].contentRect.width - 200); });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // 캘린더 날짜별 작업 맵 — 시작일~종료일 범위 전체 포함
  const calTasksByDate = {};
  const addToDate = (key, task, meta = {}) => {
    if (!calTasksByDate[key]) calTasksByDate[key] = [];
    calTasksByDate[key].push({ ...task, ...meta });
  };
  allTasks.forEach(t => {
    const start = t.startDate ? t.startDate.slice(0,10) : null;
    const end   = t.deadline  ? t.deadline.slice(0,10)  : null;
    if (start && end && start !== end) {
      // 범위 전체에 걸쳐 표시
      const s = new Date(start), e = new Date(end);
      let cur = new Date(s);
      while (cur <= e) {
        const k = cur.toISOString().slice(0,10);
        const isFirst = k === start;
        const isLast  = k === end;
        addToDate(k, t, { _range: true, _isStart: isFirst, _isEnd: isLast });
        cur.setDate(cur.getDate() + 1);
      }
    } else if (end) {
      addToDate(end, t, { _isEnd: true });
    } else if (start) {
      addToDate(start, t, { _isStart: true });
    }
  });
  const calFirstDay = new Date(calViewYear, calViewMonth, 1).getDay();
  const calDaysInMonth = new Date(calViewYear, calViewMonth + 1, 0).getDate();
  const calCells = [];
  for (let i = 0; i < calFirstDay; i++) calCells.push(null);
  for (let d = 1; d <= calDaysInMonth; d++) calCells.push(d);
  while (calCells.length % 7 !== 0) calCells.push(null);
  const calSelKey = `${calViewYear}-${String(calViewMonth+1).padStart(2,"0")}-${String(calSelDay).padStart(2,"0")}`;
  const calSelTasks = calTasksByDate[calSelKey] || [];

  const dayW = Math.max(Math.floor(containerW / zoomDays), 12);

  const zoomIn  = () => { const nd = Math.max(7, Math.floor(zoomDays * 0.6)); const c = zoomStart + Math.floor(zoomDays/2); setZoomDays(nd); setZoomStart(Math.max(0, c - Math.floor(nd/2))); };
  const zoomOut = () => { const nd = Math.min(totalDiff, Math.ceil(zoomDays * 1.5)); setZoomDays(nd); setZoomStart(Math.max(0, zoomStart - Math.floor((nd-zoomDays)/2))); };
  const panL    = () => setZoomStart(s => Math.max(0, s - Math.floor(zoomDays*0.3)));
  const panR    = () => setZoomStart(s => Math.min(totalDiff - zoomDays, s + Math.floor(zoomDays*0.3)));
  const reset   = () => { setZoomStart(0); setZoomDays(Math.min(totalDiff, 60)); };
  // 오늘로 이동
  const goToday = () => {
    const todayOff = Math.ceil((today - minDate) / 86400000);
    const newStart = Math.max(0, Math.min(totalDiff - zoomDays, todayOff - Math.floor(zoomDays / 2)));
    setZoomStart(newStart);
  };
  // 마우스 휠로 좌우 스크롤
  const handleWheel = null; // non-passive로 useEffect에서 처리

  const filteredTasks = allTasks.filter(t => !filterMember || t.memberId === filterMember);

  // 날짜가 실제로 설정된 경우만 반환 (기본값 자동 생성 안함)
  const getTaskStart    = t => t.startDate || null;
  const getTaskDeadline = t => t.deadline  || null;

  const getBar = t => {
    const startRaw = t.startDate || t.deadline;
    const endRaw   = t.deadline  || t.startDate;
    if (!startRaw && !endRaw) return null; // 날짜 없으면 바 없음
    const s = new Date((startRaw || endRaw).slice(0,10));
    const e = new Date((endRaw   || startRaw).slice(0,10));
    const sOff = Math.ceil((s - viewStart) / 86400000);
    const eOff = Math.ceil((e - viewStart) / 86400000);
    if (eOff < 0 || sOff > zoomDays) return null;
    const left  = Math.max(0, sOff) * dayW;
    const right = Math.min(zoomDays, Math.max(eOff, sOff + 1)) * dayW;
    const width = Math.max(right - left, dayW * 0.8);
    return { left, width, clipped: sOff < 0 || eOff > zoomDays };
  };

  const saveField = (task, field, value) => {
    const changes = { [field]: value };
    if (field === "startDate" && task.deadline && value > task.deadline) changes.deadline = value;
    if (field === "deadline"  && task.startDate && value < task.startDate) changes.startDate = value;
    // 시간이 표시 중이면 현재 입력된 시간도 함께 저장
    if (field === "startDate" && showTime[task.id])
      changes.startTime = timeInputs[task.id]?.startTime ?? task.startTime ?? "";
    if (field === "deadline" && showTime[task.id])
      changes.deadlineTime = timeInputs[task.id]?.deadlineTime ?? task.deadlineTime ?? "";
    onTaskChange(task.procId, task.id, changes);
    setEditingTask(null);
  };

  return (
    <div>
      {/* 헤더 */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 18 }}>
        <div>
          <h1 style={{ color: T.text, fontSize: 24, fontWeight: 800, marginBottom: 4 }}>스케줄 관리</h1>
          <p style={{ color: T.textSub, fontSize: 13 }}>캘린더로 일정을 확인하고, 아래 간트 차트로 타임라인을 관리하세요</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 100, background: canEdit ? `${T.success}15` : `${T.warn}15`, color: canEdit ? T.success : T.warn, fontWeight: 700 }}>
            {canEdit ? "✏️ 수정 가능" : "👁 읽기 전용"}
          </span>
          {isOwner && (
            <button onClick={() => onUpdateProject && onUpdateProject({ ganttEditPerm: !ganttEditPerm })}
              style={{ fontSize: 11, padding: "3px 10px", borderRadius: 100, background: ganttEditPerm ? `${T.accent}15` : T.surfaceHover, color: ganttEditPerm ? T.accent : T.textMuted, border: `1px solid ${ganttEditPerm ? T.accent : T.border2}`, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>
              {ganttEditPerm ? "🔓 팀원 수정 허용 중" : "🔒 팀원 수정 잠금"}
            </button>
          )}
        </div>
      </div>

      {/* ── 캘린더 (메인) ── */}
      <div style={{ marginBottom: 24 }}>
        {/* 캘린더 헤더 */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <button onClick={() => { if (calViewMonth===0){setCalViewYear(y=>y-1);setCalViewMonth(11);}else setCalViewMonth(m=>m-1); }} style={{ width:30,height:30,borderRadius:8,background:T.surfaceHover,border:`1px solid ${T.border2}`,color:T.textSub,fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" }}>‹</button>
          <span style={{ color:T.text,fontSize:15,fontWeight:700,minWidth:110,textAlign:"center" }}>{calViewYear}년 {calViewMonth+1}월</span>
          <button onClick={() => { if (calViewMonth===11){setCalViewYear(y=>y+1);setCalViewMonth(0);}else setCalViewMonth(m=>m+1); }} style={{ width:30,height:30,borderRadius:8,background:T.surfaceHover,border:`1px solid ${T.border2}`,color:T.textSub,fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" }}>›</button>
          <button onClick={() => { setCalViewYear(today.getFullYear());setCalViewMonth(today.getMonth());setCalSelDay(today.getDate()); }} style={{ padding:"4px 12px",background:`${T.accent}15`,border:`1px solid ${T.accent}44`,borderRadius:8,color:T.accent,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit" }}>오늘</button>
        </div>
        <div style={{ display:"flex",gap:16 }}>
          {/* 캘린더 그리드 */}
          <div style={{ flex:1,background:T.card,border:`1px solid ${T.border}`,borderRadius:14,overflow:"hidden" }}>
            <div style={{ display:"grid",gridTemplateColumns:"repeat(7,1fr)",borderBottom:`1px solid ${T.border}` }}>
              {["일","월","화","수","목","금","토"].map((d,i)=>(
                <div key={d} style={{ padding:"8px 0",textAlign:"center",fontSize:12,fontWeight:700,color:i===0?"#ef4444":i===6?"#3b82f6":T.textSub }}>{d}</div>
              ))}
            </div>
            <div style={{ display:"grid",gridTemplateColumns:"repeat(7,1fr)" }}>
              {calCells.map((d,i) => {
                if (!d) return <div key={`e${i}`} style={{ minHeight:80,borderRight:`1px solid ${T.border}`,borderBottom:`1px solid ${T.border}`,background:T.surfaceHover+"33" }} />;
                const dk = `${calViewYear}-${String(calViewMonth+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
                const dt = calTasksByDate[dk]||[];
                const isToday = dk===todayStr;
                const isSel = calSelDay===d;
                const dow = (calFirstDay+d-1)%7;
                return (
                  <div key={d} onClick={()=>setCalSelDay(d)}
                    style={{ minHeight:80,borderRight:`1px solid ${T.border}`,borderBottom:`1px solid ${T.border}`,padding:"5px",cursor:"pointer",background:isSel?`${T.accent}12`:isToday?`${T.accent}06`:"transparent",position:"relative" }}
                    onMouseEnter={e=>{if(!isSel)e.currentTarget.style.background=T.surfaceHover;}}
                    onMouseLeave={e=>{e.currentTarget.style.background=isSel?`${T.accent}12`:isToday?`${T.accent}06`:"transparent";}}>
                    <div style={{ marginBottom:3,display:"flex",alignItems:"center",justifyContent:"space-between" }}>
                      <span style={{ width:22,height:22,borderRadius:"50%",display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:isToday?800:500,background:isToday?T.accent:"transparent",color:isToday?"#fff":dow===0?"#ef4444":dow===6?"#3b82f6":T.text }}>{d}</span>
                      {canEdit && isSel && (
                        <button onClick={e=>{e.stopPropagation();setNewTaskModal({dateKey:dk});setNtTitle("");setNtMemberId("");setNtProcId(project.procedures[0]?.id||"");setNtStartDate(dk);setNtEndDate(dk);}}
                          style={{ width:16,height:16,borderRadius:"50%",background:T.accent,border:"none",color:"#fff",fontSize:11,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1 }} title="작업 추가">+</button>
                      )}
                    </div>
                    {dt.slice(0,3).map((t,ti)=>{
                      const col = t.memberColor || t.procColor || T.accent;
                      const isRange = t._range;
                      const bgStyle = t.status === "done" ? `${T.success}22` : isRange ? `${col}28` : `${col}18`;
                      const borderRadius = isRange
                        ? (t._isStart ? "4px 0 0 4px" : t._isEnd ? "0 4px 4px 0" : "0")
                        : "4px";
                      return (
                        <div key={`${t.id}${ti}`} onClick={e=>{e.stopPropagation();setCalDetailTask(t);}}
                          style={{ fontSize:9,padding:"2px 4px",borderRadius,marginBottom:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",
                            background:bgStyle, color:t.status==="done"?T.success:col,
                            border:`1px solid ${col}44`,
                            textDecoration:t.status==="done"?"line-through":"none",
                          }}>
                          {t._isStart ? "▶ " : t._isEnd ? "■ " : "— "}{(t._isStart || t._isEnd || !t._range) ? t.title : ""}
                        </div>
                      );
                    })}
                    {dt.length>3&&<div style={{fontSize:8,color:T.textMuted}}>+{dt.length-3}</div>}
                  </div>
                );
              })}
            </div>
          </div>
          {/* 우측: 선택일 작업 */}
          <div style={{ width:240,flexShrink:0,background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"14px",overflowY:"auto",maxHeight:480 }}>
            <p style={{ color:T.text,fontSize:13,fontWeight:700,marginBottom:10 }}>{calViewMonth+1}월 {calSelDay}일 · {calSelTasks.length}개</p>
            {calSelTasks.length===0?(
              <p style={{ color:T.textMuted,fontSize:12,textAlign:"center",marginTop:20 }}>일정 없음</p>
            ):calSelTasks.map((t,i)=>{
              const col = t.memberColor || t.procColor || T.accent;
              return (
              <div key={`${t.id}${i}`} onClick={()=>setCalDetailTask(t)}
                style={{ padding:"9px 11px",background:T.surface,border:`1px solid ${col}33`,borderRadius:9,marginBottom:7,cursor:"pointer",borderLeft:`3px solid ${col}` }}
                onMouseEnter={e=>e.currentTarget.style.background=T.surfaceHover}
                onMouseLeave={e=>e.currentTarget.style.background=T.surface}>
                <div style={{ display:"flex",alignItems:"center",gap:5,marginBottom:3 }}>
                  <span style={{ fontSize:11 }}>{t.procIcon}</span>
                  <span style={{ color:T.textMuted,fontSize:9 }}>{t.procName}</span>
                  <span style={{ marginLeft:"auto",fontSize:9,padding:"1px 5px",borderRadius:100,background:`${t._isStart?T.success:t.status==="done"?T.success:t.status==="doing"?T.warn:T.border}18`,color:t._isStart?T.success:t.status==="done"?T.success:t.status==="doing"?T.warn:T.textMuted,fontWeight:700 }}>
                    {t._isStart?"시작":t.status==="done"?"완료":t.status==="doing"?"진행중":"미진행"}
                  </span>
                </div>
                <p style={{ color:T.text,fontSize:11,fontWeight:600,textDecoration:t.status==="done"?"line-through":"none" }}>{t.title}</p>
                {(t.startTime||t.deadlineTime)&&<p style={{ color:T.textMuted,fontSize:9,marginTop:2 }}>{t._isStart&&t.startTime?`▶ ${t.startTime}`:""}{!t._isStart&&t.deadlineTime?`■ ${t.deadlineTime}`:""}</p>}
              </div>
            );})}
          </div>
        </div>
      </div>

      {/* 캘린더 작업 상세 모달 */}
      {calDetailTask && (
        <div onClick={()=>setCalDetailTask(null)} style={{ position:"fixed",inset:0,zIndex:400,background:"rgba(0,0,0,.5)",display:"flex",alignItems:"center",justifyContent:"center" }}>
          <div onClick={e=>e.stopPropagation()} style={{ background:T.surface,border:`1px solid ${T.border}`,borderRadius:16,padding:26,width:400,boxShadow:"0 16px 60px rgba(0,0,0,.3)",maxHeight:"85vh",overflowY:"auto" }}>
            <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:14 }}>
              <span style={{ fontSize:16 }}>{calDetailTask.procIcon}</span>
              <span style={{ color:T.textMuted,fontSize:12 }}>{calDetailTask.procName}</span>
              {!canEdit && <span style={{ fontSize:10,padding:"2px 7px",borderRadius:100,background:`${T.warn}15`,color:T.warn,fontWeight:700,marginLeft:4 }}>읽기 전용</span>}
              <button onClick={()=>setCalDetailTask(null)} style={{ marginLeft:"auto",background:"none",border:"none",color:T.textMuted,cursor:"pointer",fontSize:18 }}>×</button>
            </div>
            <p style={{ color:T.text,fontSize:15,fontWeight:700,marginBottom:16 }}>{calDetailTask.title}</p>
            {/* 수정 가능 필드 */}
            <div style={{ display:"flex",flexDirection:"column",gap:10,marginBottom:14 }}>
              {/* 시작일+시간 */}
              <div style={{ display:"flex",gap:8,alignItems:"center" }}>
                <span style={{ color:T.textMuted,fontSize:11,fontWeight:700,minWidth:40 }}>시작일</span>
                <input type="date" disabled={!canEdit} value={calDetailTask.startDate?.slice(0,10)||""}
                  onChange={e=>{const v=e.target.value;onTaskChange(calDetailTask.procId,calDetailTask.id,{startDate:v});setCalDetailTask(p=>({...p,startDate:v}));}}
                  style={{ flex:1,padding:"4px 8px",background:canEdit?T.surfaceHover:T.surface,border:`1px solid ${T.border2}`,borderRadius:6,color:T.text,fontSize:12,outline:"none",fontFamily:"inherit",cursor:canEdit?"text":"not-allowed" }} />
                <input type="time" disabled={!canEdit} value={calDetailTask.startTime||""}
                  onChange={e=>{const v=e.target.value;onTaskChange(calDetailTask.procId,calDetailTask.id,{startTime:v});setCalDetailTask(p=>({...p,startTime:v}));}}
                  style={{ width:80,padding:"4px 6px",background:canEdit?T.surfaceHover:T.surface,border:`1px solid ${T.border2}`,borderRadius:6,color:T.text,fontSize:12,outline:"none",fontFamily:"inherit",cursor:canEdit?"text":"not-allowed" }} />
              </div>
              {/* 마감일+시간 */}
              <div style={{ display:"flex",gap:8,alignItems:"center" }}>
                <span style={{ color:T.textMuted,fontSize:11,fontWeight:700,minWidth:40 }}>마감일</span>
                <input type="date" disabled={!canEdit} value={calDetailTask.deadline?.slice(0,10)||""}
                  onChange={e=>{const v=e.target.value;onTaskChange(calDetailTask.procId,calDetailTask.id,{deadline:v});setCalDetailTask(p=>({...p,deadline:v}));}}
                  style={{ flex:1,padding:"4px 8px",background:canEdit?T.surfaceHover:T.surface,border:`1px solid ${T.border2}`,borderRadius:6,color:T.text,fontSize:12,outline:"none",fontFamily:"inherit",cursor:canEdit?"text":"not-allowed" }} />
                <input type="time" disabled={!canEdit} value={calDetailTask.deadlineTime||""}
                  onChange={e=>{const v=e.target.value;onTaskChange(calDetailTask.procId,calDetailTask.id,{deadlineTime:v});setCalDetailTask(p=>({...p,deadlineTime:v}));}}
                  style={{ width:80,padding:"4px 6px",background:canEdit?T.surfaceHover:T.surface,border:`1px solid ${T.border2}`,borderRadius:6,color:T.text,fontSize:12,outline:"none",fontFamily:"inherit",cursor:canEdit?"text":"not-allowed" }} />
              </div>
              {/* 담당자 */}
              <div style={{ display:"flex",gap:8,alignItems:"center" }}>
                <span style={{ color:T.textMuted,fontSize:11,fontWeight:700,minWidth:40 }}>담당자</span>
                <span style={{ color:T.text,fontSize:12 }}>{project.members.find(m=>m.id===calDetailTask.memberId)?.name||"미할당"}</span>
              </div>
            </div>
            {/* 상태 버튼 */}
            {canEdit ? (
              <div style={{ display:"flex",gap:6 }}>
                {["todo","doing","done"].map(s=>(
                  <button key={s} onClick={()=>{onTaskChange(calDetailTask.procId,calDetailTask.id,{status:s});setCalDetailTask(prev=>({...prev,status:s}));}}
                    style={{ flex:1,padding:"7px 0",background:calDetailTask.status===s?`${T.accent}18`:T.surfaceHover,border:`1px solid ${calDetailTask.status===s?T.accent:T.border2}`,borderRadius:7,color:calDetailTask.status===s?T.accent:T.textMuted,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit",transition:"all .15s" }}>
                    {s==="todo"?"미진행":s==="doing"?"진행중":"완료"}
                  </button>
                ))}
              </div>
            ) : (
              <div style={{ padding:"8px 12px",background:`${T.warn}10`,borderRadius:8,border:`1px solid ${T.warn}33` }}>
                <p style={{ color:T.warn,fontSize:11,fontWeight:600 }}>👁 읽기 전용 — 팀장에게 수정 권한을 요청하세요</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 날짜 클릭 → 작업 추가 모달 */}
      {newTaskModal && (
        <div onClick={()=>setNewTaskModal(null)} style={{ position:"fixed",inset:0,zIndex:500,background:"rgba(0,0,0,.5)",display:"flex",alignItems:"center",justifyContent:"center" }}>
          <div onClick={e=>e.stopPropagation()} style={{ background:T.surface,border:`1px solid ${T.border}`,borderRadius:16,padding:28,width:420,boxShadow:"0 16px 60px rgba(0,0,0,.35)" }}>
            <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20 }}>
              <h3 style={{ color:T.text,fontSize:15,fontWeight:800 }}>📝 새 작업 추가</h3>
              <button onClick={()=>setNewTaskModal(null)} style={{ background:"none",border:"none",color:T.textMuted,fontSize:18,cursor:"pointer" }}>×</button>
            </div>
            <div style={{ display:"flex",flexDirection:"column",gap:12 }}>
              {/* 작업 이름 */}
              <div>
                <label style={{ display:"block",color:T.textSub,fontSize:11,fontWeight:700,marginBottom:5 }}>작업 이름 *</label>
                <input value={ntTitle} onChange={e=>setNtTitle(e.target.value)} placeholder="작업 이름 입력"
                  style={{ width:"100%",padding:"8px 12px",background:T.surfaceHover,border:`1px solid ${T.border2}`,borderRadius:8,color:T.text,fontSize:13,outline:"none",fontFamily:"inherit",boxSizing:"border-box" }} />
              </div>
              {/* 절차 선택 */}
              <div>
                <label style={{ display:"block",color:T.textSub,fontSize:11,fontWeight:700,marginBottom:5 }}>절차 *</label>
                <select value={ntProcId} onChange={e=>setNtProcId(e.target.value)}
                  style={{ width:"100%",padding:"8px 12px",background:T.surfaceHover,border:`1px solid ${T.border2}`,borderRadius:8,color:T.text,fontSize:13,outline:"none",fontFamily:"inherit",boxSizing:"border-box" }}>
                  <option value="">절차 선택...</option>
                  {project.procedures.map(p=><option key={p.id} value={p.id}>{p.icon} {p.name}</option>)}
                </select>
              </div>
              {/* 담당자 선택 */}
              <div>
                <label style={{ display:"block",color:T.textSub,fontSize:11,fontWeight:700,marginBottom:5 }}>담당자</label>
                <select value={ntMemberId} onChange={e=>setNtMemberId(e.target.value)}
                  style={{ width:"100%",padding:"8px 12px",background:T.surfaceHover,border:`1px solid ${T.border2}`,borderRadius:8,color:T.text,fontSize:13,outline:"none",fontFamily:"inherit",boxSizing:"border-box" }}>
                  <option value="">담당자 없음</option>
                  {project.members.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
              {/* 시작일 / 마감일 */}
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10 }}>
                <div>
                  <label style={{ display:"block",color:T.textSub,fontSize:11,fontWeight:700,marginBottom:5 }}>시작일</label>
                  <input type="date" value={ntStartDate} onChange={e=>setNtStartDate(e.target.value)}
                    style={{ width:"100%",padding:"8px 10px",background:T.surfaceHover,border:`1px solid ${T.border2}`,borderRadius:8,color:T.text,fontSize:12,outline:"none",fontFamily:"inherit",boxSizing:"border-box" }} />
                </div>
                <div>
                  <label style={{ display:"block",color:T.textSub,fontSize:11,fontWeight:700,marginBottom:5 }}>마감일</label>
                  <input type="date" value={ntEndDate} onChange={e=>setNtEndDate(e.target.value)}
                    style={{ width:"100%",padding:"8px 10px",background:T.surfaceHover,border:`1px solid ${T.border2}`,borderRadius:8,color:T.text,fontSize:12,outline:"none",fontFamily:"inherit",boxSizing:"border-box" }} />
                </div>
              </div>
            </div>
            <div style={{ display:"flex",gap:10,marginTop:20 }}>
              <button onClick={()=>setNewTaskModal(null)}
                style={{ flex:1,padding:"9px 0",background:T.surfaceHover,border:`1px solid ${T.border2}`,borderRadius:9,color:T.textSub,fontSize:13,cursor:"pointer",fontFamily:"inherit" }}>취소</button>
              <button disabled={!ntTitle.trim()||!ntProcId||ntSaving} onClick={async()=>{
                if(!ntTitle.trim()||!ntProcId) return;
                setNtSaving(true);
                try {
                  await onAddTask(ntProcId, ntTitle.trim(), ntMemberId||null, ntStartDate||null, ntEndDate||null);
                  setNewTaskModal(null);
                } catch(e){ notify("작업 추가 실패: "+e.message,"err"); }
                finally { setNtSaving(false); }
              }} style={{ flex:2,padding:"9px 0",background:!ntTitle.trim()||!ntProcId?T.border2:`linear-gradient(135deg,${T.accent},${T.accentSub})`,border:"none",borderRadius:9,color:!ntTitle.trim()||!ntProcId?T.textMuted:"#fff",fontSize:13,fontWeight:700,cursor:!ntTitle.trim()||!ntProcId?"default":"pointer",fontFamily:"inherit" }}>
                {ntSaving?"추가 중...":"✅ 작업 추가"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 간트 차트 (접기/펼치기) ── */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 13, overflow: "hidden" }}>
        {/* 간트 헤더 — 클릭으로 접기 */}
        <div onClick={() => setGanttCollapsed(v => !v)}
          style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"12px 18px", cursor:"pointer", borderBottom: ganttCollapsed ? "none" : `1px solid ${T.border}` }}
          onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
          onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
          <div style={{ display:"flex", alignItems:"center", gap: 8 }}>
            <span style={{ fontSize: 14 }}>📊</span>
            <span style={{ color: T.text, fontSize: 13, fontWeight: 700 }}>간트 차트</span>
            <span style={{ fontSize: 10, color: T.textMuted }}>({filteredTasks.length}개 작업)</span>
          </div>
          <span style={{ color: T.textMuted, fontSize: 12 }}>{ganttCollapsed ? "▶ 펼치기" : "▼ 접기"}</span>
        </div>

        {!ganttCollapsed && (
          <div>
            {/* 컨트롤 바 */}
            <div style={{ display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",padding:"10px 14px",background:T.surface,borderBottom:`1px solid ${T.border}` }}>
              <select value={filterMember} onChange={e=>setFilterMember(e.target.value)}
                style={{ padding:"5px 9px",background:T.surfaceHover,border:`1px solid ${filterMember?T.accent:T.border2}`,borderRadius:7,color:filterMember?T.accent:T.textSub,fontSize:12,outline:"none",fontFamily:"inherit" }}>
                <option value="">👤 전체 담당자</option>
                {project.members.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              <div style={{ width:1,height:20,background:T.border2 }} />
              {[["−",zoomOut],["+",zoomIn],["전체",reset]].map(([l,fn])=>(
                <button key={l} onClick={fn} style={{ padding:"4px 9px",background:T.surfaceHover,border:`1px solid ${T.border2}`,borderRadius:6,color:T.textSub,fontSize:11,cursor:"pointer",fontFamily:"inherit" }}>{l}</button>
              ))}
              <div style={{ width:1,height:20,background:T.border2 }} />
              {[["◀",panL],["▶",panR]].map(([l,fn])=>(
                <button key={l} onClick={fn} style={{ padding:"4px 9px",background:T.surfaceHover,border:`1px solid ${T.border2}`,borderRadius:6,color:T.textSub,fontSize:11,cursor:"pointer",fontFamily:"inherit" }}>{l}</button>
              ))}
              <button onClick={goToday} style={{ padding:"4px 10px",background:`${T.accent}15`,border:`1px solid ${T.accent}44`,borderRadius:6,color:T.accent,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit" }}>📍 오늘</button>
              <div style={{ flex:1 }} />
              <span style={{ color:T.textMuted,fontSize:10 }}>{days[0]?.toLocaleDateString("ko-KR",{month:"short",day:"numeric"})} ~ {days[days.length-1]?.toLocaleDateString("ko-KR",{month:"short",day:"numeric"})} ({zoomDays}일)</span>
            </div>

            {/* 간트 차트 본체 */}
            <div ref={containerRef} style={{ overflow: "auto", maxWidth: "100%" }}>
            {/* 날짜 헤더 */}
            <div style={{ display: "flex", borderBottom: `1px solid ${T.border}`, position: "sticky", top: 0, background: T.card, zIndex: 3 }}>
          <div style={{ width: 200, flexShrink: 0, padding: "8px 14px", borderRight: `1px solid ${T.border}`, color: T.textMuted, fontSize: 11, fontWeight: 600 }}>작업</div>
          <div style={{ display: "flex", minWidth: days.length * dayW }}>
            {days.map((d, i) => {
              const isToday  = d.toDateString() === today.toDateString();
              const isWeekend = d.getDay() === 0 || d.getDay() === 6;
              return (
                <div key={i} style={{ width: dayW, flexShrink: 0, textAlign: "center", borderRight: d.getDay() === 0 ? `1px solid ${T.border}` : "none", background: isToday ? `${T.accent}20` : isWeekend ? `${T.border}44` : "transparent", padding: "3px 0" }}>
                  {(i === 0 || d.getDate() === 1) && <div style={{ color: T.textMuted, fontSize: 8, fontWeight: 700 }}>{d.getMonth()+1}월</div>}
                  {dayW >= 14 && <div style={{ color: isToday ? T.accent : T.textMuted, fontSize: 8, fontWeight: isToday ? 800 : 400 }}>{d.getDate()}</div>}
                </div>
              );
            })}
          </div>
        </div>

        {/* 작업 행 */}
        {filteredTasks.length === 0 ? (
          <div style={{ padding: "32px", textAlign: "center", color: T.textMuted, fontSize: 13 }}>
            {filterMember ? "선택한 담당자의 작업이 없습니다." : "작업이 없습니다."}
          </div>
        ) : filteredTasks.map((task, ti) => {
          const bar = getBar(task);
          const color = getMemberColor(task);
          const isOverdue = getTaskDeadline(task) < todayStr && task.status !== "done";
          const member = project.members.find(m => m.id === task.memberId);
          const isEditingStart = editingTask?.id === task.id && editingTask?.field === "start";
          const isEditingEnd   = editingTask?.id === task.id && editingTask?.field === "end";
          const hasTime = showTime[task.id];

          return (
            <div key={task.id} style={{ display: "flex", borderBottom: `1px solid ${T.border}`, minHeight: 52 }}>
              {/* 작업명 열 */}
              <div style={{ width: 200, flexShrink: 0, padding: "8px 12px", borderRight: `1px solid ${T.border}`, display: "flex", flexDirection: "column", justifyContent: "center", gap: 2 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ fontSize: 10 }}>{task.procIcon}</span>
                  <p style={{ color: T.text, fontSize: 11, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, textDecoration: task.status === "done" ? "line-through" : "none" }}>{task.title}</p>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: SC[task.status], flexShrink: 0 }} />
                </div>
                {member && <span style={{ color: T.textSub, fontSize: 9 }}>👤 {member.name}</span>}
                {/* 날짜 인라인 편집 */}
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {/* 시작일 */}
                  {canEdit && isEditingStart ? (
                    <div style={{ display: "flex", gap: 3 }}>
                      <input type="date" autoFocus defaultValue={(getTaskStart(task) || "").slice(0,10)}
                        onBlur={e => saveField(task, "startDate", e.target.value)}
                        style={{ width: 95, padding: "2px 5px", background: T.surface, border: `1px solid ${T.accent}`, borderRadius: 5, color: T.text, fontSize: 9, outline: "none", fontFamily: "inherit" }} />
                      {hasTime && <input type="time" defaultValue={task.startTime || "09:00"}
                        onBlur={e => onTaskChange(task.procId, task.id, { startTime: e.target.value })}
                        style={{ width: 65, padding: "2px 4px", background: T.surface, border: `1px solid ${T.accent}`, borderRadius: 5, color: T.text, fontSize: 9, outline: "none", fontFamily: "inherit" }} />}
                    </div>
                  ) : (
                    <button onClick={() => canEdit && setEditingTask({ id: task.id, field: "start" })}
                      style={{ fontSize: 9, padding: "1px 5px", borderRadius: 4, background: task.startDate ? `${T.success}12` : T.surfaceHover, color: task.startDate ? T.success : T.textMuted, border: `1px solid ${task.startDate ? T.success : T.border2}33`, cursor: canEdit ? "pointer" : "default", fontFamily: "inherit" }}>
                      ▶ {task.startDate ? `${task.startDate.slice(0,10)}${task.startTime ? ` ${task.startTime}` : ""}` : (canEdit ? "시작일 설정" : "미설정")}
                    </button>
                  )}
                  {/* 마감일 */}
                  {canEdit && isEditingEnd ? (
                    <div style={{ display: "flex", gap: 3 }}>
                      <input type="date" autoFocus defaultValue={(getTaskDeadline(task) || "").slice(0,10)}
                        onBlur={e => saveField(task, "deadline", e.target.value)}
                        style={{ width: 95, padding: "2px 5px", background: T.surface, border: `1px solid ${T.danger}`, borderRadius: 5, color: T.text, fontSize: 9, outline: "none", fontFamily: "inherit" }} />
                      {hasTime && <input type="time" defaultValue={task.deadlineTime || "18:00"}
                        onBlur={e => onTaskChange(task.procId, task.id, { deadlineTime: e.target.value })}
                        style={{ width: 65, padding: "2px 4px", background: T.surface, border: `1px solid ${T.danger}`, borderRadius: 5, color: T.text, fontSize: 9, outline: "none", fontFamily: "inherit" }} />}
                    </div>
                  ) : (
                    <button onClick={() => canEdit && setEditingTask({ id: task.id, field: "end" })}
                      style={{ fontSize: 9, padding: "1px 5px", borderRadius: 4, background: task.deadline ? (isOverdue ? `${T.danger}12` : `${T.warn}10`) : T.surfaceHover, color: task.deadline ? (isOverdue ? T.danger : T.warn) : T.textMuted, border: `1px solid ${task.deadline ? (isOverdue ? T.danger : T.warn) : T.border2}33`, cursor: canEdit ? "pointer" : "default", fontFamily: "inherit" }}>
                      ■ {task.deadline ? `${task.deadline.slice(0,10)}${task.deadlineTime ? ` ${task.deadlineTime}` : ""} ${isOverdue ? "⚠" : ""}` : (canEdit ? "마감일 설정" : "미설정")}
                    </button>
                  )}
                  {/* 시간 토글 — canEdit일 때만 표시 */}
                  {canEdit && (
                    <button onClick={() => setShowTime(s => ({ ...s, [task.id]: !hasTime }))}
                      style={{ fontSize: 8, padding: "1px 5px", borderRadius: 4, background: hasTime ? `${T.accent}15` : T.surfaceHover, color: hasTime ? T.accent : T.textMuted, border: `1px solid ${hasTime ? T.accent : T.border2}44`, cursor: "pointer", fontFamily: "inherit" }}>
                      🕐 {hasTime ? "시간 숨기기" : "시간 추가"}
                    </button>
                  )}
                  {/* 읽기 전용 시 시간 표시만 */}
                  {!canEdit && hasTime && (
                    <span style={{ fontSize: 8, color: T.textMuted }}>🕐 {task.startTime||""}{task.startTime&&task.deadlineTime?" ~ ":""}{task.deadlineTime||""}</span>
                  )}
                </div>
                {/* 시간 직접 입력 행 + 각 초기화 버튼 — canEdit일 때만 */}
                {canEdit && hasTime && (
                  <div style={{ display: "flex", gap: 6, marginTop: 3, flexWrap: "wrap" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                      <span style={{ color: T.textMuted, fontSize: 8 }}>시작</span>
                      <input type="time" value={(timeInputs[task.id]?.startTime) ?? (task.startTime || "09:00")}
                        onChange={e => setTimeInputs(ti => ({ ...ti, [task.id]: { ...(ti[task.id] || {}), startTime: e.target.value } }))}
                        onBlur={e => onTaskChange(task.procId, task.id, { startTime: e.target.value })}
                        style={{ width: 70, padding: "2px 4px", background: T.surfaceHover, border: `1px solid ${T.success}55`, borderRadius: 5, color: T.text, fontSize: 9, outline: "none", fontFamily: "inherit" }} />
                      <button onClick={() => {
                        setTimeInputs(ti => ({ ...ti, [task.id]: { ...(ti[task.id] || {}), startTime: "" } }));
                        onTaskChange(task.procId, task.id, { startTime: "" });
                      }} title="시작 시간 초기화" style={{ fontSize: 8, padding: "1px 4px", borderRadius: 3, background: T.surfaceHover, color: T.textMuted, border: `1px solid ${T.border2}`, cursor: "pointer", fontFamily: "inherit" }}>↺</button>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                      <span style={{ color: T.textMuted, fontSize: 8 }}>마감</span>
                      <input type="time" value={(timeInputs[task.id]?.deadlineTime) ?? (task.deadlineTime || "18:00")}
                        onChange={e => setTimeInputs(ti => ({ ...ti, [task.id]: { ...(ti[task.id] || {}), deadlineTime: e.target.value } }))}
                        onBlur={e => onTaskChange(task.procId, task.id, { deadlineTime: e.target.value })}
                        style={{ width: 70, padding: "2px 4px", background: T.surfaceHover, border: `1px solid ${T.danger}55`, borderRadius: 5, color: T.text, fontSize: 9, outline: "none", fontFamily: "inherit" }} />
                      <button onClick={() => {
                        setTimeInputs(ti => ({ ...ti, [task.id]: { ...(ti[task.id] || {}), deadlineTime: "" } }));
                        onTaskChange(task.procId, task.id, { deadlineTime: "" });
                      }} title="마감 시간 초기화" style={{ fontSize: 8, padding: "1px 4px", borderRadius: 3, background: T.surfaceHover, color: T.textMuted, border: `1px solid ${T.border2}`, cursor: "pointer", fontFamily: "inherit" }}>↺</button>
                    </div>
                  </div>
                )}
              </div>

              {/* 타임라인 */}
              <div style={{ position: "relative", flex: 1, display: "flex", alignItems: "center", minWidth: days.length * dayW, overflow: "hidden" }}>
                {/* 오늘 라인 */}
                {(() => { const off = Math.ceil((today - viewStart)/86400000); return off >= 0 && off <= zoomDays ? <div style={{ position: "absolute", left: off*dayW, top:0, bottom:0, width:1.5, background: T.accent, opacity:.6, zIndex:2 }}/> : null; })()}
                {/* 주말 배경 */}
                {days.map((d,i) => (d.getDay()===0||d.getDay()===6) ? <div key={i} style={{ position:"absolute", left:i*dayW, top:0, bottom:0, width:dayW, background:`${T.border}33` }}/> : null)}
                {/* 간트 바 */}
                {bar && (
                  <div style={{ position: "absolute", left: bar.left + 2, width: bar.width - 4, height: 22, borderRadius: 6, background: task.status === "done" ? `${T.success}88` : isOverdue ? `${T.danger}88` : `${color}bb`, display: "flex", alignItems: "center", paddingLeft: 6, overflow: "hidden", cursor: "default", boxShadow: `0 2px 8px ${color}55`, border: `1px solid ${task.status==="done" ? T.success : isOverdue ? T.danger : color}66` }}>
                    <span style={{ color: "#fff", fontSize: 9, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textShadow: "0 1px 2px rgba(0,0,0,.35)" }}>
                      {task.title}
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>{/* filteredTasks loop end */}

          {/* 범례 */}
          <div style={{ padding: "8px 14px", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", borderTop: `1px solid ${T.border}` }}>
            {[["오늘", T.accent, "rect"], ["완료", T.success+"88", "circle"], ["기한초과", T.danger+"88", "circle"], ["주말", T.border, "rect"]].map(([l,c,s]) => (
              <div key={l} style={{ display:"flex", alignItems:"center", gap:4, color: T.textMuted, fontSize:10 }}>
                <div style={{ width:8, height:8, borderRadius: s==="circle"?"50%":2, background:c }}/> {l}
              </div>
            ))}
            <div style={{ width:1, height:12, background:T.border2 }} />
            {project.members.map((m,idx) => (
              <div key={m.id} style={{ display:"flex", alignItems:"center", gap:4, color: T.textMuted, fontSize:10 }}>
                <div style={{ width:8, height:8, borderRadius:2, background:PASTEL_COLORS[idx%PASTEL_COLORS.length]+"bb", border:`1px solid ${PASTEL_COLORS[idx%PASTEL_COLORS.length]}` }} /> {m.name}
              </div>
            ))}
            <span style={{ color:T.textMuted, fontSize:10, marginLeft:"auto" }}>· ▶날짜 / ■마감 클릭으로 인라인 수정 · 🕐 시간 추가 가능</span>
          </div>
            </div>
        )}
      </div>
    </div>
  );
}

// ─── MY TASKS TAB (개인 간트차트 포함) ────────────────────────────────────────
function MyTasksTab({ T, project, loginName, onTaskChange, onDeleteTask, onFileUpload, notify }) {
  const me = project.members.find(m => m.name === loginName);
  const allMine = project.procedures.flatMap(proc =>
    proc.tasks.filter(t => t.memberId === me?.id || t.memberName === loginName)
      .map(t => ({ ...t, procName: proc.name, procIcon: proc.icon, procId: proc.id }))
  );
  const [selectedTask, setSelectedTask] = useState(null);
  const [myTab, setMyTab] = useState("kanban");
  const [aiRec, setAiRec] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const groups = { todo: allMine.filter(t => t.status === "todo"), doing: allMine.filter(t => t.status === "doing"), done: allMine.filter(t => t.status === "done") };

  const getAiRecommendation = async () => {
    setAiLoading(true); setAiRec(null);
    const todayStr = new Date().toISOString().slice(0, 10);
    const taskSummary = allMine.filter(t => t.status !== "done").map(t =>
      `- ${t.title} [${t.status}] 마감:${t.deadline || "미정"} 절차:${t.procName}`
    ).join("\n");
    try {
      const resp = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: `오늘 날짜는 ${todayStr}입니다. 다음은 ${loginName}님의 미완료 작업 목록입니다:\n${taskSummary}\n\n이 작업들을 분석하여 오늘 우선 처리해야 할 작업 TOP 3와 이유를 간결하게 알려주세요. 반드시 아래 JSON 형식만 출력하세요:\n{"recommendations":[{"task":"작업명","reason":"이유","priority":"high|medium|low"}]}`,
          maxTokens: 800,
        }),
      });
      const { text, error } = await resp.json();
      if (error) throw new Error(error);
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      setAiRec(parsed.recommendations || []);
    } catch { setAiRec([{ task: "AI 추천 불가", reason: "잠시 후 다시 시도해주세요.", priority: "low" }]); }
    finally { setAiLoading(false); }
  };

  const priorityColors = { high: "#ef4444", medium: "#f59e0b", low: "#10b981" };
  const priorityLabels = { high: "🔴 높음", medium: "🟡 보통", low: "🟢 낮음" };

  return (
    <div>
      {selectedTask && (
        <TaskDetailModal T={T} task={selectedTask} members={project.members} loginName={loginName}
          onClose={() => setSelectedTask(null)}
          onChange={ch => { onTaskChange(selectedTask.procId, selectedTask.id, ch); setSelectedTask(prev => ({ ...prev, ...ch })); }}
          onFileUpload={files => onFileUpload(selectedTask.procId, selectedTask, files).then(newFiles => setSelectedTask(prev => ({ ...prev, files: newFiles })))} />
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ color: T.text, fontSize: 24, fontWeight: 800, marginBottom: 4 }}>내 작업</h1>
          <p style={{ color: T.textSub, fontSize: 13 }}>{loginName}님에게 할당된 작업을 관리하세요</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={getAiRecommendation} disabled={aiLoading || allMine.filter(t=>t.status!=="done").length===0}
            style={{ padding: "7px 14px", background: aiLoading ? T.border2 : `linear-gradient(135deg,${T.accent},${T.accentSub})`, border: "none", borderRadius: 8, color: aiLoading ? T.textMuted : "#fff", fontSize: 12, fontWeight: 700, cursor: aiLoading ? "default" : "pointer", fontFamily: "inherit" }}>
            {aiLoading ? "🤖 분석 중..." : "✨ AI 우선순위 추천"}
          </button>
          {/* 뷰 전환 탭 */}
          <div style={{ display: "flex", background: T.surfaceHover, borderRadius: 9, padding: 3, border: `1px solid ${T.border}` }}>
            {[["kanban","📋 칸반"],["gantt","📅 일정"]].map(([v, label]) => (
              <button key={v} onClick={() => setMyTab(v)}
                style={{ padding: "6px 14px", border: "none", borderRadius: 7, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700, background: myTab === v ? T.surface : "transparent", color: myTab === v ? T.text : T.textMuted, boxShadow: myTab === v ? "0 1px 4px rgba(0,0,0,.1)" : "none", transition: "all .15s" }}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* AI 추천 패널 */}
      {aiRec && (
        <div style={{ marginBottom: 20, padding: "16px 18px", background: `${T.accent}08`, border: `1px solid ${T.accent}33`, borderRadius: 13 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <p style={{ color: T.accent, fontSize: 13, fontWeight: 700 }}>🤖 AI 오늘의 작업 우선순위</p>
            <button onClick={() => setAiRec(null)} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 16 }}>×</button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {aiRec.map((r, i) => (
              <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px", background: T.surface, borderRadius: 9, border: `1px solid ${priorityColors[r.priority] || T.border}33` }}>
                <span style={{ fontSize: 16, flexShrink: 0 }}>{["1️⃣","2️⃣","3️⃣"][i] || "▪️"}</span>
                <div style={{ flex: 1 }}>
                  <p style={{ color: T.text, fontSize: 12, fontWeight: 700, marginBottom: 3 }}>{r.task}</p>
                  <p style={{ color: T.textSub, fontSize: 11 }}>{r.reason}</p>
                </div>
                <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 100, background: `${priorityColors[r.priority] || T.border}18`, color: priorityColors[r.priority] || T.textSub, fontWeight: 700, flexShrink: 0 }}>{priorityLabels[r.priority] || r.priority}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 요약 통계 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 20 }}>
        {[["미진행", groups.todo.length, SC.todo], ["진행중", groups.doing.length, SC.doing], ["완료", groups.done.length, SC.done]].map(([label, cnt, color]) => (
          <div key={label} style={{ padding: "12px 16px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: 11, textAlign: "center" }}>
            <div style={{ color, fontSize: 20, fontWeight: 800 }}>{cnt}</div>
            <div style={{ color: T.textSub, fontSize: 11, marginTop: 2 }}>{label}</div>
          </div>
        ))}
      </div>

      {allMine.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 40px", background: T.card, borderRadius: 15, border: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>🎉</div>
          <p style={{ color: T.textSub, fontSize: 14, marginBottom: 5 }}>할당된 작업이 없습니다.</p>
          <p style={{ color: T.textMuted, fontSize: 12 }}>작업 관리 탭에서 "{loginName}"으로 담당자를 지정하세요.</p>
        </div>
      ) : myTab === "kanban" ? (
        /* ── 칸반 뷰 ── */
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
          {Object.entries(groups).map(([status, tasks]) => (
            <div key={status}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, padding: "8px 12px", background: `${SC[status]}12`, borderRadius: 8, border: `1px solid ${SC[status]}33` }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: SC[status] }} />
                <span style={{ color: SC[status], fontSize: 12, fontWeight: 700 }}>{ST[status]}</span>
                <span style={{ color: T.textMuted, fontSize: 11, marginLeft: "auto" }}>({tasks.length})</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {tasks.map(t => {
                  const isOverdue = t.deadline && t.status !== "done" && new Date(t.deadline.slice(0,10)) < new Date();
                  const fCount = (t.files || []).length;
                  const cCount = (t.comments || []).length;
                  return (
                    <div key={t.id} onClick={() => setSelectedTask(t)}
                      style={{ padding: "12px 13px", background: T.card, border: `1px solid ${T.border}`, borderRadius: 11, cursor: "pointer", transition: "all .15s" }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.boxShadow = `0 2px 12px ${T.accent}22`; }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.boxShadow = "none"; }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 5 }}>
                        <span style={{ fontSize: 11 }}>{t.procIcon}</span>
                        <span style={{ color: T.textMuted, fontSize: 10 }}>{t.procName}</span>
                      </div>
                      <p style={{ color: t.status === "done" ? T.textMuted : T.text, fontSize: 12, fontWeight: 600, lineHeight: 1.4, textDecoration: t.status === "done" ? "line-through" : "none", marginBottom: 7 }}>{t.title}</p>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 7 }}>
                        {t.startDate && <span style={{ fontSize: 9, padding: "2px 5px", borderRadius: 100, background: `${T.success}10`, color: T.success, fontWeight: 600 }}>▶ {t.startDate.slice(0,10)}{t.startTime ? ` ${t.startTime}` : ""}</span>}
                        {t.deadline && <span style={{ fontSize: 9, padding: "2px 5px", borderRadius: 100, background: isOverdue ? `${T.danger}15` : `${T.warn}10`, color: isOverdue ? T.danger : T.warn, fontWeight: 700 }}>■ {t.deadline.slice(0,10)}{t.deadlineTime ? ` ${t.deadlineTime}` : ""} {isOverdue ? "⚠" : ""}</span>}
                        {fCount > 0 && <span style={{ fontSize: 9, padding: "2px 5px", borderRadius: 100, background: `${T.accent}10`, color: T.accent, fontWeight: 600 }}>📎 {fCount}</span>}
                        {cCount > 0 && <span style={{ fontSize: 9, padding: "2px 5px", borderRadius: 100, background: `${T.success}10`, color: T.success, fontWeight: 600 }}>💬 {cCount}</span>}
                      </div>
                      <div style={{ display: "flex", gap: 4 }} onClick={e => e.stopPropagation()}>
                        {["todo","doing","done"].map(s => (
                          <button key={s} onClick={() => onTaskChange(t.procId, t.id, { status: s })}
                            style={{ flex: 1, padding: "3px 0", background: t.status === s ? `${SC[s]}18` : T.surfaceHover, border: `1px solid ${t.status === s ? SC[s] : T.border2}`, borderRadius: 5, color: t.status === s ? SC[s] : T.textMuted, fontSize: 9, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                            {ST[s]}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* ── 개인 간트차트 뷰 ── */
        <MyGanttView T={T} tasks={allMine} members={project.members} procedures={project.procedures} />
      )}
    </div>
  );
}

// ─── 개인 간트차트 (내 작업 탭용) ─────────────────────────────────────────────
function MyGanttView({ T, tasks, members = [], procedures = [] }) {
  const today    = new Date();
  const todayStr = today.toISOString().slice(0,10);

  const allDates = tasks.flatMap(t => [t.startDate, t.deadline].filter(Boolean).map(d => new Date(d)));
  const minDate = allDates.length ? new Date(Math.min(...allDates) - 3*86400000) : new Date(today.getFullYear(), today.getMonth(), 1);
  const maxDate = allDates.length ? new Date(Math.max(...allDates) + 7*86400000) : new Date(today.getFullYear(), today.getMonth()+2, 0);
  const totalDiff = Math.max(Math.ceil((maxDate - minDate)/86400000), 14);

  const [zoomStart, setZoomStart] = useState(0);
  const [zoomDays,  setZoomDays]  = useState(Math.min(totalDiff, 30));
  const containerRef = useRef(null);
  const [containerW, setContainerW] = useState(600);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(e => setContainerW(e[0].contentRect.width - 240));
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const viewStart = new Date(minDate); viewStart.setDate(viewStart.getDate() + zoomStart);
  const days = Array.from({ length: zoomDays }, (_, i) => { const d = new Date(viewStart); d.setDate(d.getDate()+i); return d; });
  const dayW = Math.max(Math.floor(containerW / zoomDays), 12);

  const PASTEL_COLORS = ["#a5b4fc","#93c5fd","#6ee7b7","#fcd34d","#f9a8d4","#fca5a5","#c4b5fd","#fdba74","#86efac","#67e8f9"];
  const memberColorMap = {};
  members.forEach((m, idx) => { memberColorMap[m.id] = PASTEL_COLORS[idx % PASTEL_COLORS.length]; });
  const procColorMap = {};
  procedures.forEach((p, idx) => { procColorMap[p.id] = p.color || PASTEL_COLORS[idx % PASTEL_COLORS.length]; });
  const getTaskColor = t => t.memberId && memberColorMap[t.memberId] ? memberColorMap[t.memberId] : (t.procId && procColorMap[t.procId] ? procColorMap[t.procId] : PASTEL_COLORS[0]);
  const legendMembers = members.filter(m => tasks.some(t => t.memberId === m.id));

  const goToday = () => {
    const off = Math.ceil((today - minDate) / 86400000);
    setZoomStart(Math.max(0, Math.min(totalDiff - zoomDays, off - Math.floor(zoomDays / 2))));
  };

  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    const handler = e => {
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? Math.floor(zoomDays*0.15) : -Math.floor(zoomDays*0.15);
      setZoomStart(s => Math.max(0, Math.min(totalDiff-zoomDays, s+delta)));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomDays, totalDiff]);

  const getBar = t => {
    const startRaw = t.startDate || t.deadline;
    if (!startRaw) return null;
    const s = new Date(startRaw);
    const e = new Date(t.deadline || startRaw);
    const sOff = Math.ceil((s - viewStart)/86400000);
    const eOff = Math.ceil((e - viewStart)/86400000);
    if (eOff < 0 || sOff > zoomDays) return null;
    const left = Math.max(0, sOff)*dayW;
    const right = Math.min(zoomDays, Math.max(eOff, sOff+1))*dayW;
    return { left, width: Math.max(right-left, dayW*0.8) };
  };

  return (
    <div>
      <div style={{ display:"flex", gap:7, marginBottom:12, alignItems:"center", flexWrap:"wrap" }}>
        <span style={{ color:T.textMuted, fontSize:11 }}>줌:</span>
        {[["−", () => setZoomDays(d => Math.min(totalDiff, Math.ceil(d*1.5)))],
          ["+", () => setZoomDays(d => Math.max(7, Math.floor(d*0.6)))],
          ["전체", () => { setZoomStart(0); setZoomDays(Math.min(totalDiff,30)); }],
          ["◀", () => setZoomStart(s => Math.max(0, s - Math.floor(zoomDays*0.3)))],
          ["▶", () => setZoomStart(s => Math.min(totalDiff-zoomDays, s + Math.floor(zoomDays*0.3)))]
        ].map(([l, fn]) => (
          <button key={l} onClick={fn} style={{ padding:"4px 9px", background:T.surfaceHover, border:`1px solid ${T.border2}`, borderRadius:6, color:T.textSub, fontSize:11, cursor:"pointer", fontFamily:"inherit" }}>{l}</button>
        ))}
        <button onClick={goToday} style={{ padding:"4px 10px", background:`${T.accent}15`, border:`1px solid ${T.accent}44`, borderRadius:6, color:T.accent, fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>📍 오늘</button>
        <span style={{ fontSize:10, padding:"2px 8px", borderRadius:100, background:`${T.warn}15`, color:T.warn, fontWeight:600, marginLeft:"auto" }}>👁 보기 전용 · 수정은 스케줄 탭에서</span>
      </div>

      <div ref={containerRef} style={{ background:T.card, border:`1px solid ${T.border}`, borderRadius:12, overflow:"auto", minHeight:200 }}>
        <div style={{ display:"flex", borderBottom:`1px solid ${T.border}`, position:"sticky", top:0, background:T.card, zIndex:2 }}>
          <div style={{ width:240, flexShrink:0, padding:"8px 16px", borderRight:`1px solid ${T.border}`, color:T.textMuted, fontSize:11, fontWeight:600 }}>내 작업</div>
          <div style={{ display:"flex", minWidth:days.length*dayW }}>
            {days.map((d,i) => (
              <div key={i} style={{ width:dayW, flexShrink:0, textAlign:"center", borderRight:d.getDay()===0?`1px solid ${T.border}`:"none", background:d.toDateString()===today.toDateString()?`${T.accent}20`:(d.getDay()===0||d.getDay()===6)?`${T.border}33`:"transparent", padding:"3px 0" }}>
                {(i===0||d.getDate()===1) && <div style={{ color:T.textMuted, fontSize:9, fontWeight:700 }}>{d.getMonth()+1}월</div>}
                {dayW>=14 && <div style={{ color:d.toDateString()===today.toDateString()?T.accent:T.textMuted, fontSize:9, fontWeight:d.toDateString()===today.toDateString()?800:400 }}>{d.getDate()}</div>}
              </div>
            ))}
          </div>
        </div>

        {tasks.length === 0 ? (
          <div style={{ padding:"40px 0", textAlign:"center", color:T.textMuted, fontSize:12 }}>내 작업이 없습니다</div>
        ) : tasks.map(t => {
          const bar = getBar(t);
          const color = getTaskColor(t);
          const isOverdue = t.deadline && t.deadline < todayStr && t.status !== "done";
          const memberName = members.find(m => m.id === t.memberId)?.name || "";
          return (
            <div key={t.id} style={{ display:"flex", borderBottom:`1px solid ${T.border}`, minHeight:60 }}>
              <div style={{ width:240, flexShrink:0, padding:"8px 14px", borderRight:`1px solid ${T.border}`, display:"flex", flexDirection:"column", justifyContent:"center", gap:3 }}>
                <div style={{ display:"flex", alignItems:"center", gap:5 }}>
                  {t.memberId && memberColorMap[t.memberId] && <div style={{ width:7, height:7, borderRadius:"50%", background:memberColorMap[t.memberId], flexShrink:0 }} />}
                  <p style={{ color:T.text, fontSize:11, fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 }}>{t.title}</p>
                </div>
                {memberName && <span style={{ color:T.textSub, fontSize:9 }}>👤 {memberName}</span>}
                <div style={{ display:"flex", gap:3, flexWrap:"wrap" }}>
                  {t.startDate
                    ? <span style={{ fontSize:9, padding:"1px 5px", borderRadius:3, background:`${T.success}12`, color:T.success, border:`1px solid ${T.success}22` }}>▶ {t.startDate.slice(0,10)}</span>
                    : <span style={{ fontSize:9, padding:"1px 5px", borderRadius:3, background:T.surfaceHover, color:T.textMuted, border:`1px solid ${T.border2}`, opacity:.6, fontStyle:"italic" }}>▶ 시작일 미설정</span>}
                  {t.deadline
                    ? <span style={{ fontSize:9, padding:"1px 5px", borderRadius:3, background:isOverdue?`${T.danger}12`:`${T.warn}10`, color:isOverdue?T.danger:T.warn, border:`1px solid ${isOverdue?T.danger:T.warn}22` }}>■ {t.deadline.slice(0,10)}{isOverdue?" ⚠":""}</span>
                    : <span style={{ fontSize:9, padding:"1px 5px", borderRadius:3, background:T.surfaceHover, color:T.textMuted, border:`1px solid ${T.border2}`, opacity:.6, fontStyle:"italic" }}>■ 마감일 미설정</span>}
                </div>
              </div>
              <div style={{ position:"relative", flex:1, display:"flex", alignItems:"center", minWidth:days.length*dayW, overflow:"hidden" }}>
                {(() => { const off=Math.ceil((today-viewStart)/86400000); return off>=0&&off<=zoomDays?<div style={{ position:"absolute", left:off*dayW, top:0, bottom:0, width:1.5, background:T.accent, opacity:.6, zIndex:2 }}/>:null; })()}
                {days.map((d2,i) => (d2.getDay()===0||d2.getDay()===6)?<div key={i} style={{ position:"absolute", left:i*dayW, top:0, bottom:0, width:dayW, background:`${T.border}33` }}/>:null)}
                {bar && (
                  <div style={{ position:"absolute", left:bar.left+1, width:bar.width-2, height:28, borderRadius:6, background:t.status==="done"?`${T.success}88`:isOverdue?`${T.danger}88`:`${color}cc`, border:`1px solid ${color}`, display:"flex", alignItems:"center", paddingLeft:8, overflow:"hidden", boxShadow:`0 2px 8px ${color}44` }}>
                    <span style={{ color:"#fff", fontSize:10, fontWeight:700, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", textShadow:"0 1px 2px rgba(0,0,0,.35)" }}>{t.title}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {legendMembers.length > 0 && (
        <div style={{ marginTop:8, display:"flex", gap:10, flexWrap:"wrap", alignItems:"center" }}>
          <span style={{ color:T.textMuted, fontSize:10, fontWeight:600 }}>담당자:</span>
          {legendMembers.map(m => (
            <div key={m.id} style={{ display:"flex", alignItems:"center", gap:3, color:T.textMuted, fontSize:10 }}>
              <div style={{ width:7, height:7, borderRadius:2, background:memberColorMap[m.id]+"bb", border:`1px solid ${memberColorMap[m.id]}` }} /> {m.name}
            </div>
          ))}
          <div style={{ width:1, height:10, background:T.border2 }} />
          <div style={{ display:"flex", alignItems:"center", gap:3, color:T.textMuted, fontSize:10 }}><div style={{ width:7, height:7, borderRadius:2, background:T.success+"88" }} /> 완료</div>
          <div style={{ display:"flex", alignItems:"center", gap:3, color:T.textMuted, fontSize:10 }}><div style={{ width:7, height:7, borderRadius:2, background:T.danger+"88" }} /> 기한초과</div>
        </div>
      )}
    </div>
  );
}
