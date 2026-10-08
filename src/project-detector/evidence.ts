export type EvidenceStrength = "high" | "medium" | "low";

export interface DetectionEvidence {
  detector: string;

  signal: string;

  source: string;

  strength: EvidenceStrength;

  location?: {
    file: string;
    line?: number;
    column?: number;
  };
}
