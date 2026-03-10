import { supabase } from "@/lib/supabase";

export async function getTasksByProject(projectId) {
  const { data, error } = await supabase
    .from("tasks")
    .select("*, users:member_id ( id, name )")
    .eq("project_id", projectId);
  if (error) throw error;
  return data;
}

export async function createTask({ projectId, procedureId, title, memberId, status = "todo" }) {
  const { data, error } = await supabase
    .from("tasks")
    .insert({ project_id: projectId, procedure_id: procedureId, title, member_id: memberId || null, status, note: "" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateTask(taskId, updates) {
  const { data, error } = await supabase
    .from("tasks")
    .update(updates)
    .eq("id", taskId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteTask(taskId) {
  const { error } = await supabase.from("tasks").delete().eq("id", taskId);
  if (error) throw error;
}