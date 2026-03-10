"use client";
import { useState, useRef, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";

// ─── SUPABASE ─────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

// ─── SUPABASE 서비스 함수 ─────────────────────────────────────────────────────
// 테이블 구조:
//  accounts        : 로그인 계정 (id, username UNIQUE, display_name, pw_hash)
//  users           : 프로젝트 구성원 레코드 (id, account_id, name)
//  projects        : (id, name, topic, ..., owner_account_id, invite_code)
//  project_members : (id, project_id, user_id, account_id, role)
//  procedures      : (id, project_id, name, icon, color, order_index)
//  tasks           : (id, project_id, procedure_id, title, member_id, status, note, files)

// ── 아이디 중복 확인
async function sbCheckUsernameExists(username) {
  const { data } = await supabase
    .from("accounts").select("id").eq("username", username.trim()).maybeSingle();
  return !!data;
}

// ── 계정 조회 (username 기준)
async function sbGetAccountByUsername(username) {
  const { data, error } = await supabase
    .from("accounts").select("*").eq("username", username.trim()).maybeSingle();
  if (error) throw error;
  return data;
}

// ── 계정 생성 (username + display_name + pw_hash)
async function sbCreateAccount(username, displayName, pwHash) {
  const { data, error } = await supabase
    .from("accounts")
    .insert({ username: username.trim(), name: displayName.trim(), pw_hash: pwHash })
    .select().single();
  if (error) {
    // RLS 정책 오류인 경우 명확한 메시지 제공
    if (error.code === "42501" || error.message?.includes("row-level security")) {
      throw new Error("계정 생성 권한이 없습니다. Supabase RLS 정책을 확인해주세요.");
    }
    // 중복 username (unique constraint)
    if (error.code === "23505") {
      throw new Error("이미 사용 중인 아이디입니다.");
    }
    console.error("[sbCreateAccount] 오류:", error);
    throw new Error(error.message || "계정 생성 중 오류가 발생했습니다.");
  }
  if (!data) throw new Error("계정 생성 후 데이터를 받지 못했습니다. Supabase 연결을 확인해주세요.");
  return data;
}

// ── account에 연결된 user 레코드 조회/생성 (display_name 기준)
async function sbGetOrCreateUserForAccount(account) {
  const { data: byAcc } = await supabase
    .from("users").select("*").eq("account_id", account.id).maybeSingle();
  if (byAcc) return byAcc;

  // display_name과 같은 이름의 user가 account 미연결 상태이면 연결
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

// ── 이름으로 구성원 user 조회/생성 (account 없는 팀원)
async function sbGetOrCreateMemberByName(name) {
  const { data } = await supabase
    .from("users").select("*").eq("name", name).maybeSingle();
  if (data) return data;
  const { data: created, error } = await supabase
    .from("users").insert({ name }).select().single();
  if (error) throw error;
  return created;
}

// ── 내 프로젝트 목록
async function sbGetMyProjects(accountId) {
  const { data, error } = await supabase
    .from("project_members")
    .select(`
      project_id,
      projects (
        id, name, topic, start_date, end_date, owner_account_id, invite_code, created_at,
        procedures (
          id, name, icon, color, order_index,
          tasks ( id, procedure_id, title, member_id, status, note, files )
        ),
        project_members (
          id, user_id, account_id, role,
          users ( id, name, account_id )
        )
      )
    `)
    .eq("account_id", accountId);
  if (error) throw error;
  return data.map(d => d.projects).filter(Boolean).map(dbProjectToApp);
}

// ── DB 구조 → 앱 포맷
function dbProjectToApp(p) {
  const members = (p.project_members || []).map(pm => ({
    id: pm.user_id,
    accountId: pm.account_id || null,
    name: pm.users?.name || "",
    role: pm.role,
  }));
  const procedures = (p.procedures || [])
    .sort((a, b) => a.order_index - b.order_index)
    .map(proc => ({
      id: proc.id, name: proc.name,
      icon: proc.icon || "📌", color: proc.color || "#6366f1",
      tasks: (proc.tasks || []).map(t => ({
        id: t.id, title: t.title,
        memberId: t.member_id || "",
        memberName: members.find(m => m.id === t.member_id)?.name || "미할당",
        status: t.status || "todo", note: t.note || "", files: t.files || [],
      })),
    }));
  return {
    id: p.id, name: p.name, topic: p.topic || "",
    startDate: p.start_date || "", endDate: p.end_date || "",
    ownerAccountId: p.owner_account_id || null,
    inviteCode: p.invite_code || null,
    members, procedures,
    roles: BASE_ROLES.map(r => ({ ...r })),
    createdAt: p.created_at,
  };
}

// ── 초대 코드 생성 (6자리 대문자+숫자)
function genInviteCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

// ── 프로젝트 생성
async function sbCreateProject({ name, topic, startDate, endDate, ownerAccountId, ownerUserId, members, procedures }) {
  const inviteCode = genInviteCode();
  const { data: proj, error: pErr } = await supabase
    .from("projects")
    .insert({ name, topic, start_date: startDate || null, end_date: endDate || null, owner_account_id: ownerAccountId, invite_code: inviteCode })
    .select().single();
  if (pErr) throw pErr;

  const memberRows = members.map(m => ({
    project_id: proj.id, user_id: m.id,
    account_id: m.id === ownerUserId ? ownerAccountId : (m.account_id || null),
    role: m.id === ownerUserId ? "owner" : "member",
  }));
  if (!memberRows.find(r => r.user_id === ownerUserId)) {
    memberRows.push({ project_id: proj.id, user_id: ownerUserId, account_id: ownerAccountId, role: "owner" });
  }
  const { error: mErr } = await supabase.from("project_members").insert(memberRows);
  if (mErr) throw mErr;

  if (procedures?.length) {
    const procRows = procedures.map((p, i) => ({
      project_id: proj.id, name: p.name,
      icon: p.icon || "📌", color: p.color || "#6366f1", order_index: i,
    }));
    const { data: createdProcs, error: prErr } = await supabase.from("procedures").insert(procRows).select();
    if (prErr) throw prErr;

    const taskRows = [];
    createdProcs.forEach((proc, i) => {
      const src = procedures[i];
      const custom = src.customTasks || [];
      if (custom.length > 0) {
        custom.forEach(ct => taskRows.push({
          project_id: proj.id, procedure_id: proc.id,
          title: ct.title, member_id: ct.memberId || null, status: "todo", note: "", files: [],
        }));
      } else {
        members.forEach(m => taskRows.push({
          project_id: proj.id, procedure_id: proc.id,
          title: `${proc.name} — ${m.name}`, member_id: m.id, status: "todo", note: "", files: [],
        }));
      }
    });
    if (taskRows.length) {
      const { error: tErr } = await supabase.from("tasks").insert(taskRows);
      if (tErr) throw tErr;
    }
  }
  return proj;
}

// ── 프로젝트 정보 수정 (이름/주제/날짜)
async function sbUpdateProject(projectId, updates) {
  const dbUpdates = {};
  if (updates.name      !== undefined) dbUpdates.name       = updates.name;
  if (updates.topic     !== undefined) dbUpdates.topic      = updates.topic;
  if (updates.startDate !== undefined) dbUpdates.start_date = updates.startDate || null;
  if (updates.endDate   !== undefined) dbUpdates.end_date   = updates.endDate   || null;
  const { error } = await supabase.from("projects").update(dbUpdates).eq("id", projectId);
  if (error) throw error;
}

// ── 프로젝트 삭제 (하위 데이터 수동 삭제 → users 고아 레코드 정리 포함)
async function sbDeleteProject(projectId) {
  // 1. 이 프로젝트에만 소속된 user_id 목록 파악 (다른 프로젝트에는 없는 멤버)
  const { data: members } = await supabase
    .from("project_members").select("user_id").eq("project_id", projectId);
  const memberIds = (members || []).map(m => m.user_id);

  // 2. tasks → procedures → project_members → projects 순서로 삭제
  await supabase.from("tasks").delete().eq("project_id", projectId);
  await supabase.from("procedures").delete().eq("project_id", projectId);
  await supabase.from("project_members").delete().eq("project_id", projectId);
  const { error } = await supabase.from("projects").delete().eq("id", projectId);
  if (error) throw error;

  // 3. 다른 프로젝트에도 없는 user(account 미연결)는 users 테이블에서도 삭제
  if (memberIds.length > 0) {
    for (const userId of memberIds) {
      const { data: otherMemberships } = await supabase
        .from("project_members").select("id").eq("user_id", userId).limit(1);
      if (!otherMemberships || otherMemberships.length === 0) {
        // 계정이 연결되지 않은 순수 구성원 레코드만 삭제 (계정 있는 유저는 보존)
        await supabase.from("users").delete()
          .eq("id", userId).is("account_id", null);
      }
    }
  }
}

// ── 초대 코드로 프로젝트 조회
async function sbGetProjectByInviteCode(code) {
  const { data, error } = await supabase
    .from("projects")
    .select(`
      id, name, topic, invite_code, owner_account_id,
      project_members ( id, user_id, account_id, role, users(id, name) )
    `)
    .eq("invite_code", code.toUpperCase().trim())
    .maybeSingle();
  if (error) throw error;
  return data;
}

// ── 초대 수락: account를 project_members에 추가 (신규 구성원으로 참여)
async function sbAcceptInvite(projectId, accountId, userId) {
  // 이미 해당 project에 이 account가 있는지 확인
  const { data: existing } = await supabase
    .from("project_members")
    .select("id")
    .eq("project_id", projectId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (existing) return; // 이미 참여 중

  // user_id 기준으로 이미 있는 행이면 account_id만 연결
  const { data: byUser } = await supabase
    .from("project_members")
    .select("id, account_id")
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .maybeSingle();

  if (byUser) {
    if (!byUser.account_id) {
      await supabase.from("project_members").update({ account_id: accountId }).eq("id", byUser.id);
      await supabase.from("users").update({ account_id: accountId }).eq("id", userId);
    }
  } else {
    // 완전 신규 구성원으로 추가
    await supabase.from("project_members").insert({
      project_id: projectId, user_id: userId, account_id: accountId, role: "member",
    });
  }
}

// ── 프로젝트 구성원 제거 (오너만 가능)
async function sbRemoveMember(projectId, userId) {
  await supabase.from("project_members")
    .delete().eq("project_id", projectId).eq("user_id", userId);
}

// ── 초대 코드 재생성
async function sbRegenInviteCode(projectId) {
  const newCode = genInviteCode();
  const { error } = await supabase.from("projects").update({ invite_code: newCode }).eq("id", projectId);
  if (error) throw error;
  return newCode;
}

// 태스크 업데이트
async function sbUpdateTask(taskId, changes) {
  // files, note 등 jsonb 포함 가능
  const dbChanges = {};
  if (changes.status    !== undefined) dbChanges.status    = changes.status;
  if (changes.title     !== undefined) dbChanges.title     = changes.title;
  if (changes.note      !== undefined) dbChanges.note      = changes.note;
  if (changes.files     !== undefined) dbChanges.files     = changes.files;
  if (changes.memberId  !== undefined) dbChanges.member_id = changes.memberId || null;

  const { error } = await supabase.from("tasks").update(dbChanges).eq("id", taskId);
  if (error) throw error;
}

// 태스크 생성
async function sbCreateTask({ projectId, procedureId, title, memberId }) {
  const { data, error } = await supabase
    .from("tasks")
    .insert({
      project_id: projectId,
      procedure_id: procedureId,
      title,
      member_id: memberId || null,
      status: "todo",
      note: "",
      files: [],
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// 태스크 삭제
async function sbDeleteTask(taskId) {
  const { error } = await supabase.from("tasks").delete().eq("id", taskId);
  if (error) throw error;
}

// 절차 추가
async function sbAddProcedure({ projectId, name, icon, color, orderIndex }) {
  const { data, error } = await supabase
    .from("procedures")
    .insert({ project_id: projectId, name, icon: icon || "📌", color: color || "#6366f1", order_index: orderIndex })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// 절차 이름 수정
async function sbUpdateProcedure(procId, updates) {
  const { error } = await supabase.from("procedures").update(updates).eq("id", procId);
  if (error) throw error;
}

// 절차 삭제
async function sbDeleteProcedure(procId) {
  const { error } = await supabase.from("procedures").delete().eq("id", procId);
  if (error) throw error;
}

// 절차 순서 업데이트
async function sbUpdateProcedureOrders(procedures) {
  await Promise.all(
    procedures.map((p, i) =>
      supabase.from("procedures").update({ order_index: i }).eq("id", p.id)
    )
  );
}

// Storage 파일 업로드
async function sbUploadFile(taskId, file) {
  const path = `${taskId}/${Date.now()}_${file.name}`;
  const { error: upErr } = await supabase.storage
    .from("task-files")
    .upload(path, file, { upsert: false });
  if (upErr) throw upErr;
  const { data: urlData } = supabase.storage.from("task-files").getPublicUrl(path);
  return {
    id: uid(),
    name: file.name,
    size: file.size,
    type: file.type,
    url: urlData.publicUrl,
    path,
    uploadedAt: new Date().toLocaleString("ko-KR"),
  };
}

// ─── THEME ────────────────────────────────────────────────────────────────────
const DARK = {
  bg: "#0d0d0d", surface: "#141414", surfaceHover: "#1a1a1a",
  border: "#1f1f1f", border2: "#2a2a2a",
  text: "#f0f0f0", textSub: "#888", textMuted: "#444",
  accent: "#6366f1", accentSub: "#8b5cf6",
  success: "#10b981", warn: "#f59e0b", danger: "#ef4444",
  card: "#141414", sidebarBg: "#0f0f0f",
};
const LIGHT = {
  bg: "#f4f4f5", surface: "#ffffff", surfaceHover: "#f9f9f9",
  border: "#e4e4e7", border2: "#d4d4d8",
  text: "#18181b", textSub: "#52525b", textMuted: "#a1a1aa",
  accent: "#6366f1", accentSub: "#8b5cf6",
  success: "#059669", warn: "#d97706", danger: "#dc2626",
  card: "#ffffff", sidebarBg: "#fafafa",
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
const ST = { todo: "미진행", doing: "진행중", done: "진행완료" };
const SC = { todo: "#94a3b8", doing: "#f59e0b", done: "#10b981" };
const uid = () => Math.random().toString(36).slice(2, 9);

// ─── 비밀번호 해시 (간단 해시, 서버 인증이 없는 구조) ──────────────────────
const simpleHash = str => {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return String(h);
};

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [dark, setDark]             = useState(false);
  const T                            = dark ? DARK : LIGHT;
  const [screen, setScreen]         = useState("login");
  const [projects, setProjects]     = useState([]);
  const [active, setActive]         = useState(null);
  const [tab, setTab]               = useState("dashboard");
  const [onStep, setOnStep]         = useState(0);
  const [onData, setOnData]         = useState({});
  const [loginName, setLoginName]   = useState("");
  const [currentAccount, setCurrentAccount] = useState(null); // accounts 테이블 레코드
  const [currentUser, setCurrentUser]       = useState(null); // users 테이블 레코드
  const [toast, setToast]           = useState(null);
  const [loading, setLoading]       = useState(false);

  const notify = (msg, type = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2500);
  };

  const syncProject = (updated) => {
    setActive(updated);
    setProjects(ps => ps.map(x => x.id === updated.id ? updated : x));
  };

  // ── 로그인: username 기준 인증
  const handleLogin = async (username, pw) => {
    setLoading(true);
    try {
      const account = await sbGetAccountByUsername(username);
      if (!account) throw new Error("존재하지 않는 아이디입니다.");
      if (account.pw_hash !== simpleHash(pw)) throw new Error("아이디 또는 비밀번호가 올바르지 않습니다.");

      const user = await sbGetOrCreateUserForAccount(account);
      setCurrentAccount(account);
      setCurrentUser(user);
      setLoginName(account.name || account.username);

      const projs = await sbGetMyProjects(account.id);
      setProjects(projs);
      setScreen("projects");
      notify(`환영합니다, ${account.name || account.username}님! 👋`);
    } catch (e) {
      console.error("[handleLogin] 오류:", e);
      // LoginScreen의 catch(e) { setErr(e.message) } 로 전달
      throw e;
    } finally {
      setLoading(false);
    }
  };

  // ── 회원가입: username + displayName + pw
  const handleSignup = async (username, displayName, pw) => {
    setLoading(true);
    try {
      const exists = await sbCheckUsernameExists(username);
      if (exists) throw new Error("이미 사용 중인 아이디입니다.");

      const account = await sbCreateAccount(username, displayName, simpleHash(pw));
      const user    = await sbGetOrCreateUserForAccount(account);

      setCurrentAccount(account);
      setCurrentUser(user);
      setLoginName(account.name || account.username);

      const projs = await sbGetMyProjects(account.id);
      setProjects(projs);
      setScreen("projects");
      notify(`가입 완료! 환영합니다, ${displayName}님! 🎉`);
    } catch (e) {
      console.error("[handleSignup] 오류:", e);
      // LoginScreen의 catch로 전달하여 인라인 에러 표시
      throw e;
    } finally {
      setLoading(false);
    }
  };

  // ── 로그아웃
  const handleLogout = () => {
    setScreen("login");
    setProjects([]);
    setActive(null);
    setLoginName("");
    setCurrentAccount(null);
    setCurrentUser(null);
    setOnData({});
    setOnStep(0);
    notify("로그아웃 되었습니다.");
  };

  // ── 프로젝트 생성 (중복 이름 체크 + 본인 자동 팀원 추가)
  const handleCreateProject = async (data) => {
    if (loading) return; // 중복 제출 방지
    setLoading(true);
    try {
      const projectName = data.projectName || "새 프로젝트";

      // 동일 이름 프로젝트 중복 체크
      const dupCheck = projects.find(p => p.name.trim() === projectName.trim());
      if (dupCheck) throw new Error(`"${projectName}" 이름의 프로젝트가 이미 존재합니다.`);

      // 팀원 목록 준비
      // 본인(currentUser)을 제외한 나머지 멤버만 DB에서 조회/생성
      const rawMembers = (data.members || []).filter(m => m.name !== loginName);
      const otherUsers = await Promise.all(
        rawMembers.map(m => sbGetOrCreateMemberByName(m.name))
      );

      // 본인은 항상 맨 앞에 한 번만 추가 (이름 기반 중복 제거)
      const memberUsers = [
        { ...currentUser, account_id: currentAccount.id },
        ...otherUsers.filter(u => u.id !== currentUser.id),
      ];

      await sbCreateProject({
        name:           projectName,
        topic:          data.topic || "",
        startDate:      data.startDate || null,
        endDate:        data.endDate || null,
        ownerAccountId: currentAccount.id,
        ownerUserId:    currentUser.id,
        members:        memberUsers.map(m => ({
          ...m,
          accountId: m.id === currentUser.id ? currentAccount.id : (m.account_id || null),
        })),
        procedures: data.procedures || [],
      });

      const projs = await sbGetMyProjects(currentAccount.id);
      setProjects(projs);
      setScreen("projects");
      notify("프로젝트가 생성되었습니다! 🎉");
    } catch (e) {
      // 중복 이름 에러는 notify로 표시
      notify(e.message, "err");
    } finally {
      setLoading(false);
    }
  };

  // ── 프로젝트 삭제 (cascade + users 정리)
  const handleDeleteProject = async (id) => {
    setLoading(true);
    try {
      await sbDeleteProject(id);
      setProjects(ps => ps.filter(x => x.id !== id));
      if (active?.id === id) { setActive(null); setScreen("projects"); }
      notify("프로젝트가 삭제되었습니다.");
    } catch (e) {
      notify("삭제 실패: " + e.message, "err");
    } finally {
      setLoading(false);
    }
  };

  // ── 프로젝트 정보 수정 (이름/주제/날짜)
  const handleUpdateProject = async (id, updates) => {
    try {
      await sbUpdateProject(id, updates);
      const updated = { ...projects.find(p => p.id === id), ...updates };
      setProjects(ps => ps.map(p => p.id === id ? updated : p));
      if (active?.id === id) setActive(updated);
      notify("프로젝트 정보가 수정되었습니다.");
    } catch (e) {
      notify("수정 실패: " + e.message, "err");
    }
  };

  // ── 초대 코드로 프로젝트 참여
  const handleJoinByCode = async (code) => {
    setLoading(true);
    try {
      const proj = await sbGetProjectByInviteCode(code);
      if (!proj) throw new Error("유효하지 않은 초대 코드입니다.");
      await sbAcceptInvite(proj.id, currentAccount.id, currentUser.id);
      const projs = await sbGetMyProjects(currentAccount.id);
      setProjects(projs);
      notify("✅ 프로젝트에 참여했습니다!");
    } catch (e) {
      notify(e.message || "참여 실패", "err");
    } finally {
      setLoading(false);
    }
  };

  // ── 초대 코드 재발급
  const handleRegenCode = async (projectId) => {
    try {
      const newCode = await sbRegenInviteCode(projectId);
      const updated = projects.map(p => p.id === projectId ? { ...p, inviteCode: newCode } : p);
      setProjects(updated);
      if (active?.id === projectId) setActive(prev => ({ ...prev, inviteCode: newCode }));
      notify("초대 코드가 재발급되었습니다.");
      return newCode;
    } catch (e) {
      notify("재발급 실패: " + e.message, "err");
    }
  };

  const updateProject = p => {
    setActive(p);
    setProjects(ps => ps.map(x => x.id === p.id ? p : x));
  };

  // ── Task 핸들러들
  const handleTaskChange = async (project, procId, taskId, changes) => {
    try {
      await sbUpdateTask(taskId, changes);
      syncProject({
        ...project,
        procedures: project.procedures.map(p =>
          p.id === procId ? { ...p, tasks: p.tasks.map(t => t.id === taskId ? { ...t, ...changes } : t) } : p
        ),
      });
    } catch (e) { notify("저장 실패: " + e.message, "err"); }
  };

  const handleAddTask = async (project, procId, title) => {
    try {
      const created = await sbCreateTask({ projectId: project.id, procedureId: procId, title, memberId: null });
      const newTask = { id: created.id, title, memberId: "", memberName: "미할당", status: "todo", note: "", files: [] };
      syncProject({
        ...project,
        procedures: project.procedures.map(p => p.id === procId ? { ...p, tasks: [...p.tasks, newTask] } : p),
      });
      notify("작업이 추가되었습니다.");
    } catch (e) { notify("작업 추가 실패: " + e.message, "err"); }
  };

  const handleDeleteTask = async (project, procId, taskId) => {
    try {
      await sbDeleteTask(taskId);
      syncProject({
        ...project,
        procedures: project.procedures.map(p =>
          p.id === procId ? { ...p, tasks: p.tasks.filter(t => t.id !== taskId) } : p
        ),
      });
      notify("작업이 삭제되었습니다.");
    } catch (e) { notify("삭제 실패: " + e.message, "err"); }
  };

  const handleAddProcedure = async (project, name) => {
    try {
      const created = await sbAddProcedure({ projectId: project.id, name: name || "새 단계", icon: "📌", color: "#6366f1", orderIndex: project.procedures.length });
      const newProc = { id: created.id, name: created.name, icon: created.icon, color: created.color, tasks: [] };
      syncProject({ ...project, procedures: [...project.procedures, newProc] });
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
      try {
        uploaded = await Promise.all(files.map(f => sbUploadFile(task.id, f)));
      } catch {
        uploaded = files.map(f => ({ id: uid(), name: f.name, size: f.size, type: f.type, url: URL.createObjectURL(f), uploadedAt: new Date().toLocaleString("ko-KR") }));
      }
      const newFiles = [...(task.files || []), ...uploaded];
      await sbUpdateTask(task.id, { files: newFiles });
      syncProject({
        ...project,
        procedures: project.procedures.map(p =>
          p.id === procId ? { ...p, tasks: p.tasks.map(t => t.id === task.id ? { ...t, files: newFiles } : t) } : p
        ),
      });
      notify(`📎 ${files.length}개 파일이 첨부되었습니다.`);
      return newFiles;
    } catch (e) {
      notify("파일 업로드 실패: " + e.message, "err");
      return task.files || [];
    }
  };

  // ── 로딩 오버레이 (인증 화면 제외 — LoginScreen은 자체 busy 상태 사용)
  if (loading && screen !== "login") return (
    <div style={{ minHeight: "100vh", background: (dark ? DARK : LIGHT).bg,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'Pretendard','Apple SD Gothic Neo',sans-serif" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>⚙️</div>
        <p style={{ color: (dark ? DARK : LIGHT).textSub, fontSize: 14 }}>로딩 중...</p>
      </div>
    </div>
  );

  if (screen === "login") return (
    <LoginScreen T={T} dark={dark} setDark={setDark}
      onLogin={handleLogin} onSignup={handleSignup} globalLoading={loading} />
  );
  if (screen === "onboard") return (
    <OnboardScreen T={T} step={onStep} data={onData} setData={setOnData} loginName={loginName} loading={loading}
      onNext={() => { if (onStep < 4) { setOnStep(s => s + 1); return; } if (!loading) handleCreateProject(onData); }}
      onBack={() => { if (onStep === 0) setScreen("projects"); else setOnStep(s => s - 1); }} />
  );
  if (screen === "project" && active) return (
    <ProjectScreen T={T} dark={dark} setDark={setDark}
      project={active} tab={tab} setTab={setTab}
      loginName={loginName} currentAccount={currentAccount}
      onUpdate={updateProject}
      onUpdateProject={(updates) => handleUpdateProject(active.id, updates)}
      onDeleteProject={() => handleDeleteProject(active.id)}
      onRegenCode={() => handleRegenCode(active.id)}
      onTaskChange={(procId, taskId, ch) => handleTaskChange(active, procId, taskId, ch)}
      onAddTask={(procId, title) => handleAddTask(active, procId, title)}
      onDeleteTask={(procId, taskId) => handleDeleteTask(active, procId, taskId)}
      onAddProcedure={(name) => handleAddProcedure(active, name)}
      onUpdateProcedure={(procId, upd) => handleUpdateProcedure(active, procId, upd)}
      onDeleteProcedure={(procId) => handleDeleteProcedure(active, procId)}
      onReorderProcedures={(procs) => handleReorderProcedures(active, procs)}
      onFileUpload={(procId, task, files) => handleFileUpload(active, procId, task, files)}
      notify={notify}
      onBack={() => setScreen("projects")} />
  );
  return (
    <ProjectsScreen T={T} dark={dark} setDark={setDark}
      projects={projects} loginName={loginName} currentAccount={currentAccount}
      toast={toast} notify={notify}
      onOpen={p => { setActive(p); setTab("dashboard"); setScreen("project"); }}
      onNew={() => { setOnStep(0); setOnData({}); setScreen("onboard"); }}
      onDelete={handleDeleteProject}
      onJoinByCode={handleJoinByCode}
      onLogout={handleLogout} />
  );
}

// ─── SHARED ───────────────────────────────────────────────────────────────────
const Toast = ({ T, toast }) => toast ? (
  <div style={{
    position: "fixed", top: 20, right: 20, zIndex: 9999,
    padding: "11px 18px", borderRadius: 10, fontSize: 13, fontWeight: 600,
    background: toast.type === "ok"
      ? (T === DARK ? "#0a1a0a" : "#f0fdf4")
      : (T === DARK ? "#1a0a0a" : "#fef2f2"),
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
    width: 32, height: 32, borderRadius: 8,
    background: T.surfaceHover, border: `1px solid ${T.border2}`, cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center", color: T.textSub,
  }}>
    <SVG d={dark ? I.sun : I.moon} size={14} />
  </button>
);

const Inp = ({ T, value, onChange, placeholder, type = "text", style = {} }) => (
  <input type={type} value={value} onChange={onChange} placeholder={placeholder}
    style={{
      width: "100%", padding: "10px 14px", background: T.surfaceHover,
      border: `1px solid ${T.border2}`, borderRadius: 8, color: T.text,
      fontSize: 13, outline: "none", boxSizing: "border-box", fontFamily: "inherit", ...style,
    }} />
);

// ─── LOGIN ────────────────────────────────────────────────────────────────────
function LoginScreen({ T, dark, setDark, onLogin, onSignup, globalLoading = false }) {
  const [mode, setMode]               = useState("login");
  // 로그인 필드
  const [loginId, setLoginId]         = useState("");
  const [loginPw, setLoginPw]         = useState("");
  // 회원가입 필드
  const [signupId, setSignupId]       = useState("");
  const [signupName, setSignupName]   = useState("");
  const [signupPw, setSignupPw]       = useState("");
  const [signupPwC, setSignupPwC]     = useState("");
  // 아이디 중복확인
  const [idChecked, setIdChecked]     = useState(false);   // 중복확인 완료 여부
  const [idAvail, setIdAvail]         = useState(null);    // true=사용가능 false=중복
  const [idChecking, setIdChecking]   = useState(false);
  // 공통
  const [showPw, setShowPw]           = useState(false);
  const [err, setErr]                 = useState("");
  const [busy, setBusy]               = useState(false);

  // globalLoading이 false로 바뀌어도 err는 유지 (LoginScreen이 언마운트되지 않으므로 안전)
  const isDisabled = busy || globalLoading;

  const EYE_ON  = "M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19M1 1l22 22M10.73 10.73A3 3 0 0013.27 13.27";
  const EYE_OFF = "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 9a3 3 0 100 6 3 3 0 000-6z";

  const inputStyle = {
    width: "100%", padding: "10px 14px", background: T.surfaceHover,
    border: `1px solid ${T.border2}`, borderRadius: 9, color: T.text,
    fontSize: 13, outline: "none", boxSizing: "border-box", fontFamily: "inherit",
    marginBottom: 10, transition: "border-color .2s",
  };
  const onFocus = e => e.target.style.borderColor = T.accent;
  const onBlur  = e => e.target.style.borderColor = T.border2;

  const Label = ({ children }) => (
    <label style={{ display: "block", color: T.textSub, fontSize: 11, fontWeight: 700,
      marginBottom: 5, textTransform: "uppercase", letterSpacing: .5 }}>{children}</label>
  );

  // 아이디 중복 확인
  const checkId = async () => {
    if (!signupId.trim()) { setErr("아이디를 입력해주세요."); return; }
    if (signupId.trim().length < 3) { setErr("아이디는 3자 이상이어야 합니다."); return; }
    setIdChecking(true); setErr("");
    try {
      const exists = await sbCheckUsernameExists(signupId.trim());
      setIdAvail(!exists);
      setIdChecked(true);
      if (exists) setErr("이미 사용 중인 아이디입니다.");
    } catch {
      setErr("중복 확인 중 오류가 발생했습니다.");
    } finally {
      setIdChecking(false);
    }
  };

  // 아이디 변경 시 중복확인 초기화
  const onSignupIdChange = (v) => {
    setSignupId(v);
    setIdChecked(false);
    setIdAvail(null);
    setErr("");
  };

  const goLogin = async () => {
    setErr("");
    if (!loginId.trim()) { setErr("아이디를 입력해주세요."); return; }
    if (!loginPw)        { setErr("비밀번호를 입력해주세요."); return; }
    setBusy(true);
    try {
      await onLogin(loginId.trim(), loginPw);
    } catch (e) {
      // Supabase 네트워크 오류 등 특수 케이스 처리
      if (e.message?.includes("Failed to fetch") || e.message?.includes("NetworkError")) {
        setErr("서버에 연결할 수 없습니다. 인터넷 연결을 확인해주세요.");
      } else {
        setErr(e.message || "아이디 또는 비밀번호가 올바르지 않습니다.");
      }
    } finally {
      setBusy(false);
    }
  };

  const goSignup = async () => {
    setErr("");
    if (!signupId.trim())   { setErr("아이디를 입력해주세요."); return; }
    if (!idChecked)         { setErr("아이디 중복 확인을 해주세요."); return; }
    if (!idAvail)           { setErr("이미 사용 중인 아이디입니다."); return; }
    if (!signupName.trim()) { setErr("이름을 입력해주세요."); return; }
    if (signupPw.length < 4){ setErr("비밀번호는 4자 이상이어야 합니다."); return; }
    if (signupPw !== signupPwC){ setErr("비밀번호가 일치하지 않습니다."); return; }
    setBusy(true);
    try {
      await onSignup(signupId.trim(), signupName.trim(), signupPw);
    } catch (e) {
      if (e.message?.includes("Failed to fetch") || e.message?.includes("NetworkError")) {
        setErr("서버에 연결할 수 없습니다. 인터넷 연결을 확인해주세요.");
      } else {
        setErr(e.message || "회원가입 중 오류가 발생했습니다.");
      }
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (m) => {
    setMode(m); setErr("");
    setLoginId(""); setLoginPw("");
    setSignupId(""); setSignupName(""); setSignupPw(""); setSignupPwC("");
    setIdChecked(false); setIdAvail(null);
  };

  return (
    <div style={{ minHeight: "100vh", background: T.bg, display: "flex", alignItems: "center",
      justifyContent: "center", fontFamily: "'Pretendard','Apple SD Gothic Neo',sans-serif" }}>
      <div style={{ position: "absolute", top: 20, right: 20 }}>
        <ThemeToggle T={T} dark={dark} setDark={setDark} />
      </div>
      <div style={{ width: 420, padding: "44px 40px", background: T.surface,
        borderRadius: 24, border: `1px solid ${T.border}`,
        boxShadow: dark ? "0 32px 80px rgba(0,0,0,.6)" : "0 8px 48px rgba(0,0,0,.1)" }}>
        <div style={{ width: 52, height: 52, background: `linear-gradient(135deg,${T.accent},${T.accentSub})`,
          borderRadius: 14, margin: "0 auto 18px", display: "flex",
          alignItems: "center", justifyContent: "center", fontSize: 24 }}>🚀</div>
        <h1 style={{ color: T.text, fontSize: 24, fontWeight: 800, textAlign: "center", marginBottom: 4 }}>ProjFlow</h1>
        <p style={{ color: T.textSub, fontSize: 12, textAlign: "center", marginBottom: 28 }}>팀 프로젝트를 스마트하게 관리하세요</p>

        {/* 탭 */}
        <div style={{ display: "flex", background: T.surfaceHover, borderRadius: 10,
          padding: 3, marginBottom: 24, border: `1px solid ${T.border}` }}>
          {[["login","로그인"],["signup","회원가입"]].map(([m, label]) => (
            <button key={m} onClick={() => switchMode(m)}
              style={{ flex: 1, padding: "8px 0", border: "none", borderRadius: 8, cursor: "pointer",
                fontFamily: "inherit", fontSize: 13, fontWeight: 700, transition: "all .2s",
                background: mode === m ? T.surface : "transparent",
                color: mode === m ? T.text : T.textMuted,
                boxShadow: mode === m ? "0 1px 4px rgba(0,0,0,.12)" : "none" }}>
              {label}
            </button>
          ))}
        </div>

        {/* ── 로그인 폼 ── */}
        {mode === "login" && (
          <>
            <Label>아이디</Label>
            <input value={loginId} onChange={e => { setLoginId(e.target.value); setErr(""); }}
              onKeyDown={e => e.key === "Enter" && goLogin()} onFocus={onFocus} onBlur={onBlur}
              placeholder="아이디 입력" style={inputStyle} />

            <Label>비밀번호</Label>
            <div style={{ position: "relative", marginBottom: 10 }}>
              <input type={showPw ? "text" : "password"} value={loginPw}
                onChange={e => { setLoginPw(e.target.value); setErr(""); }}
                onKeyDown={e => e.key === "Enter" && goLogin()} onFocus={onFocus} onBlur={onBlur}
                placeholder="비밀번호 입력"
                style={{ ...inputStyle, marginBottom: 0, paddingRight: 42 }} />
              <button onClick={() => setShowPw(v => !v)}
                style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
                  background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 2 }}>
                <SVG d={showPw ? EYE_ON : EYE_OFF} size={15} />
              </button>
            </div>
          </>
        )}

        {/* ── 회원가입 폼 ── */}
        {mode === "signup" && (
          <>
            <Label>아이디</Label>
            <div style={{ display: "flex", gap: 7, marginBottom: 10 }}>
              <input value={signupId}
                onChange={e => onSignupIdChange(e.target.value)}
                onKeyDown={e => e.key === "Enter" && checkId()}
                onFocus={onFocus} onBlur={onBlur}
                placeholder="영문/숫자 3자 이상"
                style={{ ...inputStyle, marginBottom: 0, flex: 1,
                  borderColor: idChecked ? (idAvail ? T.success : T.danger) : T.border2 }} />
              <button onClick={checkId} disabled={idChecking}
                style={{ padding: "10px 14px", background: idChecked && idAvail ? T.success : T.accent,
                  border: "none", borderRadius: 9, color: "#fff", fontSize: 12, fontWeight: 700,
                  cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap", flexShrink: 0 }}>
                {idChecking ? "확인 중..." : idChecked && idAvail ? "✓ 사용가능" : "중복확인"}
              </button>
            </div>
            {idChecked && idAvail && (
              <p style={{ color: T.success, fontSize: 11, marginBottom: 8, marginTop: -6 }}>✅ 사용 가능한 아이디입니다.</p>
            )}

            <Label>이름 (표시 이름)</Label>
            <input value={signupName} onChange={e => { setSignupName(e.target.value); setErr(""); }}
              onFocus={onFocus} onBlur={onBlur}
              placeholder="홍길동" style={inputStyle} />

            <Label>비밀번호</Label>
            <div style={{ position: "relative", marginBottom: 10 }}>
              <input type={showPw ? "text" : "password"} value={signupPw}
                onChange={e => { setSignupPw(e.target.value); setErr(""); }}
                onFocus={onFocus} onBlur={onBlur}
                placeholder="4자 이상 입력"
                style={{ ...inputStyle, marginBottom: 0, paddingRight: 42 }} />
              <button onClick={() => setShowPw(v => !v)}
                style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
                  background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 2 }}>
                <SVG d={showPw ? EYE_ON : EYE_OFF} size={15} />
              </button>
            </div>

            <Label>비밀번호 확인</Label>
            <div style={{ position: "relative", marginBottom: 10 }}>
              <input type={showPw ? "text" : "password"} value={signupPwC}
                onChange={e => { setSignupPwC(e.target.value); setErr(""); }}
                onFocus={onFocus} onBlur={onBlur}
                placeholder="비밀번호 재입력"
                style={{ ...inputStyle, marginBottom: 0, paddingRight: 42,
                  borderColor: signupPwC && signupPw !== signupPwC ? T.danger : T.border2 }} />
              {signupPwC && (
                <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
                  fontSize: 14, color: signupPw === signupPwC ? T.success : T.danger }}>
                  {signupPw === signupPwC ? "✓" : "✗"}
                </span>
              )}
            </div>
          </>
        )}

        {/* 에러 메시지 */}
        {err && (
          <div style={{ padding: "10px 14px", background: `${T.danger}12`,
            border: `1px solid ${T.danger}44`, borderRadius: 9,
            color: T.danger, fontSize: 12, marginBottom: 12, fontWeight: 600 }}>
            ⚠️ {err}
          </div>
        )}

        <button
          onClick={mode === "login" ? goLogin : goSignup}
          disabled={isDisabled}
          style={{
            width: "100%", padding: "12px 0", border: "none", borderRadius: 10, cursor: isDisabled ? "default" : "pointer",
            marginTop: 4,
            background: isDisabled ? T.border2 : `linear-gradient(135deg,${T.accent},${T.accentSub})`,
            color: isDisabled ? T.textMuted : "#fff", fontSize: 14, fontWeight: 700,
            fontFamily: "inherit", transition: "all .2s",
          }}>
          {(busy || globalLoading) ? "처리 중..." : mode === "login" ? "로그인" : "회원가입"}
        </button>

        <p style={{ color: T.textMuted, fontSize: 11, textAlign: "center", marginTop: 18 }}>
          {mode === "login" ? "계정이 없으신가요?" : "이미 계정이 있으신가요?"}
          {" "}
          <button onClick={() => switchMode(mode === "login" ? "signup" : "login")}
            style={{ background: "none", border: "none", color: T.accent, fontSize: 11,
              fontWeight: 700, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>
            {mode === "login" ? "회원가입" : "로그인"}
          </button>
        </p>
      </div>
    </div>
  );
}

// ─── PROJECTS LIST ────────────────────────────────────────────────────────────
function ProjectsScreen({ T, dark, setDark, projects, loginName, currentAccount, toast, onOpen, onNew, onDelete, notify, onJoinByCode, onLogout }) {
  const [joinCode, setJoinCode] = useState("");
  const [joiningErr, setJoiningErr] = useState("");
  const [joining, setJoining] = useState(false);

  const handleJoin = async () => {
    if (!joinCode.trim()) return;
    setJoiningErr("");
    setJoining(true);
    try {
      await onJoinByCode(joinCode.trim());
      setJoinCode("");
    } catch (e) {
      setJoiningErr(e.message || "참여 실패");
    } finally {
      setJoining(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: T.bg, display: "flex",
      fontFamily: "'Pretendard','Apple SD Gothic Neo',sans-serif" }}>
      <Toast T={T} toast={toast} />
      <Sidebar T={T} dark={dark} setDark={setDark} loginName={loginName}
        activeItem="home" items={[{ id: "home", icon: "🏠", label: "프로젝트 목록" }]}
        onLogout={onLogout} />
      <div style={{ marginLeft: 220, flex: 1, padding: "40px 48px" }}>

        {/* ── 헤더 ── */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
          <div>
            <h1 style={{ color: T.text, fontSize: 26, fontWeight: 800, marginBottom: 4 }}>프로젝트 목록</h1>
            <p style={{ color: T.textSub, fontSize: 13 }}>총 {projects.length}개의 프로젝트</p>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={onNew} style={{ display: "flex", alignItems: "center", gap: 7,
              padding: "9px 18px", background: `linear-gradient(135deg,${T.accent},${T.accentSub})`,
              border: "none", borderRadius: 9, color: "#fff", fontSize: 13, fontWeight: 700,
              cursor: "pointer", fontFamily: "inherit" }}>
              <SVG d={I.plus} size={13} /> 새 프로젝트
            </button>
          </div>
        </div>

        {/* ── 초대 코드로 참여 ── */}
        <div style={{ marginBottom: 28, padding: "18px 22px",
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14 }}>
          <p style={{ color: T.text, fontSize: 13, fontWeight: 700, marginBottom: 10 }}>🔗 초대 코드로 프로젝트 참여</p>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={joinCode}
              onChange={e => { setJoinCode(e.target.value.toUpperCase()); setJoiningErr(""); }}
              onKeyDown={e => e.key === "Enter" && handleJoin()}
              placeholder="초대 코드 6자리 입력 (예: AB3X7Z)"
              style={{ flex: 1, padding: "9px 14px", background: T.surfaceHover,
                border: `1px solid ${joiningErr ? T.danger : T.border2}`, borderRadius: 8,
                color: T.text, fontSize: 13, outline: "none", fontFamily: "inherit",
                letterSpacing: 3, fontWeight: 700 }}
            />
            <button onClick={handleJoin} disabled={!joinCode.trim() || joining}
              style={{ padding: "9px 20px", background: joinCode.trim() ? T.accent : T.border2,
                border: "none", borderRadius: 8, color: joinCode.trim() ? "#fff" : T.textMuted,
                fontSize: 13, fontWeight: 700, cursor: joinCode.trim() ? "pointer" : "default",
                fontFamily: "inherit" }}>
              {joining ? "참여 중..." : "참여하기"}
            </button>
          </div>
          {joiningErr && <p style={{ color: T.danger, fontSize: 12, marginTop: 7 }}>❌ {joiningErr}</p>}
        </div>

        {/* ── 프로젝트 목록 ── */}
        {projects.length === 0 ? (
          <div style={{ textAlign: "center", padding: "80px 40px", background: T.surface,
            borderRadius: 20, border: `2px dashed ${T.border2}` }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>🚀</div>
            <h2 style={{ color: T.text, fontSize: 18, fontWeight: 700, marginBottom: 8 }}>첫 프로젝트를 시작해볼까요?</h2>
            <p style={{ color: T.textSub, fontSize: 13, marginBottom: 24 }}>새 프로젝트를 만들거나 초대 코드로 팀에 합류하세요.</p>
            <button onClick={onNew} style={{ padding: "11px 28px",
              background: `linear-gradient(135deg,${T.accent},${T.accentSub})`,
              border: "none", borderRadius: 10, color: "#fff", fontSize: 14,
              fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
              지금 시작하기
            </button>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 16 }}>
            {projects.map(p => (
              <ProjCard key={p.id} T={T} project={p} currentAccount={currentAccount}
                onClick={() => onOpen(p)} onDelete={() => onDelete(p.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Sidebar({ T, dark, setDark, loginName, activeItem, items, extra, onItemClick, projectInfo, onLogout }) {
  return (
    <div style={{ width: 220, background: T.sidebarBg, borderRight: `1px solid ${T.border}`,
      padding: "24px 0", display: "flex", flexDirection: "column",
      position: "fixed", top: 0, bottom: 0, left: 0, zIndex: 50 }}>
      <div style={{ padding: "0 16px 18px", borderBottom: `1px solid ${T.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: extra ? 12 : 0 }}>
          <div style={{ width: 30, height: 30, background: `linear-gradient(135deg,${T.accent},${T.accentSub})`,
            borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15 }}>🚀</div>
          <span style={{ color: T.text, fontWeight: 800, fontSize: 14 }}>ProjFlow</span>
        </div>
        {extra}
      </div>
      {projectInfo && (
        <div style={{ padding: "12px 8px", borderBottom: `1px solid ${T.border}` }}>
          <div style={{ padding: "9px 10px", background: `${T.accent}12`, borderRadius: 9, border: `1px solid ${T.accent}33` }}>
            <p style={{ color: T.accent, fontSize: 12, fontWeight: 700, marginBottom: 3 }}>{projectInfo.name}</p>
            <div style={{ background: T.border2, borderRadius: 100, height: 2 }}>
              <div style={{ width: `${projectInfo.pct}%`, height: "100%", background: T.accent, borderRadius: 100 }} />
            </div>
            <p style={{ color: T.textMuted, fontSize: 10, marginTop: 3 }}>{projectInfo.pct}% 완료</p>
          </div>
        </div>
      )}
      <div style={{ padding: "12px 8px", flex: 1 }}>
        {items.map(it => (
          <SideItem key={it.id} T={T} icon={it.icon} label={it.label}
            active={activeItem === it.id} onClick={() => onItemClick && onItemClick(it.id)} />
        ))}
      </div>
      <div style={{ padding: "12px 14px", borderTop: `1px solid ${T.border}` }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 26, height: 26, borderRadius: "50%", background: T.accent,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 11, color: "#fff", fontWeight: 700, flexShrink: 0 }}>
              {(loginName || "?")[0]}
            </div>
            <span style={{ color: T.textSub, fontSize: 12, fontWeight: 600,
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 90 }}>{loginName}</span>
          </div>
          <ThemeToggle T={T} dark={dark} setDark={setDark} />
        </div>
        {onLogout && (
          <button onClick={onLogout}
            style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              padding: "7px 0", background: "transparent", border: `1px solid ${T.border2}`,
              borderRadius: 8, color: T.textSub, fontSize: 12, fontWeight: 600,
              cursor: "pointer", fontFamily: "inherit", transition: "all .15s" }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = T.danger; e.currentTarget.style.color = T.danger; e.currentTarget.style.background = `${T.danger}10`; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = T.border2; e.currentTarget.style.color = T.textSub; e.currentTarget.style.background = "transparent"; }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
            </svg>
            로그아웃
          </button>
        )}
      </div>
    </div>
  );
}

function ProjCard({ T, project, currentAccount, onClick, onDelete }) {
  const total   = project.procedures.reduce((a, s) => a + s.tasks.length, 0);
  const done    = project.procedures.reduce((a, s) => a + s.tasks.filter(t => t.status === "done").length, 0);
  const pct     = total ? Math.round(done / total * 100) : 0;
  const isOwner = currentAccount && project.ownerAccountId === currentAccount.id;
  const [hov, setHov]         = useState(false);
  const [confirm, setConfirm] = useState(false); // 삭제 확인 모달

  return (
    <div style={{ position: "relative" }}>
      {/* ── 삭제 확인 모달 오버레이 ── */}
      {confirm && (
        <div onClick={e => e.stopPropagation()}
          style={{ position: "absolute", inset: 0, zIndex: 10, borderRadius: 16,
            background: T.surface, border: `2px solid ${T.danger}55`,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            padding: "24px 20px", boxShadow: `0 8px 32px ${T.danger}22` }}>
          <div style={{ fontSize: 28, marginBottom: 10 }}>⚠️</div>
          <p style={{ color: T.text, fontSize: 13, fontWeight: 700, textAlign: "center", marginBottom: 6 }}>
            프로젝트를 삭제할까요?
          </p>
          <p style={{ color: T.textSub, fontSize: 11, textAlign: "center", marginBottom: 18, lineHeight: 1.5 }}>
            <strong style={{ color: T.danger }}>{project.name}</strong>의<br/>
            모든 작업, 절차, 구성원 데이터가<br/>영구적으로 삭제됩니다.
          </p>
          <div style={{ display: "flex", gap: 8, width: "100%" }}>
            <button onClick={() => setConfirm(false)}
              style={{ flex: 1, padding: "8px 0", background: T.surfaceHover,
                border: `1px solid ${T.border2}`, borderRadius: 8, color: T.textSub,
                fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
              취소
            </button>
            <button onClick={() => { setConfirm(false); onDelete(); }}
              style={{ flex: 1, padding: "8px 0", background: T.danger, border: "none",
                borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700,
                cursor: "pointer", fontFamily: "inherit" }}>
              삭제
            </button>
          </div>
        </div>
      )}

      <div onClick={onClick} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{ background: T.card, border: `1px solid ${hov ? T.accent : T.border}`,
          borderRadius: 16, padding: 22, cursor: "pointer", position: "relative",
          transition: "all .2s", transform: hov ? "translateY(-2px)" : "translateY(0)",
          boxShadow: hov ? `0 8px 32px ${T.accent}22` : "none" }}>
        {/* 오너만 삭제 버튼 표시 */}
        {isOwner && (
          <button onClick={e => { e.stopPropagation(); setConfirm(true); }}
            style={{ position: "absolute", top: 12, right: 12, width: 28, height: 28,
              background: "transparent", border: "none", borderRadius: 6,
              color: T.textMuted, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
            onMouseEnter={e => { e.currentTarget.style.color = T.danger; e.currentTarget.style.background = `${T.danger}15`; }}
            onMouseLeave={e => { e.currentTarget.style.color = T.textMuted; e.currentTarget.style.background = "transparent"; }}>
            <SVG d={I.trash} size={13} />
          </button>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 26 }}>📁</span>
          <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 100, fontWeight: 700,
            background: isOwner ? `${T.accent}15` : `${T.success}12`,
            color: isOwner ? T.accent : T.success }}>
            {isOwner ? "오너" : "구성원"}
          </span>
        </div>
        <h3 style={{ color: T.text, fontSize: 15, fontWeight: 700, marginBottom: 3 }}>{project.name}</h3>
        <p style={{ color: T.textMuted, fontSize: 12, marginBottom: 14,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{project.topic || "대주제 미설정"}</p>
        <div style={{ background: T.border, borderRadius: 100, height: 3, marginBottom: 6 }}>
          <div style={{ width: `${pct}%`, height: "100%",
            background: `linear-gradient(90deg,${T.accent},${T.accentSub})`,
            borderRadius: 100, transition: "width .6s" }} />
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
function OnboardScreen({ T, step, data, setData, onNext, onBack, loginName, loading = false }) {
  const steps = ["프로젝트 이름", "팀원 설정", "대주제 설정", "절차 선택", "역할 분담"];
  return (
    <div style={{ minHeight: "100vh", background: T.bg, display: "flex",
      fontFamily: "'Pretendard','Apple SD Gothic Neo',sans-serif" }}>
      <div style={{ width: 260, background: T.sidebarBg, borderRight: `1px solid ${T.border}`,
        padding: "40px 24px", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 40 }}>
          <div style={{ width: 30, height: 30, background: `linear-gradient(135deg,${T.accent},${T.accentSub})`,
            borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15 }}>🚀</div>
          <span style={{ color: T.text, fontWeight: 800, fontSize: 14 }}>ProjFlow</span>
        </div>
        <p style={{ color: T.textMuted, fontSize: 10, marginBottom: 14, textTransform: "uppercase", letterSpacing: 1 }}>설정 단계</p>
        {steps.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 10px",
            borderRadius: 8, marginBottom: 2, background: i === step ? `${T.accent}15` : "transparent" }}>
            <div style={{ width: 22, height: 22, borderRadius: "50%",
              background: i < step ? T.accent : i === step ? T.accent : T.border2,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 10, color: "#fff", fontWeight: 700, flexShrink: 0 }}>
              {i < step ? "✓" : i + 1}
            </div>
            <span style={{ color: i <= step ? T.text : T.textMuted, fontSize: 13, fontWeight: i === step ? 700 : 400 }}>{s}</span>
          </div>
        ))}
      </div>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 48 }}>
        <div style={{ width: "100%", maxWidth: 640 }}>
          {step === 0 && <OStep1 T={T} data={data} setData={setData} loginName={loginName} />}
          {step === 1 && <OStep2 T={T} data={data} setData={setData} loginName={loginName} />}
          {step === 2 && <OStep3 T={T} data={data} setData={setData} />}
          {step === 3 && <OStep4 T={T} data={data} setData={setData} />}
          {step === 4 && <OStep5 T={T} data={data} setData={setData} />}
          <div style={{ display: "flex", gap: 10, marginTop: 28 }}>
            <button onClick={onBack} disabled={loading} style={{ padding: "11px 24px", background: T.surfaceHover,
              border: `1px solid ${T.border2}`, borderRadius: 8, color: T.textSub,
              fontSize: 13, cursor: loading ? "default" : "pointer", fontFamily: "inherit", fontWeight: 600 }}>← 이전</button>
            <button onClick={onNext} disabled={loading} style={{ flex: 1, padding: "11px 24px", border: "none",
              borderRadius: 8, background: loading ? T.border2 : `linear-gradient(135deg,${T.accent},${T.accentSub})`,
              color: loading ? T.textMuted : "#fff", fontSize: 13, fontWeight: 700,
              cursor: loading ? "default" : "pointer", fontFamily: "inherit" }}>
              {loading && step === 4 ? "생성 중..." : step === 4 ? "🚀 프로젝트 생성" : "다음 →"}
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
  return (
    <div>
      <SH T={T} n={1} title={`안녕하세요, ${loginName}님! 👋`} sub="프로젝트 이름과 기간을 설정해주세요." />
      <label style={{ display: "block", color: T.textSub, fontSize: 12, marginBottom: 6, fontWeight: 600 }}>프로젝트 이름</label>
      <Inp T={T} value={data.projectName || ""} onChange={e => setData(d => ({ ...d, projectName: e.target.value }))}
        placeholder="예: 스마트 환경 모니터링 시스템" style={{ marginBottom: 18 }} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        {[["시작일","startDate"],["종료일","endDate"]].map(([label, key]) => (
          <div key={key}>
            <label style={{ display: "block", color: T.textSub, fontSize: 12, marginBottom: 6, fontWeight: 600 }}>{label}</label>
            <Inp T={T} type="date" value={data[key] || ""} onChange={e => setData(d => ({ ...d, [key]: e.target.value }))} />
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

  // useEffect + 함수형 업데이트로 StrictMode 이중 실행 문제 해결:
  // setData의 콜백 안에서 최신 d.members를 직접 읽으므로,
  // StrictMode가 useEffect를 2번 실행해도 이미 본인이 있으면 추가하지 않음.
  useEffect(() => {
    setData(d => {
      const cur = d.members || [];
      if (cur.some(m => m.name === myName)) return d; // 이미 있으면 변경 없음
      return { ...d, members: [{ id: "self", name: myName }, ...cur] };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const add = () => {
    const name = inp.trim();
    if (!name) return;
    if (name === myName) { setInp(""); return; }
    if (members.some(m => m.name === name)) { setInp(""); return; }
    setData(d => ({ ...d, members: [...(d.members || []), { id: uid(), name }] }));
    setInp("");
  };

  const remove = (id) => {
    setData(d => ({ ...d, members: (d.members || []).filter(m => m.id !== id) }));
  };

  return (
    <div>
      <SH T={T} n={2} title="팀원을 추가하세요 👥" sub="나는 자동으로 포함됩니다. 나머지 팀원 이름을 추가하세요." />
      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <input value={inp} onChange={e => setInp(e.target.value)}
          onKeyDown={e => e.key === "Enter" && add()}
          placeholder="팀원 이름 입력 후 Enter"
          style={{ flex: 1, padding: "10px 14px", background: T.surfaceHover, border: `1px solid ${T.border2}`,
            borderRadius: 8, color: T.text, fontSize: 13, outline: "none", fontFamily: "inherit" }} />
        <button onClick={add} style={{ padding: "10px 18px", background: T.accent, border: "none",
          borderRadius: 8, color: "#fff", fontSize: 13, cursor: "pointer", fontWeight: 700, fontFamily: "inherit" }}>추가</button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {members.map(m => {
          const isSelf = m.name === myName;
          return (
            <span key={m.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px 4px 5px",
              background: isSelf ? `${T.accent}25` : `${T.accent}15`,
              border: `1px solid ${isSelf ? T.accent : T.accent + "44"}`, borderRadius: 100,
              color: T.accent, fontSize: 12 }}>
              <span style={{ width: 20, height: 20, borderRadius: "50%", background: isSelf ? T.accent : T.accentSub,
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                color: "#fff", fontSize: 10, fontWeight: 700, flexShrink: 0 }}>{m.name[0]}</span>
              {m.name}
              {isSelf
                ? <span style={{ fontSize: 9, color: T.accent, fontWeight: 700, marginLeft: 2 }}>나</span>
                : <button onClick={() => remove(m.id)}
                    style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0, lineHeight: 1 }}>×</button>
              }
            </span>
          );
        })}
      </div>
    </div>
  );
}

function OStep3({ T, data, setData }) {
  const [ideaInp, setIdeaInp] = useState("");
  const ideas = data.ideas || [];
  const addIdea = () => {
    if (!ideaInp.trim()) return;
    setData(d => ({ ...d, ideas: [...(d.ideas || []), { id: uid(), text: ideaInp.trim() }] }));
    setIdeaInp("");
  };
  return (
    <div>
      <SH T={T} n={3} title="대주제를 설정하세요 💡" sub="아이디어를 모아 워싱한 뒤, 최종 대주제를 선택하거나 직접 입력하세요." />
      <div style={{ background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 12, padding: "14px 16px", marginBottom: 20 }}>
        <p style={{ color: T.text, fontSize: 12, fontWeight: 700, marginBottom: 10 }}>💭 아이디어 워싱</p>
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <input value={ideaInp} onChange={e => setIdeaInp(e.target.value)}
            onKeyDown={e => e.key === "Enter" && addIdea()}
            placeholder="주제 아이디어 입력 후 Enter"
            style={{ flex: 1, padding: "10px 13px", background: T.surface, border: `1px solid ${T.border2}`,
              borderRadius: 8, color: T.text, fontSize: 13, outline: "none", fontFamily: "inherit" }} />
          <button onClick={addIdea} style={{ padding: "10px 16px", background: T.accent, border: "none",
            borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>추가</button>
        </div>
        {ideas.length === 0 ? (
          <p style={{ color: T.textMuted, fontSize: 12, textAlign: "center", padding: "12px 0" }}>아이디어를 입력해보세요</p>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {ideas.map(idea => {
              const sel = data.topic === idea.text;
              return (
                <div key={idea.id} onClick={() => setData(d => ({ ...d, topic: idea.text }))}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 13px",
                    background: sel ? `${T.accent}15` : T.surface, border: `1px solid ${sel ? T.accent : T.border2}`,
                    borderRadius: 10, cursor: "pointer", transition: "all .15s",
                    boxShadow: sel ? `0 0 0 2px ${T.accent}33` : "none" }}>
                  <span style={{ fontSize: 16, flexShrink: 0 }}>💡</span>
                  <span style={{ flex: 1, color: sel ? T.accent : T.text, fontSize: 13, fontWeight: sel ? 700 : 400, lineHeight: 1.4 }}>{idea.text}</span>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, flexShrink: 0 }}>
                    {sel && <span style={{ width: 18, height: 18, borderRadius: "50%", background: T.accent,
                      display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 10 }}>✓</span>}
                    <button onClick={e => { e.stopPropagation(); setData(d => ({ ...d, ideas: ideas.filter(x => x.id !== idea.id), topic: data.topic === idea.text ? "" : data.topic })); }}
                      style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 2, lineHeight: 1, fontSize: 14 }}
                      onMouseEnter={e => e.currentTarget.style.color = T.danger}
                      onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>×</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <label style={{ display: "block", color: T.textSub, fontSize: 12, marginBottom: 6, fontWeight: 600 }}>
        최종 대주제 {data.topic && <span style={{ color: T.accent }}>✓</span>}
      </label>
      <input value={data.topic || ""} onChange={e => setData(d => ({ ...d, topic: e.target.value }))}
        placeholder="아이디어를 클릭하거나 직접 입력하세요"
        style={{ width: "100%", padding: "12px 14px", background: T.surfaceHover,
          border: `1px solid ${data.topic ? T.accent : T.border2}`, borderRadius: 10,
          color: T.text, fontSize: 14, fontWeight: data.topic ? 700 : 400,
          outline: "none", boxSizing: "border-box", fontFamily: "inherit", transition: "border-color .2s" }} />
    </div>
  );
}

function OStep4({ T, data, setData }) {
  const procs   = data.procedures || [];
  const members = data.members || [];
  const [expanded, setExpanded]         = useState({});
  const [taskInps, setTaskInps]         = useState({});
  const [customInp, setCustomInp]       = useState("");
  const [showCustomInp, setShowCustomInp] = useState(false);

  const toggleTpl = t => {
    const exists = procs.find(p => p.id === t.id);
    if (exists) setData(d => ({ ...d, procedures: d.procedures.filter(p => p.id !== t.id) }));
    else setData(d => ({ ...d, procedures: [...(d.procedures || []), { ...t, customTasks: [] }] }));
  };
  const addCustomProc = () => {
    const name = customInp.trim();
    if (!name) return;
    setData(d => ({ ...d, procedures: [...(d.procedures || []), { id: uid(), name, icon: "📌", color: "#6366f1", isCustom: true, customTasks: [] }] }));
    setCustomInp(""); setShowCustomInp(false);
  };
  const removeCustomProc = id => setData(d => ({ ...d, procedures: d.procedures.filter(p => p.id !== id) }));
  const addTask = procId => {
    const t = (taskInps[procId] || "").trim();
    if (!t) return;
    setData(d => ({ ...d, procedures: d.procedures.map(p => p.id === procId
      ? { ...p, customTasks: [...(p.customTasks || []), { id: uid(), title: t, memberId: "", memberName: "" }] } : p) }));
    setTaskInps(i => ({ ...i, [procId]: "" }));
  };
  const removeTask = (procId, taskId) => setData(d => ({ ...d,
    procedures: d.procedures.map(p => p.id === procId
      ? { ...p, customTasks: (p.customTasks || []).filter(t => t.id !== taskId) } : p) }));
  const assignMember = (procId, taskId, memberId) => {
    const m = members.find(x => x.id === memberId);
    setData(d => ({ ...d, procedures: d.procedures.map(p => p.id === procId
      ? { ...p, customTasks: (p.customTasks || []).map(t => t.id === taskId ? { ...t, memberId, memberName: m?.name || "" } : t) } : p) }));
  };
  const customProcs = procs.filter(p => p.isCustom);

  return (
    <div>
      <SH T={T} n={4} title="절차를 선택하세요 📋" sub="단계를 고르고 각 단계의 작업을 직접 입력할 수 있습니다." />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
        {PROC_TEMPLATES.map(t => {
          const sel = procs.some(p => p.id === t.id);
          return (
            <div key={t.id} onClick={() => toggleTpl(t)}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 13px",
                background: sel ? `${T.accent}12` : T.surfaceHover, border: `1px solid ${sel ? T.accent : T.border2}`,
                borderRadius: 9, cursor: "pointer", transition: "all .15s" }}>
              <span style={{ fontSize: 17 }}>{t.icon}</span>
              <span style={{ color: sel ? T.accent : T.textSub, fontSize: 12, fontWeight: sel ? 700 : 400, flex: 1 }}>{t.name}</span>
              {sel && <span style={{ color: T.accent, fontSize: 13 }}>✓</span>}
            </div>
          );
        })}
      </div>
      {customProcs.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
          {customProcs.map(p => (
            <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 13px",
              background: `${T.accent}12`, border: `1px solid ${T.accent}`, borderRadius: 9 }}>
              <span style={{ fontSize: 17 }}>📌</span>
              <span style={{ color: T.accent, fontSize: 12, fontWeight: 700, flex: 1 }}>{p.name}</span>
              <button onClick={() => removeCustomProc(p.id)}
                style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 2 }}
                onMouseEnter={e => e.currentTarget.style.color = T.danger}
                onMouseLeave={e => e.currentTarget.style.color = T.textMuted}><SVG d={I.x} size={13} /></button>
            </div>
          ))}
        </div>
      )}
      {showCustomInp ? (
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <input autoFocus value={customInp} onChange={e => setCustomInp(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") addCustomProc(); if (e.key === "Escape") { setShowCustomInp(false); setCustomInp(""); } }}
            placeholder="새 단계 이름 입력 후 Enter"
            style={{ flex: 1, padding: "9px 13px", background: T.surfaceHover, border: `1px solid ${T.accent}`,
              borderRadius: 9, color: T.text, fontSize: 13, outline: "none", fontFamily: "inherit" }} />
          <button onClick={addCustomProc} style={{ padding: "9px 14px", background: T.accent, border: "none",
            borderRadius: 9, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>추가</button>
          <button onClick={() => { setShowCustomInp(false); setCustomInp(""); }}
            style={{ padding: "9px 12px", background: T.surfaceHover, border: `1px solid ${T.border2}`,
              borderRadius: 9, color: T.textSub, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>취소</button>
        </div>
      ) : (
        <button onClick={() => setShowCustomInp(true)} style={{ width: "100%", padding: "9px", background: T.surfaceHover,
          border: `1px dashed ${T.border2}`, borderRadius: 9, color: T.textMuted, fontSize: 12,
          cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
          gap: 7, fontFamily: "inherit", marginBottom: 16 }}>
          <SVG d={I.plus} size={12} /> 직접 추가
        </button>
      )}
      {procs.length > 0 && (
        <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
          <p style={{ color: T.textSub, fontSize: 12, marginBottom: 10, fontWeight: 600 }}>📝 단계별 작업 입력 (선택사항 — 비우면 팀원별 자동 생성)</p>
          {procs.map(proc => {
            const isOpen = expanded[proc.id] !== false;
            const tasks  = proc.customTasks || [];
            return (
              <div key={proc.id} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 9, marginBottom: 7, overflow: "hidden" }}>
                <div onClick={() => setExpanded(e => ({ ...e, [proc.id]: !isOpen }))}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 13px", cursor: "pointer",
                    borderBottom: isOpen ? `1px solid ${T.border}` : "none" }}>
                  <span style={{ fontSize: 14 }}>{proc.icon}</span>
                  <span style={{ color: T.text, fontSize: 12, fontWeight: 600, flex: 1 }}>{proc.name}</span>
                  <span style={{ color: T.textMuted, fontSize: 10 }}>{tasks.length}개 작업</span>
                  <SVG d={isOpen ? I.chevD : I.chevR} size={11} />
                </div>
                {isOpen && (
                  <div style={{ padding: "9px 13px" }}>
                    {tasks.map(task => (
                      <div key={task.id} style={{ display: "flex", alignItems: "center", gap: 8,
                        padding: "5px 0", borderBottom: `1px solid ${T.border}` }}>
                        <span style={{ color: T.text, fontSize: 12, flex: 1 }}>{task.title}</span>
                        {members.length > 0 && (
                          <select value={task.memberId} onChange={e => assignMember(proc.id, task.id, e.target.value)}
                            style={{ padding: "3px 7px", background: T.surfaceHover, border: `1px solid ${T.border2}`,
                              borderRadius: 6, color: T.textSub, fontSize: 10, outline: "none", fontFamily: "inherit" }}>
                            <option value="">담당자 미정</option>
                            {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                          </select>
                        )}
                        <button onClick={() => removeTask(proc.id, task.id)}
                          style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 2 }}
                          onMouseEnter={e => e.currentTarget.style.color = T.danger}
                          onMouseLeave={e => e.currentTarget.style.color = T.textMuted}><SVG d={I.x} size={11} /></button>
                      </div>
                    ))}
                    <div style={{ display: "flex", gap: 7, marginTop: 8 }}>
                      <input value={taskInps[proc.id] || ""}
                        onChange={e => setTaskInps(i => ({ ...i, [proc.id]: e.target.value }))}
                        onKeyDown={e => e.key === "Enter" && addTask(proc.id)}
                        placeholder="작업 이름 입력 후 Enter"
                        style={{ flex: 1, padding: "6px 10px", background: T.surfaceHover, border: `1px solid ${T.border2}`,
                          borderRadius: 7, color: T.text, fontSize: 11, outline: "none", fontFamily: "inherit" }} />
                      <button onClick={() => addTask(proc.id)} style={{ padding: "6px 12px", background: T.accent, border: "none",
                        borderRadius: 7, color: "#fff", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>추가</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function OStep5({ T, data, setData }) {
  const roles   = data.roles || BASE_ROLES.map(r => ({ ...r }));
  const members = data.members || [];
  const assigns = data.roleAssignments || {};
  const [showRoleInp, setShowRoleInp] = useState(false);
  const [roleInp, setRoleInp]         = useState("");
  const ROLE_COLORS = ["#6366f1","#10b981","#f59e0b","#ec4899","#3b82f6","#ef4444","#8b5cf6","#f97316"];

  const upd = (mId, key, rId) => {
    const a = { ...assigns, [mId]: { ...(assigns[mId] || {}), [key]: rId } };
    setData(d => ({ ...d, roleAssignments: a }));
  };
  const addRole = () => {
    const name = roleInp.trim();
    if (!name) return;
    const newRole = { id: uid(), name, icon: "⭐", color: ROLE_COLORS[roles.length % ROLE_COLORS.length] };
    setData(d => ({ ...d, roles: [...(d.roles || BASE_ROLES.map(x => ({ ...x }))), newRole] }));
    setRoleInp(""); setShowRoleInp(false);
  };
  const deleteRole = roleId => {
    const newAssigns = { ...assigns };
    Object.keys(newAssigns).forEach(mId => {
      const a = { ...newAssigns[mId] };
      ["main","sub1","sub2"].forEach(k => { if (a[k] === roleId) delete a[k]; });
      newAssigns[mId] = a;
    });
    setData(d => ({ ...d, roles: (d.roles || BASE_ROLES.map(x => ({ ...x }))).filter(r => r.id !== roleId), roleAssignments: newAssigns }));
  };

  return (
    <div>
      <SH T={T} n={5} title="역할을 분담하세요 🎭" sub="메인 역할 1개, 서브 역할 2개를 지정하세요." />
      <div style={{ background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 12, padding: "13px 14px", marginBottom: 20 }}>
        <p style={{ color: T.textSub, fontSize: 11, fontWeight: 700, marginBottom: 10, textTransform: "uppercase", letterSpacing: .5 }}>역할 목록</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 10 }}>
          {roles.map(r => (
            <span key={r.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 8px 5px 11px",
              background: `${r.color}18`, border: `1px solid ${r.color}55`, borderRadius: 100, color: r.color, fontSize: 12, fontWeight: 600 }}>
              {r.icon} {r.name}
              <button onClick={() => deleteRole(r.id)}
                style={{ width: 16, height: 16, borderRadius: "50%", background: `${r.color}30`, border: "none",
                  color: r.color, cursor: "pointer", padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11 }}
                onMouseEnter={e => { e.currentTarget.style.background = T.danger + "33"; e.currentTarget.style.color = T.danger; }}
                onMouseLeave={e => { e.currentTarget.style.background = `${r.color}30`; e.currentTarget.style.color = r.color; }}>×</button>
            </span>
          ))}
        </div>
        {showRoleInp ? (
          <div style={{ display: "flex", gap: 7 }}>
            <input autoFocus value={roleInp} onChange={e => setRoleInp(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") addRole(); if (e.key === "Escape") { setShowRoleInp(false); setRoleInp(""); } }}
              placeholder="역할 이름 입력 후 Enter"
              style={{ flex: 1, padding: "7px 11px", background: T.surface, border: `1px solid ${T.accent}`,
                borderRadius: 8, color: T.text, fontSize: 12, outline: "none", fontFamily: "inherit" }} />
            <button onClick={addRole} style={{ padding: "7px 14px", background: T.accent, border: "none",
              borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>추가</button>
            <button onClick={() => { setShowRoleInp(false); setRoleInp(""); }}
              style={{ padding: "7px 11px", background: T.surface, border: `1px solid ${T.border2}`,
                borderRadius: 8, color: T.textSub, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>취소</button>
          </div>
        ) : (
          <button onClick={() => setShowRoleInp(true)}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 12px",
              background: T.surface, border: `1px dashed ${T.border2}`, borderRadius: 100,
              color: T.textMuted, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
            <SVG d={I.plus} size={11} /> 역할 추가
          </button>
        )}
      </div>
      {members.length === 0
        ? <p style={{ color: T.textMuted, fontSize: 13 }}>팀원이 없습니다.</p>
        : members.map(m => (
          <div key={m.id} style={{ padding: "13px 15px", background: T.surface,
            border: `1px solid ${T.border}`, borderRadius: 11, marginBottom: 9 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
              <div style={{ width: 25, height: 25, borderRadius: "50%", background: T.accent,
                display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 11, fontWeight: 700 }}>{m.name[0]}</div>
              <span style={{ color: T.text, fontSize: 13, fontWeight: 700 }}>{m.name}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 9 }}>
              {[["main","메인 역할"],["sub1","서브 역할 1"],["sub2","서브 역할 2"]].map(([key, label]) => (
                <div key={key}>
                  <label style={{ display: "block", color: T.textMuted, fontSize: 10, marginBottom: 5, fontWeight: 600 }}>{label}</label>
                  <select value={(assigns[m.id] || {})[key] || ""} onChange={e => upd(m.id, key, e.target.value)}
                    style={{ width: "100%", padding: "6px 9px", background: T.surfaceHover, border: `1px solid ${T.border2}`,
                      borderRadius: 7, color: T.text, fontSize: 11, outline: "none", fontFamily: "inherit" }}>
                    <option value="">선택</option>
                    {roles.map(r => <option key={r.id} value={r.id}>{r.icon} {r.name}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </div>
        ))
      }
    </div>
  );
}

// ─── PROJECT SCREEN ───────────────────────────────────────────────────────────
function ProjectScreen({
  T, dark, setDark, project, tab, setTab, loginName,
  currentAccount,
  onUpdate, onUpdateProject, onDeleteProject, onRegenCode,
  onTaskChange, onAddTask, onDeleteTask,
  onAddProcedure, onUpdateProcedure, onDeleteProcedure,
  onReorderProcedures, onFileUpload, notify, onBack,
}) {
  const isOwner = currentAccount && project.ownerAccountId === currentAccount.id;
  const total = project.procedures.reduce((a, s) => a + s.tasks.length, 0);
  const done  = project.procedures.reduce((a, s) => a + s.tasks.filter(t => t.status === "done").length, 0);
  const pct   = total ? Math.round(done / total * 100) : 0;

  const TABS = [
    { id: "dashboard", icon: "🏠", label: "대시보드"  },
    { id: "tasks",     icon: "📋", label: "작업 관리" },
    { id: "gantt",     icon: "📅", label: "스케줄"    },
    { id: "mytasks",   icon: "👤", label: "내 작업"   },
    { id: "settings",  icon: "⚙️", label: "설정"      },
  ];

  return (
    <div style={{ minHeight: "100vh", background: T.bg, display: "flex",
      fontFamily: "'Pretendard','Apple SD Gothic Neo',sans-serif" }}>
      <Sidebar T={T} dark={dark} setDark={setDark} loginName={loginName}
        activeItem={tab} items={TABS} onItemClick={setTab}
        projectInfo={{ name: project.name, pct }}
        extra={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 6,
              color: T.textMuted, fontSize: 11, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
              ← 목록으로
            </button>
            {isOwner
              ? <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 100,
                  background: `${T.accent}20`, color: T.accent, fontWeight: 700 }}>오너</span>
              : <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 100,
                  background: `${T.success}15`, color: T.success, fontWeight: 700 }}>구성원</span>
            }
          </div>
        }
      />
      <div style={{ marginLeft: 220, flex: 1, padding: "40px 48px" }}>
        {tab === "dashboard" && (
          <DashTab T={T} project={project} pct={pct}
            onAddProcedure={onAddProcedure}
            onUpdateProcedure={onUpdateProcedure}
            onDeleteProcedure={onDeleteProcedure}
            onReorderProcedures={onReorderProcedures}
            notify={notify} />
        )}
        {tab === "tasks" && (
          <TasksTab T={T} project={project}
            onTaskChange={onTaskChange}
            onAddTask={onAddTask}
            onDeleteTask={onDeleteTask}
            onAddProcedure={onAddProcedure}
            onUpdateProcedure={onUpdateProcedure}
            onDeleteProcedure={onDeleteProcedure}
            onFileUpload={onFileUpload}
            notify={notify} />
        )}
        {tab === "gantt"   && <GanttTab T={T} project={project} />}
        {tab === "mytasks" && <MyTasksTab T={T} project={project} loginName={loginName} onTaskChange={onTaskChange} />}
        {tab === "settings" && (
          <SettingsTab T={T} project={project} isOwner={isOwner}
            onUpdateProject={onUpdateProject}
            onDeleteProject={onDeleteProject}
            onRegenCode={onRegenCode}
            notify={notify}
            onBack={onBack} />
        )}
      </div>
    </div>
  );
}

// ─── SETTINGS TAB ─────────────────────────────────────────────────────────────
function SettingsTab({ T, project, isOwner, onUpdateProject, onDeleteProject, onRegenCode, notify, onBack }) {
  const [name, setName]             = useState(project.name);
  const [topic, setTopic]           = useState(project.topic || "");
  const [startDate, setStartDate]   = useState(project.startDate || "");
  const [endDate, setEndDate]       = useState(project.endDate || "");
  const [saving, setSaving]         = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [copied, setCopied]         = useState(false);
  const [regenning, setRegenning]   = useState(false);

  const handleSave = async () => {
    if (!name.trim()) { notify("프로젝트 이름을 입력해주세요.", "err"); return; }
    setSaving(true);
    await onUpdateProject({ name: name.trim(), topic, startDate, endDate });
    setSaving(false);
  };

  const handleCopy = () => {
    if (!project.inviteCode) return;
    navigator.clipboard.writeText(project.inviteCode).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleRegen = async () => {
    setRegenning(true);
    await onRegenCode();
    setRegenning(false);
  };

  const handleDelete = async () => {
    await onDeleteProject();
    onBack();
  };

  const field = (label, val, set, type = "text") => (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", color: T.textSub, fontSize: 11, fontWeight: 700,
        marginBottom: 6, textTransform: "uppercase", letterSpacing: .5 }}>{label}</label>
      <input type={type} value={val} onChange={e => set(e.target.value)}
        disabled={!isOwner}
        style={{ width: "100%", padding: "10px 14px", background: isOwner ? T.surfaceHover : T.surface,
          border: `1px solid ${T.border2}`, borderRadius: 8, color: isOwner ? T.text : T.textSub,
          fontSize: 13, outline: "none", boxSizing: "border-box", fontFamily: "inherit",
          cursor: isOwner ? "text" : "not-allowed" }} />
    </div>
  );

  return (
    <div style={{ maxWidth: 640 }}>
      <h1 style={{ color: T.text, fontSize: 24, fontWeight: 800, marginBottom: 4 }}>프로젝트 설정</h1>
      <p style={{ color: T.textSub, fontSize: 13, marginBottom: 32 }}>
        {isOwner ? "프로젝트 정보를 수정하고, 팀원을 초대하거나 프로젝트를 삭제할 수 있습니다." : "프로젝트 정보를 확인합니다. 수정은 오너만 가능합니다."}
      </p>

      {/* ── 기본 정보 ── */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14,
        padding: "22px 24px", marginBottom: 20 }}>
        <h3 style={{ color: T.text, fontSize: 14, fontWeight: 700, marginBottom: 18 }}>📝 기본 정보</h3>
        {field("프로젝트 이름", name, setName)}
        {field("대주제", topic, setTopic)}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          {field("시작일", startDate, setStartDate, "date")}
          {field("종료일", endDate, setEndDate, "date")}
        </div>
        {isOwner && (
          <button onClick={handleSave} disabled={saving}
            style={{ padding: "10px 22px", background: `linear-gradient(135deg,${T.accent},${T.accentSub})`,
              border: "none", borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 700,
              cursor: "pointer", fontFamily: "inherit", marginTop: 4 }}>
            {saving ? "저장 중..." : "💾 저장"}
          </button>
        )}
      </div>

      {/* ── 초대 코드 ── */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14,
        padding: "22px 24px", marginBottom: 20 }}>
        <h3 style={{ color: T.text, fontSize: 14, fontWeight: 700, marginBottom: 6 }}>🔗 팀원 초대</h3>
        <p style={{ color: T.textMuted, fontSize: 12, marginBottom: 16 }}>
          이 코드를 팀원에게 공유하세요. 팀원은 프로젝트 목록 화면에서 코드를 입력해 참여할 수 있습니다.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, padding: "14px 20px", background: `${T.accent}10`,
            border: `2px dashed ${T.accent}55`, borderRadius: 10, textAlign: "center" }}>
            <span style={{ color: T.accent, fontSize: 28, fontWeight: 900, letterSpacing: 8,
              fontFamily: "monospace" }}>
              {project.inviteCode || "------"}
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <button onClick={handleCopy}
              style={{ padding: "8px 16px", background: copied ? T.success : T.accent,
                border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700,
                cursor: "pointer", fontFamily: "inherit", transition: "background .2s", whiteSpace: "nowrap" }}>
              {copied ? "✓ 복사됨" : "📋 복사"}
            </button>
            {isOwner && (
              <button onClick={handleRegen} disabled={regenning}
                style={{ padding: "8px 16px", background: T.surfaceHover,
                  border: `1px solid ${T.border2}`, borderRadius: 8, color: T.textSub, fontSize: 12,
                  cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
                {regenning ? "..." : "🔄 재발급"}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── 구성원 목록 ── */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14,
        padding: "22px 24px", marginBottom: 20 }}>
        <h3 style={{ color: T.text, fontSize: 14, fontWeight: 700, marginBottom: 16 }}>👥 구성원 ({project.members.length}명)</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {project.members.map(m => (
            <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 10,
              padding: "10px 14px", background: T.surfaceHover, borderRadius: 10, border: `1px solid ${T.border}` }}>
              <div style={{ width: 30, height: 30, borderRadius: "50%", background: T.accent,
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "#fff", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
                {m.name[0]}
              </div>
              <div style={{ flex: 1 }}>
                <span style={{ color: T.text, fontSize: 13, fontWeight: 600 }}>{m.name}</span>
              </div>
              <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 100, fontWeight: 700,
                background: m.accountId ? `${T.success}15` : `${T.warn}15`,
                color: m.accountId ? T.success : T.warn }}>
                {m.accountId ? "✓ 가입됨" : "미가입"}
              </span>
              <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 100, fontWeight: 700,
                background: m.role === "owner" ? `${T.accent}15` : T.border,
                color: m.role === "owner" ? T.accent : T.textSub }}>
                {m.role === "owner" ? "오너" : "멤버"}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── 위험 구역 (오너만) ── */}
      {isOwner && (
        <div style={{ background: `${T.danger}08`, border: `1px solid ${T.danger}33`,
          borderRadius: 14, padding: "22px 24px" }}>
          <h3 style={{ color: T.danger, fontSize: 14, fontWeight: 700, marginBottom: 8 }}>⚠️ 위험 구역</h3>
          <p style={{ color: T.textMuted, fontSize: 12, marginBottom: 16 }}>
            프로젝트를 삭제하면 모든 작업, 절차, 구성원 데이터가 영구적으로 삭제됩니다.
          </p>
          {!confirmDel ? (
            <button onClick={() => setConfirmDel(true)}
              style={{ padding: "9px 20px", background: "transparent",
                border: `1px solid ${T.danger}`, borderRadius: 8, color: T.danger,
                fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
              🗑️ 프로젝트 삭제
            </button>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 10,
              padding: "14px 16px", background: `${T.danger}12`, borderRadius: 10, border: `1px solid ${T.danger}44` }}>
              <span style={{ color: T.danger, fontSize: 13, fontWeight: 600, flex: 1 }}>
                정말로 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.
              </span>
              <button onClick={handleDelete}
                style={{ padding: "8px 18px", background: T.danger, border: "none",
                  borderRadius: 7, color: "#fff", fontSize: 13, fontWeight: 700,
                  cursor: "pointer", fontFamily: "inherit" }}>
                삭제 확인
              </button>
              <button onClick={() => setConfirmDel(false)}
                style={{ padding: "8px 14px", background: T.surfaceHover, border: `1px solid ${T.border2}`,
                  borderRadius: 7, color: T.textSub, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
                취소
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function DashTab({ T, project, pct, onAddProcedure, onUpdateProcedure, onDeleteProcedure, onReorderProcedures, notify }) {
  const [editingId, setEditingId]       = useState(null);
  const [editName, setEditName]         = useState("");
  const [adding, setAdding]             = useState(false);
  const [newName, setNewName]           = useState("");
  const [confirmDelId, setConfirmDelId] = useState(null);
  const [dragOverId, setDragOverId]     = useState(null);
  const dragSrcId                       = useRef(null);

  const total = project.procedures.reduce((a, s) => a + s.tasks.length, 0);
  const done  = project.procedures.reduce((a, s) => a + s.tasks.filter(t => t.status === "done").length, 0);
  const doing = project.procedures.reduce((a, s) => a + s.tasks.filter(t => t.status === "doing").length, 0);

  const saveEdit = async id => {
    if (!editName.trim()) { setEditingId(null); return; }
    await onUpdateProcedure(id, { name: editName });
    setEditingId(null);
    notify("단계 이름이 수정되었습니다.");
  };

  return (
    <div>
      <div style={{ marginBottom: 26 }}>
        <h1 style={{ color: T.text, fontSize: 26, fontWeight: 800, marginBottom: 4 }}>{project.name}</h1>
        <p style={{ color: T.textSub, fontSize: 13 }}>💡 {project.topic || "대주제 미설정"}</p>
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 13, marginBottom: 20 }}>
        {[["전체 진행률",`${pct}%`,"📊"],["전체 작업",total,"📋"],["진행중",doing,"⚡"],["완료",done,"✅"]].map(([label, value, icon], i) => (
          <div key={i} style={{ padding: "17px 18px", background: T.card, border: `1px solid ${T.border}`, borderRadius: 13 }}>
            <div style={{ fontSize: 19, marginBottom: 5 }}>{icon}</div>
            <div style={{ color: T.text, fontSize: 22, fontWeight: 800, marginBottom: 2 }}>{value}</div>
            <div style={{ color: T.textSub, fontSize: 11 }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Progress bar */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 13, padding: 18, marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 9 }}>
          <span style={{ color: T.text, fontSize: 13, fontWeight: 700 }}>전체 진행 현황</span>
          <span style={{ color: T.accent, fontSize: 13, fontWeight: 800 }}>{pct}%</span>
        </div>
        <div style={{ background: T.border, borderRadius: 100, height: 6, overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: `linear-gradient(90deg,${T.accent},${T.accentSub})`,
            borderRadius: 100, transition: "width .8s" }} />
        </div>
        <div style={{ display: "flex", gap: 14, marginTop: 9 }}>
          {[["미진행", total - done - doing, "#94a3b8"],["진행중", doing, T.warn],["완료", done, T.success]].map(([l, v, c]) => (
            <div key={l} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: c }} />
              <span style={{ color: T.textSub, fontSize: 11 }}>{l} {v}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Flow — draggable */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 13, padding: 18, marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 13 }}>
          <h3 style={{ color: T.text, fontSize: 13, fontWeight: 700 }}>📍 프로젝트 흐름</h3>
          <button onClick={() => setAdding(v => !v)} style={{ display: "flex", alignItems: "center", gap: 5,
            padding: "5px 11px", background: T.surfaceHover, border: `1px solid ${T.border2}`,
            borderRadius: 7, color: T.textSub, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>
            <SVG d={I.plus} size={11} /> 단계 추가
          </button>
        </div>
        {adding && (
          <div style={{ display: "flex", gap: 7, marginBottom: 13 }}>
            <input autoFocus value={newName} onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && (onAddProcedure(newName), setNewName(""), setAdding(false))}
              placeholder="새 단계 이름"
              style={{ flex: 1, padding: "7px 11px", background: T.surfaceHover, border: `1px solid ${T.accent}`,
                borderRadius: 7, color: T.text, fontSize: 12, outline: "none", fontFamily: "inherit" }} />
            <button onClick={() => { onAddProcedure(newName); setNewName(""); setAdding(false); }}
              style={{ padding: "7px 13px", background: T.accent, border: "none", borderRadius: 7, color: "#fff", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>추가</button>
            <button onClick={() => setAdding(false)} style={{ padding: "7px 11px", background: T.surfaceHover,
              border: `1px solid ${T.border2}`, borderRadius: 7, color: T.textSub, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>취소</button>
          </div>
        )}
        <div style={{ display: "flex", alignItems: "flex-start", flexWrap: "wrap", gap: 5 }}>
          {project.procedures.map((proc, i) => {
            const t  = proc.tasks.length;
            const d2 = proc.tasks.filter(x => x.status === "done").length;
            const p2 = t ? Math.round(d2 / t * 100) : 0;
            const isOver = dragOverId === proc.id && dragSrcId.current !== proc.id;
            return (
              <div key={proc.id} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                {isOver && <div style={{ width: 3, height: 60, borderRadius: 3, background: T.accent, boxShadow: `0 0 8px ${T.accent}88` }} />}
                <div draggable
                  onDragStart={e => { dragSrcId.current = proc.id; e.dataTransfer.effectAllowed = "move"; e.currentTarget.style.opacity = "0.4"; }}
                  onDragEnd={e => { e.currentTarget.style.opacity = "1"; dragSrcId.current = null; setDragOverId(null); }}
                  onDragOver={e => { e.preventDefault(); if (proc.id !== dragSrcId.current) setDragOverId(proc.id); }}
                  onDragLeave={() => setDragOverId(null)}
                  onDrop={e => {
                    e.preventDefault();
                    const srcId = dragSrcId.current;
                    if (!srcId || srcId === proc.id) return;
                    const procs = [...project.procedures];
                    const si = procs.findIndex(p => p.id === srcId);
                    const di = procs.findIndex(p => p.id === proc.id);
                    const [moved] = procs.splice(si, 1);
                    procs.splice(di, 0, moved);
                    onReorderProcedures(procs);
                    setDragOverId(null);
                  }}
                  style={{ padding: "8px 12px", cursor: "grab",
                    background: isOver ? `${T.accent}10` : p2 === 100 ? `${T.success}12` : T.surfaceHover,
                    border: `1px solid ${isOver ? T.accent : p2 === 100 ? T.success : T.border2}`,
                    borderRadius: 9, transition: "all .15s", boxShadow: isOver ? `0 0 0 2px ${T.accent}44` : "none" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 3 }}>
                    <span style={{ color: T.textMuted, fontSize: 8, letterSpacing: -1, lineHeight: 1, userSelect: "none" }}>⠿</span>
                    <span style={{ fontSize: 12 }}>{proc.icon}</span>
                    {editingId === proc.id ? (
                      <input autoFocus value={editName} onChange={e => setEditName(e.target.value)}
                        onBlur={() => saveEdit(proc.id)} onKeyDown={e => e.key === "Enter" && saveEdit(proc.id)}
                        style={{ background: "transparent", border: "none", borderBottom: `1px solid ${T.accent}`,
                          color: T.text, fontSize: 11, fontWeight: 700, outline: "none", width: 80, fontFamily: "inherit" }} />
                    ) : (
                      <span style={{ color: p2 === 100 ? T.success : T.text, fontSize: 11, fontWeight: 700 }}>{proc.name}</span>
                    )}
                    <button onClick={() => { setEditingId(proc.id); setEditName(proc.name); }}
                      style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 1 }}
                      onMouseEnter={e => e.currentTarget.style.color = T.accent}
                      onMouseLeave={e => e.currentTarget.style.color = T.textMuted}><SVG d={I.edit} size={10} /></button>
                    {confirmDelId === proc.id ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <button onClick={() => { onDeleteProcedure(proc.id); setConfirmDelId(null); }}
                          style={{ padding: "1px 6px", background: T.danger, border: "none", borderRadius: 4, color: "#fff", fontSize: 9, cursor: "pointer", fontFamily: "inherit" }}>삭제</button>
                        <button onClick={() => setConfirmDelId(null)}
                          style={{ padding: "1px 5px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 4, color: T.textSub, fontSize: 9, cursor: "pointer", fontFamily: "inherit" }}>취소</button>
                      </span>
                    ) : (
                      <button onClick={() => setConfirmDelId(proc.id)}
                        style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 1 }}
                        onMouseEnter={e => e.currentTarget.style.color = T.danger}
                        onMouseLeave={e => e.currentTarget.style.color = T.textMuted}><SVG d={I.trash} size={10} /></button>
                    )}
                  </div>
                  <div style={{ color: T.textMuted, fontSize: 9 }}>{d2}/{t} · {p2}%</div>
                </div>
                {i < project.procedures.length - 1 && (
                  <span style={{ color: dragOverId && dragSrcId.current ? T.accent : T.border2, fontSize: 13, transition: "color .15s" }}>→</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Members */}
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
                  <div style={{ width: 26, height: 26, borderRadius: "50%", background: T.accent,
                    display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 11, fontWeight: 700 }}>{m.name[0]}</div>
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

// ─── TASKS TAB ────────────────────────────────────────────────────────────────
function TasksTab({ T, project, onTaskChange, onAddTask, onDeleteTask, onAddProcedure, onUpdateProcedure, onDeleteProcedure, onFileUpload, notify }) {
  const [expanded, setExpanded]         = useState({});
  const [editingPId, setEditingPId]     = useState(null);
  const [editPName, setEditPName]       = useState("");
  const [confirmDelId, setConfirmDelId] = useState(null);
  const [addingTaskId, setAddingTaskId] = useState(null);
  const [newTaskTitle, setNewTaskTitle] = useState("");

  const savePName = async id => {
    if (!editPName.trim()) { setEditingPId(null); return; }
    await onUpdateProcedure(id, { name: editPName });
    setEditingPId(null);
    notify("수정되었습니다.");
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 26 }}>
        <div>
          <h1 style={{ color: T.text, fontSize: 24, fontWeight: 800, marginBottom: 4 }}>작업 관리</h1>
          <p style={{ color: T.textSub, fontSize: 13 }}>절차별 세부 작업을 관리하세요</p>
        </div>
        <button onClick={() => onAddProcedure("새 단계")} style={{ display: "flex", alignItems: "center", gap: 6,
          padding: "8px 16px", background: T.surfaceHover, border: `1px solid ${T.border2}`,
          borderRadius: 8, color: T.textSub, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
          <SVG d={I.plus} size={12} /> 단계 추가
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
        {project.procedures.map(proc => {
          const isOpen = expanded[proc.id] !== false;
          const doneC  = proc.tasks.filter(t => t.status === "done").length;
          return (
            <div key={proc.id} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 13, overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "13px 16px",
                borderBottom: isOpen ? `1px solid ${T.border}` : "none", background: T.surface }}>
                <div onClick={() => setExpanded(e => ({ ...e, [proc.id]: !isOpen }))} style={{ cursor: "pointer", color: T.textMuted }}>
                  <SVG d={isOpen ? I.chevD : I.chevR} size={12} />
                </div>
                <span style={{ fontSize: 15 }}>{proc.icon}</span>
                {editingPId === proc.id ? (
                  <input autoFocus value={editPName} onChange={e => setEditPName(e.target.value)}
                    onBlur={() => savePName(proc.id)} onKeyDown={e => e.key === "Enter" && savePName(proc.id)}
                    style={{ flex: 1, background: "transparent", border: "none", borderBottom: `1px solid ${T.accent}`,
                      color: T.text, fontSize: 13, fontWeight: 700, outline: "none", fontFamily: "inherit" }} />
                ) : (
                  <span onClick={() => setExpanded(e => ({ ...e, [proc.id]: !isOpen }))}
                    style={{ flex: 1, color: T.text, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>{proc.name}</span>
                )}
                <span style={{ color: T.textMuted, fontSize: 11 }}>{doneC}/{proc.tasks.length}</span>
                <button onClick={() => { setEditingPId(proc.id); setEditPName(proc.name); }}
                  style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 3 }}
                  onMouseEnter={e => e.currentTarget.style.color = T.accent}
                  onMouseLeave={e => e.currentTarget.style.color = T.textMuted}><SVG d={I.edit} size={12} /></button>
                {confirmDelId === proc.id ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <button onClick={() => { onDeleteProcedure(proc.id); setConfirmDelId(null); }}
                      style={{ padding: "2px 8px", background: T.danger, border: "none", borderRadius: 5, color: "#fff", fontSize: 10, cursor: "pointer", fontFamily: "inherit" }}>삭제</button>
                    <button onClick={() => setConfirmDelId(null)}
                      style={{ padding: "2px 7px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 5, color: T.textSub, fontSize: 10, cursor: "pointer", fontFamily: "inherit" }}>취소</button>
                  </span>
                ) : (
                  <button onClick={() => setConfirmDelId(proc.id)}
                    style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 3 }}
                    onMouseEnter={e => e.currentTarget.style.color = T.danger}
                    onMouseLeave={e => e.currentTarget.style.color = T.textMuted}><SVG d={I.trash} size={12} /></button>
                )}
              </div>
              {isOpen && (
                <div style={{ padding: "9px 14px 13px" }}>
                  {proc.tasks.length === 0 && <p style={{ color: T.textMuted, fontSize: 12, padding: "6px 2px" }}>작업이 없습니다.</p>}
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {proc.tasks.map(task => (
                      <TaskRow key={task.id} T={T} task={task} members={project.members}
                        onChange={ch => onTaskChange(proc.id, task.id, ch)}
                        onDelete={() => onDeleteTask(proc.id, task.id)}
                        onFileUpload={files => onFileUpload(proc.id, task, files)}
                        notify={notify} />
                    ))}
                  </div>
                  {addingTaskId === proc.id ? (
                    <div style={{ display: "flex", gap: 7, marginTop: 9 }}>
                      <input autoFocus value={newTaskTitle}
                        onChange={e => setNewTaskTitle(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === "Enter") { onAddTask(proc.id, newTaskTitle); setAddingTaskId(null); setNewTaskTitle(""); }
                          if (e.key === "Escape") { setAddingTaskId(null); setNewTaskTitle(""); }
                        }}
                        placeholder="작업 이름 입력 후 Enter"
                        style={{ flex: 1, padding: "7px 10px", background: T.surfaceHover, border: `1px solid ${T.accent}`,
                          borderRadius: 7, color: T.text, fontSize: 12, outline: "none", fontFamily: "inherit" }} />
                      <button onClick={() => { onAddTask(proc.id, newTaskTitle); setAddingTaskId(null); setNewTaskTitle(""); }}
                        style={{ padding: "7px 13px", background: T.accent, border: "none", borderRadius: 7, color: "#fff", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 700 }}>추가</button>
                      <button onClick={() => { setAddingTaskId(null); setNewTaskTitle(""); }}
                        style={{ padding: "7px 10px", background: T.surfaceHover, border: `1px solid ${T.border2}`, borderRadius: 7, color: T.textSub, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>취소</button>
                    </div>
                  ) : (
                    <button onClick={() => { setAddingTaskId(proc.id); setNewTaskTitle(""); }}
                      style={{ marginTop: 9, display: "flex", alignItems: "center", gap: 5,
                        color: T.textMuted, fontSize: 11, background: "none", border: "none", cursor: "pointer", padding: "4px 0", fontFamily: "inherit" }}>
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

// ─── TASK ROW ─────────────────────────────────────────────────────────────────
function TaskRow({ T, task, members, onChange, onDelete, onFileUpload, notify }) {
  const [editTitle, setEditTitle]   = useState(false);
  const [localTitle, setLocalTitle] = useState(task.title);
  const [showFiles, setShowFiles]   = useState(false);
  const fileInputRef                = useRef();

  const bgMap  = { todo: T.surfaceHover, doing: T.warn + "12", done: T.success + "10" };
  const bdrMap = { todo: T.border, doing: T.warn + "44", done: T.success + "44" };
  const cycle  = { todo: "doing", doing: "done", done: "todo" };
  const fCount = (task.files || []).length;

  const handleFiles = e => {
    const fs = Array.from(e.target.files);
    if (!fs.length) return;
    onFileUpload(fs);
    e.target.value = "";
  };

  return (
    <div style={{ background: bgMap[task.status], border: `1px solid ${bdrMap[task.status]}`, borderRadius: 8, overflow: "hidden", transition: "all .15s" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 11px" }}>
        <button onClick={() => {
          const ns = cycle[task.status];
          onChange({ status: ns });
          if (ns === "done") notify("✅ 완료!");
        }} style={{ width: 17, height: 17, borderRadius: 5, flexShrink: 0, cursor: "pointer",
          border: `2px solid ${SC[task.status]}`,
          background: task.status === "done" ? SC[task.status] : "transparent",
          display: "flex", alignItems: "center", justifyContent: "center" }}>
          {task.status === "done" && <SVG d={I.check} size={9} style={{ color: "#fff" }} />}
        </button>

        {editTitle ? (
          <input autoFocus value={localTitle} onChange={e => setLocalTitle(e.target.value)}
            onBlur={() => { onChange({ title: localTitle }); setEditTitle(false); }}
            onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()}
            style={{ flex: 1, background: "transparent", border: "none", borderBottom: `1px solid ${T.accent}`,
              color: T.text, fontSize: 12, outline: "none", fontFamily: "inherit" }} />
        ) : (
          <span onClick={() => setEditTitle(true)} style={{ flex: 1, color: task.status === "done" ? T.textMuted : T.text,
            fontSize: 12, textDecoration: task.status === "done" ? "line-through" : "none", cursor: "text" }}>
            {task.title}
          </span>
        )}

        <select value={task.memberId} onChange={e => {
          const m = members.find(x => x.id === e.target.value);
          onChange({ memberId: e.target.value, memberName: m?.name || "미할당" });
        }} style={{ padding: "3px 7px", background: T.surface, border: `1px solid ${T.border2}`,
          borderRadius: 5, color: T.textSub, fontSize: 10, outline: "none", fontFamily: "inherit" }}>
          <option value="">미할당</option>
          {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>

        <span style={{ padding: "2px 7px", borderRadius: 100, background: `${SC[task.status]}18`,
          color: SC[task.status], fontSize: 9, fontWeight: 700, whiteSpace: "nowrap" }}>
          {ST[task.status]}
        </span>

        <button onClick={() => fileInputRef.current?.click()}
          style={{ background: "none", border: "none", color: fCount > 0 ? T.accent : T.textMuted,
            cursor: "pointer", padding: 3, display: "flex", alignItems: "center", gap: 3 }}
          onMouseEnter={e => e.currentTarget.style.color = T.accent}
          onMouseLeave={e => e.currentTarget.style.color = fCount > 0 ? T.accent : T.textMuted}>
          <SVG d={I.paperclip} size={13} />
          {fCount > 0 && <span style={{ fontSize: 9, fontWeight: 700 }}>{fCount}</span>}
        </button>
        <input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={handleFiles} />

        {fCount > 0 && (
          <button onClick={() => setShowFiles(v => !v)}
            style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 3 }}>
            <SVG d={showFiles ? I.chevD : I.chevR} size={11} />
          </button>
        )}

        <button onClick={onDelete} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 3, flexShrink: 0 }}
          onMouseEnter={e => e.currentTarget.style.color = T.danger}
          onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
          <SVG d={I.trash} size={12} />
        </button>
      </div>

      {showFiles && fCount > 0 && (
        <div style={{ borderTop: `1px solid ${T.border}`, padding: "8px 11px", background: T.surface }}>
          <p style={{ color: T.textMuted, fontSize: 10, fontWeight: 600, marginBottom: 6 }}>📎 첨부 파일</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {(task.files || []).map(f => {
              const emoji = f.type?.startsWith("image/") ? "🖼️" : f.type?.includes("pdf") ? "📄" : f.name?.match(/\.(xlsx|xls)$/i) ? "📊" : f.name?.match(/\.(doc|docx)$/i) ? "📝" : f.name?.match(/\.(zip|rar)$/i) ? "🗜️" : "📎";
              return (
                <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 7,
                  padding: "5px 7px", background: T.surfaceHover, borderRadius: 6 }}>
                  <span style={{ fontSize: 13 }}>{emoji}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ color: T.text, fontSize: 11, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</p>
                    <p style={{ color: T.textMuted, fontSize: 9 }}>{((f.size || 0) / 1024).toFixed(1)}KB · {f.uploadedAt}</p>
                  </div>
                  <a href={f.url} target="_blank" rel="noreferrer" download={f.name}
                    style={{ color: T.accent, fontSize: 10, textDecoration: "none",
                      padding: "2px 7px", background: `${T.accent}15`, borderRadius: 4, border: `1px solid ${T.accent}44`, whiteSpace: "nowrap" }}>
                    {f.type?.startsWith("image/") ? "보기" : "열기"}
                  </a>
                  <button onClick={() => onChange({ files: (task.files || []).filter(x => x.id !== f.id) })}
                    style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 2 }}
                    onMouseEnter={e => e.currentTarget.style.color = T.danger}
                    onMouseLeave={e => e.currentTarget.style.color = T.textMuted}><SVG d={I.x} size={11} /></button>
                </div>
              );
            })}
          </div>
          <div onClick={() => fileInputRef.current?.click()}
            style={{ marginTop: 7, padding: "8px", background: T.surfaceHover, border: `1px dashed ${T.border2}`,
              borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center",
              gap: 5, cursor: "pointer", color: T.textMuted, fontSize: 11 }}>
            <SVG d={I.upload} size={11} /> 파일 추가
          </div>
        </div>
      )}
    </div>
  );
}

// ─── GANTT TAB ────────────────────────────────────────────────────────────────
function GanttTab({ T, project }) {
  const today  = new Date();
  const sDate  = project.startDate ? new Date(project.startDate) : new Date(today.getFullYear(), today.getMonth(), 1);
  const eDate  = project.endDate   ? new Date(project.endDate)   : new Date(today.getFullYear(), today.getMonth() + 2, 0);
  const diff   = Math.max(Math.ceil((eDate - sDate) / 86400000), 30);
  const dayW   = Math.max(Math.floor(700 / diff), 14);
  const days   = Array.from({ length: diff }, (_, i) => { const d = new Date(sDate); d.setDate(d.getDate() + i); return d; });
  const n      = project.procedures.length;
  const span   = Math.max(Math.floor(diff / (n || 1)), 3);
  const COLORS = ["#6366f1","#3b82f6","#10b981","#f59e0b","#ec4899","#ef4444","#8b5cf6","#f97316"];

  return (
    <div>
      <div style={{ marginBottom: 26 }}>
        <h1 style={{ color: T.text, fontSize: 24, fontWeight: 800, marginBottom: 4 }}>스케줄 관리</h1>
        <p style={{ color: T.textSub, fontSize: 13 }}>간트 차트로 프로젝트 일정을 시각화하세요</p>
      </div>
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 13, overflow: "auto" }}>
        <div style={{ display: "flex", borderBottom: `1px solid ${T.border}`, position: "sticky", top: 0, background: T.card, zIndex: 2 }}>
          <div style={{ width: 160, flexShrink: 0, padding: "9px 16px", borderRight: `1px solid ${T.border}`, color: T.textMuted, fontSize: 11, fontWeight: 600 }}>단계</div>
          <div style={{ display: "flex", minWidth: days.length * dayW }}>
            {days.map((d, i) => (
              <div key={i} style={{ width: dayW, flexShrink: 0, textAlign: "center",
                borderRight: d.getDay() === 0 ? `1px solid ${T.border}` : "none",
                background: d.toDateString() === today.toDateString() ? `${T.accent}18` : "transparent", padding: "3px 0" }}>
                {(i === 0 || d.getDate() === 1) && <div style={{ color: T.textMuted, fontSize: 8 }}>{d.getMonth() + 1}월</div>}
                {dayW >= 14 && <div style={{ color: d.toDateString() === today.toDateString() ? T.accent : T.textMuted, fontSize: 8 }}>{d.getDate()}</div>}
              </div>
            ))}
          </div>
        </div>
        {project.procedures.map((proc, pi) => {
          const bs    = pi * span;
          const be    = Math.min(bs + span * 2, diff);
          const color = COLORS[pi % COLORS.length];
          const t     = proc.tasks.length;
          const d2    = proc.tasks.filter(x => x.status === "done").length;
          const pct   = t ? d2 / t : 0;
          return (
            <div key={proc.id} style={{ display: "flex", borderBottom: `1px solid ${T.border}` }}>
              <div style={{ width: 160, flexShrink: 0, padding: "11px 16px", borderRight: `1px solid ${T.border}`,
                display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 12 }}>{proc.icon}</span>
                <span style={{ color: T.text, fontSize: 11, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{proc.name}</span>
              </div>
              <div style={{ position: "relative", flex: 1, height: 48, display: "flex", alignItems: "center" }}>
                {(() => { const off = Math.ceil((today - sDate) / 86400000);
                  return off >= 0 && off < diff
                    ? <div style={{ position: "absolute", left: off * dayW, top: 0, bottom: 0, width: 1, background: T.accent, opacity: .6, zIndex: 2 }} />
                    : null; })()}
                <div style={{ position: "absolute", left: bs * dayW + 2, width: (be - bs) * dayW - 4,
                  height: 24, borderRadius: 7, background: `${color}25`, border: `1px solid ${color}55`, overflow: "hidden" }}>
                  <div style={{ width: `${pct * 100}%`, height: "100%", background: `${color}66`, transition: "width .6s" }} />
                  <span style={{ position: "absolute", left: 7, top: "50%", transform: "translateY(-50%)", color: T.text, fontSize: 9, fontWeight: 700 }}>{Math.round(pct * 100)}%</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 10, display: "flex", gap: 14, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5, color: T.textMuted, fontSize: 11 }}>
          <div style={{ width: 9, height: 9, borderRadius: 2, background: T.accent }} /> 오늘
        </div>
        <p style={{ color: T.textMuted, fontSize: 11 }}>기간: {project.startDate || "미설정"} ~ {project.endDate || "미설정"}</p>
      </div>
    </div>
  );
}

// ─── MY TASKS TAB ─────────────────────────────────────────────────────────────
function MyTasksTab({ T, project, loginName, onTaskChange }) {
  const me      = project.members.find(m => m.name === loginName);
  const allMine = project.procedures.flatMap(proc =>
    proc.tasks.filter(t => t.memberId === me?.id || t.memberName === loginName)
      .map(t => ({ ...t, procName: proc.name, procIcon: proc.icon, procId: proc.id }))
  );
  const groups = {
    todo:  allMine.filter(t => t.status === "todo"),
    doing: allMine.filter(t => t.status === "doing"),
    done:  allMine.filter(t => t.status === "done"),
  };

  return (
    <div>
      <div style={{ marginBottom: 26 }}>
        <h1 style={{ color: T.text, fontSize: 24, fontWeight: 800, marginBottom: 4 }}>내 작업</h1>
        <p style={{ color: T.textSub, fontSize: 13 }}>{loginName}님에게 할당된 작업을 관리하세요</p>
      </div>
      {allMine.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 40px", background: T.card, borderRadius: 15, border: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>🎉</div>
          <p style={{ color: T.textSub, fontSize: 14, marginBottom: 5 }}>할당된 작업이 없습니다.</p>
          <p style={{ color: T.textMuted, fontSize: 12 }}>작업 관리 탭에서 "{loginName}"으로 담당자를 지정하세요.</p>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
          {Object.entries(groups).map(([status, tasks]) => (
            <div key={status}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 11 }}>
                <div style={{ width: 7, height: 7, borderRadius: "50%", background: SC[status] }} />
                <span style={{ color: T.textSub, fontSize: 12, fontWeight: 700 }}>{ST[status]}</span>
                <span style={{ color: T.textMuted, fontSize: 11 }}>({tasks.length})</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {tasks.map(t => (
                  <div key={t.id} style={{ padding: "12px 13px", background: T.card, border: `1px solid ${T.border}`, borderRadius: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 5 }}>
                      <span style={{ fontSize: 11 }}>{t.procIcon}</span>
                      <span style={{ color: T.textMuted, fontSize: 10 }}>{t.procName}</span>
                    </div>
                    <p style={{ color: t.status === "done" ? T.textMuted : T.text, fontSize: 12, fontWeight: 600,
                      textDecoration: t.status === "done" ? "line-through" : "none", marginBottom: 9 }}>{t.title}</p>
                    {t.files && t.files.length > 0 && (
                      <p style={{ color: T.accent, fontSize: 10, marginBottom: 8 }}>📎 {t.files.length}개 파일</p>
                    )}
                    <div style={{ display: "flex", gap: 4 }}>
                      {["todo","doing","done"].map(s => (
                        <button key={s} onClick={() => onTaskChange(t.procId, t.id, { status: s })}
                          style={{ flex: 1, padding: "4px 0", background: t.status === s ? `${SC[s]}18` : T.surfaceHover,
                            border: `1px solid ${t.status === s ? SC[s] : T.border2}`,
                            borderRadius: 5, color: t.status === s ? SC[s] : T.textMuted,
                            fontSize: 9, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                          {ST[s]}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
