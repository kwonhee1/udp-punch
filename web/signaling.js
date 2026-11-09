import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm";
import { SUPABASE_URL, SUPABASE_KEY } from "./env.js"; // gen-env.sh로 생성

export const configured = Boolean(SUPABASE_URL && SUPABASE_KEY);

const db = configured ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// signal 행(id = 1)을 읽는다. 없으면 null.
export async function readSignal() {
  const { data, error } = await db
    .from("signal")
    .select("offer, answer")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// 새 offer를 쓰고 answer를 비운다.
export async function writeOffer(sdp) {
  const { error } = await db
    .from("signal")
    .upsert({ id: 1, offer: sdp, answer: null, updated_at: new Date().toISOString() });
  if (error) throw error;
}

export async function writeAnswer(sdp) {
  const { error } = await db
    .from("signal")
    .update({ answer: sdp, updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) throw error;
}

// signal 행이 바뀔 때마다 onRow(새 행)를 호출한다.
export function onSignalChange(onRow, onStatus) {
  db.channel("signal")
    .on("postgres_changes", { event: "*", schema: "public", table: "signal" }, (payload) =>
      onRow(payload.new),
    )
    .subscribe((status) => onStatus?.(status));
}
