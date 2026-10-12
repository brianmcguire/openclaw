import type { AgentEventPayload } from "../infra/agent-events.js";

export type SessionObserverEvent = AgentEventPayload;

export type SessionObserverCompanionSnapshot = {
  agentId: string;
  runId?: string;
  digest?: import("../../packages/gateway-protocol/src/schema/sessions.js").SessionObserverDigest;
  notes: Array<{ sequence: number; text: string }>;
};

export type SessionObserverService = {
  handleEventAsync: (event: SessionObserverEvent) => Promise<void>;
  setConnectionVisibility: (connId: string, visible: boolean) => void;
  removeConnection: (connId: string) => void;
  getCompanionSnapshotAsync: (
    sessionKey: string,
    agentId?: string,
  ) => Promise<SessionObserverCompanionSnapshot>;
  disposeAsync: () => Promise<void>;
};
