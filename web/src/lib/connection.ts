// 상대 한 명과의 연결이 지켜야 할 약속.
// 구현체: PunchConnection (공인 주소, 홀 펀칭) / LocalConnection (같은 네트워크, 내부 주소)
// PeerManager는 어느 구현체인지 몰라도 이 인터페이스로만 다룬다.

export type ConnectionEvent =
  | { type: "punching" }
  | { type: "ice-connected" }
  | { type: "disconnected" }
  | { type: "failed"; reason: string }
  | { type: "connected"; pair: string | null }
  | { type: "closed" }
  | { type: "rtt"; rtt: number };

export interface ConnectionOptions {
  isCaller: boolean;
  iceServers?: RTCIceServer[];
  log: (msg: string) => void;
  onEvent: (e: ConnectionEvent) => void;
}

export interface Connection {
  /** 거는 쪽: 상대에게 보낼 offer SDP */
  createOffer(): Promise<string>;
  /** 받는 쪽: offer를 받아 상대에게 보낼 answer SDP */
  createAnswer(offerSdp: string): Promise<string>;
  /** 거는 쪽: 상대의 answer 적용 */
  acceptAnswer(answerSdp: string): Promise<void>;
  /** 연결된 뒤 왕복 시간 측정 */
  ping(): void;
  close(): void;
}
