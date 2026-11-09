const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const GATHER_TIMEOUT_MS = 5000;

export class Punch {
  constructor(log, isCaller) {
    this.log = log;
    this.isCaller = isCaller;
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const c = e.candidate;
      log(`로컬 후보: ${c.type} ${c.address ?? "?"}:${c.port ?? "?"}`);
    };
    this.pc.oniceconnectionstatechange = () => {
      log(`ICE 연결 상태: ${this.pc.iceConnectionState}`);
    };
  }

  // A: offer SDP 생성 (host 후보 제거됨)
  async createOffer() {
    this.setupChannel(this.pc.createDataChannel("punch"));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await waitGathering(this.pc);
    return this.localSdp();
  }

  // B: offer를 받아 answer SDP 생성 (host 후보 제거됨)
  async createAnswer(offerSdp) {
    this.pc.ondatachannel = (e) => this.setupChannel(e.channel);
    await this.pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await waitGathering(this.pc);
    return this.localSdp();
  }

  // A: answer 적용
  async acceptAnswer(answerSdp) {
    await this.pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
  }

  localSdp() {
    const { sdp, removed, kept } = stripHostCandidates(this.pc.localDescription.sdp);
    this.log(`host 후보 ${removed}개 제거, 남은 후보 ${kept}개`);
    if (kept === 0) this.log("경고: 남은 후보 없음 (STUN 응답 실패)");
    return sdp;
  }

  setupChannel(ch) {
    ch.onopen = async () => {
      this.log("DataChannel open");
      await this.reportPair();
      if (this.isCaller) ch.send(JSON.stringify({ type: "ping", t: performance.now() }));
    };
    ch.onclose = () => this.log("DataChannel close");
    ch.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "ping") {
        this.log("ping 수신 → pong 전송");
        ch.send(JSON.stringify({ type: "pong", t: msg.t }));
      } else if (msg.type === "pong") {
        this.log(`pong 수신 (왕복 ${(performance.now() - msg.t).toFixed(1)}ms)`);
      }
    };
  }

  // 선택된 후보 쌍 표시
  async reportPair() {
    const stats = await this.pc.getStats();
    let pair = null;
    stats.forEach((s) => {
      if (s.type === "transport" && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
    });
    if (!pair) {
      // Firefox: transport에 selectedCandidatePairId가 없음
      stats.forEach((s) => {
        if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") pair = s;
      });
    }
    if (!pair) return this.log("선택된 후보 쌍을 찾지 못함");

    const fmt = (c) => `${c.candidateType} ${c.address ?? c.ipAddress}:${c.port ?? c.portNumber}`;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    this.log(`선택된 후보 쌍: ${fmt(local)} ↔ ${fmt(remote)}`);
  }

  close() {
    this.pc.close();
  }
}

function waitGathering(pc) {
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

function stripHostCandidates(sdp) {
  let removed = 0;
  let kept = 0;
  const lines = sdp.split("\r\n").filter((line) => {
    if (!line.startsWith("a=candidate:")) return true;
    if (/ typ host( |$)/.test(line)) {
      removed++;
      return false;
    }
    kept++;
    return true;
  });
  return { sdp: lines.join("\r\n"), removed, kept };
}
