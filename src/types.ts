export interface Probe {
  name: string;
  ok: boolean;
  skipped?: boolean;
  status?: number;
  note?: string;
  sample?: unknown;
}

export interface SpikeReport {
  startedAt: string;
  finishedAt: string;
  apiBase: string;
  probes: Probe[];
  gate: {
    readOk: boolean;
    importValidated: boolean | "not-tested";
    derivedWriteValidated: boolean | "not-tested";
    recommendation: string;
  };
}
