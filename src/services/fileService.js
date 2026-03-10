import { supabase } from "@/lib/supabase";

const BUCKET = "task-files"; // Supabase Storage 버킷 이름

export async function uploadFile(taskId, file) {
  const ext = file.name.split(".").pop();
  const path = `${taskId}/${Date.now()}_${file.name}`;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { upsert: false });
  if (upErr) throw upErr;

  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(path);

  return {
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    type: file.type,
    url: urlData.publicUrl,
    path,
    uploadedAt: new Date().toLocaleString("ko-KR"),
  };
}

export async function deleteFile(path) {
  const { error } = await supabase.storage.from(BUCKET).remove([path]);
  if (error) throw error;
}