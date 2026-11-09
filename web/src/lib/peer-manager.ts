// 로비(접속 기기 목록)와 상대별 연결을 관리한다.
// - 목록: Supabase Realtime presence
// - 시그널링: Supabase Realtime broadcast (offer·answer를 상대 id로 보낸다)
// React에 의존하지 않는다. subscribe / getSnapshot으로 화면에 상태를 넘긴다.

import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { deviceLabel, newId, randomName } from "./identity";
import { DEFAULT_ICE_SERVERS, Punch, probePublicIp, type PunchEvent } from "./punch";

const LOBBY_TOPIC = "lobby";
const CONNECT_TIMEOUT_MS = 20000;
const MAX_LOGS = 500;

export interface PeerInfo {
  id: string;
  name: string;
  device: string;
  ip: string | null;
}

export type SessionState = "gathering" | "waiting" | "punching" | "connected" | "disconnected" | "failed" | "closed";

export interface SessionView {
  role: "caller" | "callee";
  /** 같은 네트워크 방식(host 후보 유지)으로 연결 중인지 */
  local: boolean;
  state: SessionState;
  pair?: string | null;
  rtt?: number;
  reason?: string;
}

export interface Snapshot {
  me: PeerInfo;
  lobby: string;
  ipProbed: boolean;
  peers: readonly PeerInfo[];
  sessions: Readonly<Record<string, SessionView>>;
  logs: readonly string[];
}

export interface PeerManagerConfig {
  supabaseUrl: string;
  supabaseKey: string;
  iceServers?: RTCIceServer[];
}

interface Session {
  sid: string;
  answered: boolean;
  punch: Punch;
  view: SessionView;
  timer: ReturnType<typeof setTimeout>;
}

type Signal = {
  from: string;
  to: string;
  kind: "offer" | "answer";
  sid: string;
  sdp: string;
  local?: boolean;
};

export class PeerManager {
  private readonly config: PeerManagerConfig;
  private readonly me: PeerInfo;
  private readonly peers = new Map<string, PeerInfo>();
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<() => void>();
  private logs: string[] = [];
  private lobby = "접속 중…";
  private ipProbed = false;
  private db: SupabaseClient | null = null;
  private channel: RealtimeChannel | null = null;
  private subscribed = false;
  private gen = 0; // start/stop마다 증가. 이전 start의 늦은 콜백을 무시하는 데 쓴다.
  private snapshot: Snapshot;

  constructor(config: PeerManagerConfig) {
    this.config = config;
    this.me = { id: newId(), name: randomName(), device: deviceLabel(), ip: null };
    this.snapshot = this.buildSnapshot();
  }

  // ===== 외부 API =====

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): Snapshot => this.snapshot;

  start(): void {
    if (this.db) return;
    const gen = ++this.gen;
    const alive = () => gen === this.gen;

    if (!this.config.supabaseUrl || !this.config.supabaseKey) {
      this.lobby = "설정 없음 (.env 확인)";
      this.log("오류: SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY가 비어 있음");
      this.emit();
      return;
    }

    // start마다 새 클라이언트를 만든다. 이전 채널이 정리되는 중이어도 섞이지 않는다.
    const db = createClient(this.config.supabaseUrl, this.config.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const channel = db.channel(LOBBY_TOPIC, {
      config: { presence: { key: this.me.id }, broadcast: { self: false } },
    });
    this.db = db;
    this.channel = channel;

    channel.on("presence", { event: "sync" }, () => {
      if (!alive()) return;
      this.peers.clear();
      for (const [key, metas] of Object.entries(channel.presenceState())) {
        if (key === this.me.id || metas.length === 0) continue;
        const info = toPeerInfo(key, metas[metas.length - 1]);
        if (info) this.peers.set(key, info);
      }
      this.emit();
    });

    channel.on("broadcast", { event: "signal" }, ({ payload }) => {
      if (!alive()) return;
      const sig = toSignal(payload);
      if (sig && sig.to === this.me.id) this.run(() => this.handleSignal(sig));
    });

    channel.subscribe((status) => {
      if (!alive()) return;
      this.log(`로비 상태: ${status}`);
      this.subscribed = status === "SUBSCRIBED";
      this.lobby = this.subscribed ? "로비 접속됨" : `로비: ${status}`;
      if (this.subscribed) this.track();
      this.emit();
    });

    this.run(async () => {
      const ip = await probePublicIp(this.config.iceServers ?? DEFAULT_ICE_SERVERS);
      if (!alive()) return;
      this.me.ip = ip;
      this.ipProbed = true;
      this.log(`내 공인 주소: ${ip ?? "확인 실패"}`);
      if (this.subscribed) this.track();
      this.emit();
    });
  }

  stop(): void {
    this.gen++;
    for (const id of [...this.sessions.keys()]) this.endSession(id);
    this.peers.clear();
    this.subscribed = false;
    const db = this.db;
    this.db = null;
    this.channel = null;
    if (db) void db.removeAllChannels();
    this.lobby = "연결 끊김";
    this.emit();
  }

  /** 목록에서 상대를 눌렀을 때 */
  connect(peerId: string): void {
    this.run(() => this.connectTo(peerId));
  }

  ping(peerId: string): void {
    this.sessions.get(peerId)?.punch.ping();
  }

  isSameNetwork(peer: PeerInfo): boolean {
    return Boolean(this.me.ip && peer.ip && this.me.ip === peer.ip);
  }

  // ===== 연결 =====

  private async connectTo(peerId: string): Promise<void> {
    const peer = this.peers.get(peerId);
    // 상대 공인 IP가 내 공인 IP와 같으면 같은 네트워크 방식(host 후보 유지)으로 연결한다
    const local = peer ? this.isSameNetwork(peer) : false;
    this.endSession(peerId);
    const s = this.newSession(peerId, "caller", local);
    this.update(peerId, "gathering");
    try {
      const sdp = await s.punch.createOffer(local);
      if (this.sessions.get(peerId) !== s) return;
      await this.send({ to: peerId, kind: "offer", sid: s.sid, sdp, local });
      this.log(`[${this.tag(peerId)}] offer 전송 (${local ? "같은 네트워크 방식" : "공인 주소 방식"}) → answer 대기`);
      this.update(peerId, "waiting");
    } catch (e) {
      this.update(peerId, "failed", { reason: errorMessage(e) });
      throw e;
    }
  }

  private async handleSignal(sig: Signal): Promise<void> {
    const { from, kind, sid, sdp } = sig;
    if (kind === "offer") {
      const cur = this.sessions.get(from);
      // 양쪽이 동시에 누른 경우: id가 작은 쪽의 offer만 살린다
      if (cur?.view.role === "caller" && !cur.answered && this.me.id < from) {
        this.log("동시 연결 시도: 내 offer를 유지");
        return;
      }
      const local = sig.local === true;
      this.endSession(from);
      const s = this.newSession(from, "callee", local, sid);
      this.log(`[${this.tag(from)}] offer 수신 → answer 생성`);
      this.update(from, "gathering");
      try {
        const answer = await s.punch.createAnswer(sdp, local);
        if (this.sessions.get(from) !== s) return;
        await this.send({ to: from, kind: "answer", sid, sdp: answer });
        this.log(`[${this.tag(from)}] answer 전송`);
        this.update(from, "punching");
      } catch (e) {
        this.update(from, "failed", { reason: errorMessage(e) });
        throw e;
      }
    } else {
      const s = this.sessions.get(from);
      if (!s || s.view.role !== "caller" || s.sid !== sid || s.answered) return;
      s.answered = true;
      this.log(`[${this.tag(from)}] answer 수신 → 적용`);
      await s.punch.acceptAnswer(sdp);
      this.update(from, "punching");
    }
  }

  private newSession(peerId: string, role: "caller" | "callee", local: boolean, sid = newId()): Session {
    const tag = this.tag(peerId);
    const s: Session = {
      sid,
      answered: false,
      view: { role, local, state: "gathering" },
      timer: setTimeout(() => {
        if (this.sessions.get(peerId) === s && s.view.state !== "connected") {
          this.update(peerId, "failed", { reason: "시간 초과" });
        }
      }, CONNECT_TIMEOUT_MS),
      punch: new Punch({
        isCaller: role === "caller",
        iceServers: this.config.iceServers,
        log: (msg) => this.log(`[${tag}] ${msg}`),
        onEvent: (e) => {
          if (this.sessions.get(peerId) === s) this.onPunchEvent(peerId, e);
        },
      }),
    };
    this.sessions.set(peerId, s);
    return s;
  }

  private endSession(peerId: string): void {
    const s = this.sessions.get(peerId);
    if (!s) return;
    clearTimeout(s.timer);
    this.sessions.delete(peerId); // 먼저 지워서 close 이후 이벤트를 무시한다
    s.punch.close();
  }

  private onPunchEvent(peerId: string, e: PunchEvent): void {
    const s = this.sessions.get(peerId);
    if (!s) return;
    const v = s.view;
    switch (e.type) {
      case "rtt":
        v.rtt = e.rtt;
        break;
      case "ice-connected":
        if (v.state === "disconnected") v.state = "connected";
        break;
      case "punching":
        if (v.state !== "connected") v.state = "punching";
        break;
      case "disconnected":
        if (v.state === "connected") v.state = "disconnected";
        else this.setFailed(v, "상대에게 닿지 않음");
        break;
      case "closed":
        if (v.state === "connected") v.state = "closed";
        break;
      case "connected":
        v.state = "connected";
        v.pair = e.pair;
        break;
      case "failed":
        this.setFailed(v, e.reason);
        break;
    }
    this.afterUpdate(s);
  }

  private update(peerId: string, state: SessionState, extra: Partial<SessionView> = {}): void {
    const s = this.sessions.get(peerId);
    if (!s) return;
    Object.assign(s.view, extra, { state });
    this.afterUpdate(s);
  }

  private setFailed(v: SessionView, reason: string): void {
    v.state = "failed";
    v.reason = reason;
  }

  private afterUpdate(s: Session): void {
    if (s.view.state === "connected" || s.view.state === "failed") clearTimeout(s.timer);
    this.emit();
  }

  // ===== 로비 =====

  private track(): void {
    void this.channel?.track({ id: this.me.id, name: this.me.name, device: this.me.device, ip: this.me.ip });
  }

  private async send(msg: Omit<Signal, "from">): Promise<void> {
    if (!this.channel) throw new Error("로비에 접속되지 않음");
    await this.channel.send({ type: "broadcast", event: "signal", payload: { ...msg, from: this.me.id } });
  }

  // ===== 공통 =====

  private tag(peerId: string): string {
    return this.peers.get(peerId)?.name ?? peerId;
  }

  private log(msg: string): void {
    this.logs = [...this.logs, `[${new Date().toLocaleTimeString()}] ${msg}`].slice(-MAX_LOGS);
    console.log(msg);
    this.emit();
  }

  private run(fn: () => Promise<void>): void {
    fn().catch((e) => this.log(`오류: ${errorMessage(e)}`));
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const fn of this.listeners) fn();
  }

  private buildSnapshot(): Snapshot {
    const sessions: Record<string, SessionView> = {};
    for (const [id, s] of this.sessions) sessions[id] = { ...s.view };
    return {
      me: { ...this.me },
      lobby: this.lobby,
      ipProbed: this.ipProbed,
      peers: [...this.peers.values()],
      sessions,
      logs: this.logs,
    };
  }
}

// ===== 상대가 보낸 값 검사 (로비는 누구나 쓸 수 있으므로 형태를 확인한다) =====

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;

function toPeerInfo(key: string, meta: Record<string, unknown>): PeerInfo | null {
  return {
    id: key,
    name: str(meta.name, 40) ?? key,
    device: str(meta.device, 40) ?? "",
    ip: str(meta.ip, 64),
  };
}

function toSignal(p: unknown): Signal | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  const from = str(o.from, 64);
  const to = str(o.to, 64);
  const sid = str(o.sid, 64);
  const sdp = str(o.sdp, 20000);
  if (!from || !to || !sid || !sdp || (o.kind !== "offer" && o.kind !== "answer")) return null;
  return { from, to, sid, sdp, kind: o.kind, local: o.local === true };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
