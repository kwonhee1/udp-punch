#!/bin/sh
# .env에서 프론트용 값만 골라 web/env.js를 만든다.
set -e
cd "$(dirname "$0")"
set -a; . ./.env; set +a
cat > web/env.js <<JS
// gen-env.sh가 .env에서 생성한 파일. 직접 수정하지 않는다.
export const SUPABASE_URL = "$SUPABASE_URL";
export const SUPABASE_KEY = "$SUPABASE_PUBLISHABLE_KEY";
JS
echo "web/env.js 생성 완료"
