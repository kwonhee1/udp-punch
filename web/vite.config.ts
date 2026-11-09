import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Supabase 설정은 프로젝트 루트(..)의 .env 또는 환경 변수(GitHub Actions)에서 읽는다.
// 프론트 번들에 들어가는 값은 아래 두 개뿐이다. 다른 키(비밀 키 등)는 넣지 않는다.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "..", "");
  const url = env.SUPABASE_URL ?? "";
  const key = env.SUPABASE_PUBLISHABLE_KEY ?? "";
  return {
    plugins: [react()],
    // 상대 경로: GitHub Pages(https://<아이디>.github.io/<저장소>/)에서 저장소 이름과 상관없이 동작
    base: "./",
    define: {
      __SUPABASE_URL__: JSON.stringify(url),
      __SUPABASE_KEY__: JSON.stringify(key),
    },
    server: { host: true },
  };
});
