// 공인 주소 방식 (1단계): host 후보를 지우고 srflx(STUN으로 얻은 바깥 주소)만 보낸다.
// 서로 다른 네트워크끼리 UDP 홀 펀칭으로 연결한다.

import type { Connection, ConnectionOptions } from "./connection";
import { RtcLink, filterCandidates, isHostCandidate } from "./rtc";

export class PunchConnection implements Connection {
  private readonly link: RtcLink;
  private readonly log: (msg: string) => void;

  constructor(opts: ConnectionOptions) {
    this.link = new RtcLink(opts);
    this.log = opts.log;
  }

  async createOffer(): Promise<string> {
    return this.publicOnly(await this.link.offer());
  }

  async createAnswer(offerSdp: string): Promise<string> {
    return this.publicOnly(await this.link.answer(offerSdp));
  }

  acceptAnswer(answerSdp: string): Promise<void> {
    return this.link.acceptAnswer(answerSdp);
  }

  ping(): void {
    this.link.ping();
  }

  sendFile(file: File): Promise<void> {
    return this.link.sendFile(file);
  }

  maxFileSize(): number | null {
    return this.link.maxFileSize();
  }

  close(): void {
    this.link.close();
  }

  private publicOnly(raw: string): string {
    const { sdp, removed, kept } = filterCandidates(raw, (line) => !isHostCandidate(line));
    this.log(`공인 주소 방식: host 후보 ${removed}개 제거, 남은 후보 ${kept}개`);
    if (kept === 0) throw new Error("공인 주소 후보 없음 (STUN 응답 실패)");
    return sdp;
  }
}
