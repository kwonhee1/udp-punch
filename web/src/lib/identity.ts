// crypto.randomUUID는 보안 컨텍스트(HTTPS)에서만 동작하므로 getRandomValues로 만든다.
export function newId(bytes = 8): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function pick<T>(arr: readonly T[]): T {
  return arr[crypto.getRandomValues(new Uint8Array(1))[0] % arr.length];
}

const COLORS = ["파란", "빨간", "노란", "초록", "보라", "하얀", "까만", "주황"] as const;
const ANIMALS = ["고양이", "강아지", "여우", "판다", "토끼", "펭귄", "고래", "다람쥐"] as const;

export function randomName(): string {
  return `${pick(COLORS)} ${pick(ANIMALS)}`;
}

export function deviceLabel(ua = navigator.userAgent): string {
  const os = /Android/.test(ua) ? "Android"
    : /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Mac OS X/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows"
    : /Linux/.test(ua) ? "Linux"
    : "기타";
  const browser = /SamsungBrowser/.test(ua) ? "Samsung"
    : /Edg\//.test(ua) ? "Edge"
    : /CriOS|Chrome/.test(ua) ? "Chrome"
    : /FxiOS|Firefox/.test(ua) ? "Firefox"
    : /Safari/.test(ua) ? "Safari"
    : "브라우저";
  return `${os} · ${browser}`;
}
