import { supabase } from "@/lib/supabase";

// 내 프로젝트 목록 (멤버로 참여 중인 것 포함)
export async function getMyProjects(userId) {
  const { data, error } = await supabase
    .from("project_members")
    .select(`
      project_id,
      projects (
        id, name, topic, start_date, end_date, owner_id, created_at,
        procedures ( id, name, icon, color, order_index,
          tasks ( id, status )
        ),
        project_members ( id, user_id,
          users ( id, name )
        )
      )
    `)
    .eq("user_id", userId);

  if (error) throw error;
  return data.map(d => d.projects);
}

// 프로젝트 생성 (트랜잭션 흉내: 순차 insert)
export async function createProject({ name, topic, startDate, endDate, ownerId, members, procedures }) {
  // 1. 프로젝트 생성
  const { data: project, error: pErr } = await supabase
    .from("projects")
    .insert({ name, topic, start_date: startDate, end_date: endDate, owner_id: ownerId })
    .select()
    .single();
  if (pErr) throw pErr;

  // 2. 멤버 추가 (owner 포함)
  const memberRows = members.map(m => ({
    project_id: project.id,
    user_id: m.id,
    role: m.role || "member",
  }));
  // owner가 members에 없으면 추가
  if (!memberRows.find(r => r.user_id === ownerId)) {
    memberRows.push({ project_id: project.id, user_id: ownerId, role: "owner" });
  }
  const { error: mErr } = await supabase.from("project_members").insert(memberRows);
  if (mErr) throw mErr;

  // 3. 절차 추가
  if (procedures?.length) {
    const procRows = procedures.map((p, i) => ({
      project_id: project.id,
      name: p.name,
      icon: p.icon || "📌",
      color: p.color || "#6366f1",
      order_index: i,
    }));
    const { data: createdProcs, error: prErr } = await supabase
      .from("procedures")
      .insert(procRows)
      .select();
    if (prErr) throw prErr;

    // 4. 절차별 task 생성
    const taskRows = [];
    createdProcs.forEach((proc, i) => {
      const srcProc = procedures[i];
      const customTasks = srcProc.customTasks || [];
      if (customTasks.length > 0) {
        customTasks.forEach(ct => {
          taskRows.push({
            project_id: project.id,
            procedure_id: proc.id,
            title: ct.title,
            member_id: ct.memberId || null,
            status: "todo",
            note: "",
          });
        });
      } else {
        // 팀원별 자동 생성
        members.forEach(m => {
          taskRows.push({
            project_id: project.id,
            procedure_id: proc.id,
            title: `${proc.name} — ${m.name}`,
            member_id: m.id,
            status: "todo",
            note: "",
          });
        });
      }
    });
    if (taskRows.length) {
      const { error: tErr } = await supabase.from("tasks").insert(taskRows);
      if (tErr) throw tErr;
    }
  }

  return project;
}

export async function deleteProject(projectId) {
  // Supabase FK cascade 설정 시 자동 삭제, 아니면 수동
  const { error } = await supabase.from("projects").delete().eq("id", projectId);
  if (error) throw error;
}

export async function updateProcedureOrder(projectId, procedures) {
  const updates = procedures.map((p, i) =>
    supabase.from("procedures").update({ order_index: i }).eq("id", p.id)
  );
  await Promise.all(updates);
}

export async function addProcedure(projectId, { name, icon, color, orderIndex }) {
  const { data, error } = await supabase
    .from("procedures")
    .insert({ project_id: projectId, name, icon: icon || "📌", color: color || "#6366f1", order_index: orderIndex })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateProcedure(procId, updates) {
  const { data, error } = await supabase
    .from("procedures")
    .update(updates)
    .eq("id", procId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteProcedure(procId) {
  const { error } = await supabase.from("procedures").delete().eq("id", procId);
  if (error) throw error;
}