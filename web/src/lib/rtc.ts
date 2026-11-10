// 두 연결 방식이 같이 쓰는 WebRTC 부분.
// RTCPeerConnection + DataChannel 생성, 후보 수집 대기, ping/pong, 선택된 후보 쌍 확인.
// 어떤 후보를 상대에게 보낼지는 정하지 않는다 (각 Connection 구현체가 정한다).

import type { ConnectionOptions } from "./connection";

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const GATHER_TIMEOUT_MS = 5000;

type Message = { type: "ping"; t: number } | { type: "pong"; t: number };

export class RtcLink {
  private readonly pc: RTCPeerConnection;
  private ch: RTCDataChannel | null = null;
  private readonly opts: ConnectionOptions;

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

  close(): void {
    this.pc.close();
  }

  private send(msg: Message): void {
    if (this.ch?.readyState === "open") this.ch.send(JSON.stringify(msg));
  }

  private setupChannel(ch: RTCDataChannel): void {
    const { log, onEvent, isCaller } = this.opts;
    this.ch = ch;
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
      let msg: Message;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (msg.type === "ping") {
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
