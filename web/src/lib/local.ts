// 같은 네트워크 방식 (2단계): host 후보(내부 주소)를 지우지 않고 모든 후보를 보낸다.
// 같은 공유기 아래 기기끼리 공유기를 거치지 않고 host ↔ host로 연결한다.
// 공유기가 헤어핀 NAT를 지원하지 않아도 된다.

import type { Connection, ConnectionOptions } from "./connection";
import { RtcLink, filterCandidates } from "./rtc";

export class LocalConnection implements Connection {
  private readonly link: RtcLink;
  private readonly log: (msg: string) => void;

  constructor(opts: ConnectionOptions) {
    this.link = new RtcLink(opts);
    this.log = opts.log;
  }

  async createOffer(): Promise<string> {
    return this.allCandidates(await this.link.offer());
  }

  async createAnswer(offerSdp: string): Promise<string> {
    return this.allCandidates(await this.link.answer(offerSdp));
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

  private allCandidates(raw: string): string {
    const { sdp, kept } = filterCandidates(raw, () => true);
    this.log(`같은 네트워크 방식: host 후보 유지, 후보 ${kept}개`);
    if (kept === 0) throw new Error("후보 없음");
    return sdp;
  }
}
