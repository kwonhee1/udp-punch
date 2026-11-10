// 두 연결 방식이 같이 쓰는 WebRTC 부분.
// RTCPeerConnection + DataChannel 생성, 후보 수집 대기, ping/pong, 파일 송수신, 선택된 후보 쌍 확인.
// 어떤 후보를 상대에게 보낼지는 정하지 않는다 (각 Connection 구현체가 정한다).

import type { ConnectionOptions } from "./connection";
import { formatBytes } from "./format";

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const GATHER_TIMEOUT_MS = 5000;

const MAX_NAME_LENGTH = 255;
const MAX_MIME_LENGTH = 100;

// 문자열 메시지(JSON). 파일 내용은 "file" 메시지 바로 다음의 바이너리 메시지 하나로 보낸다.
type Message =
  | { type: "ping"; t: number }
  | { type: "pong"; t: number }
  | { type: "file"; name: string; size: number; mime: string };

type FileMeta = Omit<Extract<Message, { type: "file" }>, "type">;

export class RtcLink {
  private readonly pc: RTCPeerConnection;
  private ch: RTCDataChannel | null = null;
  private readonly opts: ConnectionOptions;
  /** "file" 메시지를 받고 내용(바이너리)을 기다리는 중인 파일 */
  private incoming: FileMeta | null = null;

  constructor(opts: ConnectionOptions) {
    this.opts = opts;
    this.pc = new RTCPeerConnection({ iceServers: opts.iceServers ?? DEFAULT_ICE_SERVERS });
    this.pc.onicecandidate = (e) => {
      if (e.candidate) opts.log(`로컬 후보: ${e.candidate.type} ${e.candidate.address ?? "?"}:${e.candidate.port ?? "?"}`);
    };
    this.pc.oniceconnectionstatechange = () => {
      const s = this.pc.iceConnectionState;
      opts.log(`ICE 연결 상태: ${s}`);
      if (s === "checking") opts.onEvent({ type: "punching" });
      else if (s === "connected" || s === "completed") opts.onEvent({ type: "ice-connected" });
      else if (s === "disconnected") opts.onEvent({ type: "disconnected" });
      else if (s === "failed") opts.onEvent({ type: "failed", reason: "ICE 실패" });
    };
  }

  /** offer를 만들고 후보 수집이 끝난 SDP(모든 후보 포함)를 돌려준다. */
  async offer(): Promise<string> {
    this.setupChannel(this.pc.createDataChannel("punch"));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await waitGathering(this.pc);
    return this.pc.localDescription?.sdp ?? "";
  }

  /** offer를 적용하고 answer를 만들어 후보 수집이 끝난 SDP(모든 후보 포함)를 돌려준다. */
  async answer(offerSdp: string): Promise<string> {
    this.pc.ondatachannel = (e) => this.setupChannel(e.channel);
    await this.pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await waitGathering(this.pc);
    return this.pc.localDescription?.sdp ?? "";
  }

  async acceptAnswer(answerSdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
  }

  ping(): void {
    this.send({ type: "ping", t: performance.now() });
  }

  /** 브라우저가 DataChannel 메시지 하나로 보낼 수 있는 최대 크기 (양쪽 SDP max-message-size 중 작은 값) */
  maxFileSize(): number | null {
    const max = this.pc.sctp?.maxMessageSize;
    return max == null || max <= 0 ? null : max;
  }

  async sendFile(file: File): Promise<void> {
    const ch = this.ch;
    if (ch?.readyState !== "open") throw new Error("연결되지 않음");
    const max = this.maxFileSize();
    if (max == null) throw new Error("최대 크기를 알 수 없음");
    if (file.size > max) {
      // 반올림하면 같아 보이는 경우(예: 256 KB + 1 B)는 바이트 단위로 보여준다
      const same = formatBytes(file.size) === formatBytes(max);
      const fmt = (n: number) => (same ? `${n.toLocaleString()} B` : formatBytes(n));
      throw new Error(`파일이 너무 큼 (${fmt(file.size)}, 최대 ${fmt(max)})`);
    }
    const data = await file.arrayBuffer();
    if (ch.readyState !== "open") throw new Error("연결이 끊김");
    const name = file.name.slice(0, MAX_NAME_LENGTH) || "이름 없음";
    const mime = file.type.slice(0, MAX_MIME_LENGTH);
    ch.send(JSON.stringify({ type: "file", name, size: data.byteLength, mime } satisfies Message));
    // 빈 파일은 내용 메시지를 보내지 않는다 (받는 쪽이 size 0이면 바로 끝낸다)
    if (data.byteLength > 0) ch.send(data);
    this.opts.log(`파일 보냄: ${name} (${formatBytes(data.byteLength)})`);
  }

  close(): void {
    this.pc.close();
  }

  private send(msg: Message): void {
    if (this.ch?.readyState === "open") this.ch.send(JSON.stringify(msg));
  }

  private onBinary(data: ArrayBuffer): void {
    const meta = this.incoming;
    this.incoming = null;
    if (!meta) {
      this.opts.log("파일 정보 없이 받은 데이터 무시");
      return;
    }
    if (data.byteLength !== meta.size) {
      this.opts.log(`파일 받기 실패: ${meta.name} (크기 다름: ${data.byteLength} / ${meta.size})`);
      return;
    }
    this.receiveFile(meta, toBlob(data));
  }

  private receiveFile(meta: FileMeta, data: Blob): void {
    this.opts.log(`파일 받음: ${meta.name} (${formatBytes(meta.size)})`);
    this.opts.onEvent({ type: "file", name: meta.name, mime: meta.mime, data });
  }

  private setupChannel(ch: RTCDataChannel): void {
    const { log, onEvent, isCaller } = this.opts;
    this.ch = ch;
    ch.binaryType = "arraybuffer";
    ch.onopen = async () => {
      log("DataChannel open");
      const pair = await this.selectedPair();
      onEvent({ type: "connected", pair });
      if (isCaller) this.ping();
    };
    ch.onclose = () => {
      log("DataChannel close");
      onEvent({ type: "closed" });
    };
    ch.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        this.onBinary(e.data);
        return;
      }
      let msg: Message;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (msg.type === "file") {
        const meta = toFileMeta(msg);
        if (!meta) {
          log("잘못된 파일 정보 무시");
        } else if (meta.size === 0) {
          this.receiveFile(meta, toBlob(new ArrayBuffer(0)));
        } else {
          this.incoming = meta;
        }
      } else if (msg.type === "ping") {
        log("ping 수신 → pong 전송");
        this.send({ type: "pong", t: msg.t });
      } else if (msg.type === "pong") {
        const rtt = performance.now() - msg.t;
        log(`pong 수신 (왕복 ${rtt.toFixed(1)}ms)`);
        onEvent({ type: "rtt", rtt });
      }
    };
  }

  /** 선택된 후보 쌍 ("srflx 1.2.3.4:5 ↔ srflx 6.7.8.9:10") */
  private async selectedPair(): Promise<string | null> {
    const stats = await this.pc.getStats();
    let pair: RTCIceCandidatePairStats | undefined;
    stats.forEach((s) => {
      if (s.type === "transport" && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
    });
    if (!pair) {
      // Firefox: transport에 selectedCandidatePairId가 없음
      stats.forEach((s) => {
        if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") pair = s;
      });
    }
    if (!pair) return null;
    const fmt = (c: Record<string, unknown> | undefined) =>
      c ? `${c.candidateType} ${c.address ?? c.ipAddress ?? ""}:${c.port ?? c.portNumber}` : "?";
    const text = `${fmt(stats.get(pair.localCandidateId))} ↔ ${fmt(stats.get(pair.remoteCandidateId))}`;
    this.opts.log(`선택된 후보 쌍: ${text}`);
    return text;
  }
}

/**
 * 받은 내용은 형식을 application/octet-stream으로 고정한다.
 * 상대가 html 등으로 속여 보내도 이 페이지 주소(blob:)에서 실행되지 않고 다운로드만 된다.
 */
function toBlob(data: ArrayBuffer): Blob {
  return new Blob([data], { type: "application/octet-stream" });
}

/** 상대가 보낸 파일 정보 검사 */
function toFileMeta(m: Record<string, unknown>): FileMeta | null {
  const { name, size, mime } = m;
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME_LENGTH) return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return null;
  if (typeof mime !== "string" || mime.length > MAX_MIME_LENGTH) return null;
  return { name, size, mime };
}

/** ICE 후보 수집이 끝날 때까지 기다린다 (최대 GATHER_TIMEOUT_MS). trickle ICE는 쓰지 않는다. */
export function waitGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, GATHER_TIMEOUT_MS);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

/** SDP 후보 줄 중 keep이 false인 줄을 지우고, 지운 수·남은 수를 센다. */
export function filterCandidates(sdp: string, keep: (candidateLine: string) => boolean) {
  let removed = 0;
  let kept = 0;
  const lines = sdp.split("\r\n").filter((line) => {
    if (!line.startsWith("a=candidate:")) return true;
    if (!keep(line)) {
      removed++;
      return false;
    }
    kept++;
    return true;
  });
  return { sdp: lines.join("\r\n"), removed, kept };
}

export const isHostCandidate = (line: string): boolean => / typ host( |$)/.test(line);

/** STUN에 한 번 물어봐 내 공인 IP를 얻는다 (IPv4 우선). 실패하면 null. */
export async function probePublicIp(iceServers = DEFAULT_ICE_SERVERS): Promise<string | null> {
  const pc = new RTCPeerConnection({ iceServers });
  const ips = new Set<string>();
  pc.onicecandidate = (e) => {
    if (e.candidate?.type === "srflx" && e.candidate.address) ips.add(e.candidate.address);
  };
  try {
    pc.createDataChannel("probe");
    await pc.setLocalDescription(await pc.createOffer());
    await waitGathering(pc);
  } finally {
    pc.close();
  }
  const list = [...ips];
  return list.find((ip) => !ip.includes(":")) ?? list[0] ?? null;
}
