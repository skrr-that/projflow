import { supabase } from "@/lib/supabase";

// 이름으로 유저 조회 또는 생성 (현재 앱의 이름 기반 로그인 방식)
export async function getOrCreateUser(name) {
  // 기존 유저 조회
  const { data: existing } = await supabase
    .from("users")
    .select("*")
    .eq("name", name)
    .single();

  if (existing) return existing;

  // 없으면 생성
  const { data, error } = await supabase
    .from("users")
    .insert({ name })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function getUserByName(name) {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("name", name)
    .single();
  if (error) throw error;
  return data;
}