import { supabase } from "./supabase";

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  let out = "";
  for (let i = 0; i < 5; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export async function createRoom(initialState) {
  if (!supabase) throw new Error("Supabase is not configured");
  let code = randomCode();
  // extremely unlikely, but make sure the code isn't already taken
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data } = await supabase.from("rooms").select("id").eq("id", code).maybeSingle();
    if (!data) break;
    code = randomCode();
  }
  const { error } = await supabase.from("rooms").insert({
    id: code,
    state: initialState,
    host_present: true,
    guest_present: false,
  });
  if (error) throw error;
  return code;
}

export async function joinRoom(code) {
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = await supabase.from("rooms").select("*").eq("id", code).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("No room found with that code");
  if (data.guest_present) throw new Error("That room already has two players");
  const { error: updateError } = await supabase
    .from("rooms")
    .update({ guest_present: true, updated_at: new Date().toISOString() })
    .eq("id", code);
  if (updateError) throw updateError;
  return data.state;
}

export async function pushRoomState(code, state) {
  if (!supabase) return;
  await supabase.from("rooms").update({ state, updated_at: new Date().toISOString() }).eq("id", code);
}

export async function leaveRoom(code, role) {
  if (!supabase) return;
  const field = role === "P1" ? { host_present: false } : { guest_present: false };
  await supabase.from("rooms").update(field).eq("id", code);
}

export function subscribeToRoom(code, onChange) {
  if (!supabase) return () => {};
  const channel = supabase
    .channel(`room-${code}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "rooms", filter: `id=eq.${code}` },
      (payload) => onChange(payload.new)
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}
