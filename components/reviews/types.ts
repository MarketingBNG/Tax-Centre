import type {
  AuthorityStatus,
  Category,
  DefectKind,
  FindingAmount,
  FindingEvidence,
  FindingFix,
  FindingLocation,
  FindingStatus,
  Owner,
  ReturnType,
  RunStatus,
  Severity,
  StageKey,
  Verdict,
} from '@/lib/review-types';

/**
 * What GET /api/review-runs/[id] returns.
 *
 * Mirrors the route's response rather than the database rows: the screens work
 * from derived counts the server computed, so the summary, the print view and
 * the engagement list cannot end up disagreeing about the same register.
 */

export interface FindingView {
  id: string;
  code: string;
  stage: StageKey;
  kind: 'exception' | 'agreed' | 'coverage';
  defectKind: DefectKind | null;
  severity: Severity | null;
  category: Category;
  title: string;
  whatIsWrong: string;
  whyItMatters: string | null;
  location: FindingLocation | null;
  fix: FindingFix | null;
  authority: {
    status: AuthorityStatus;
    citation: string | null;
    sourceSpan: string | null;
    claimedCitation: string | null;
  };
  evidence: FindingEvidence[];
  amounts: FindingAmount[];
  owner: Owner | null;
  status: FindingStatus;
  statusNote: string | null;
  confidence: number | null;
  questionId: string | null;
  isOpen: boolean;
}

export interface RunDetail {
  run: {
    id: string;
    engagementId: string;
    runNumber: number;
    status: RunStatus;
    haltReason: string | null;
    verdict: Verdict | null;
    verdictDetail: { blockers?: string[]; criticalOpen?: number; highOpen?: number } | null;
    registerVersion: number;
    model: string;
    promptVersion: string;
    corpusHash: string;
    createdAt: number;
    finishedAt: number | null;
    errorText: string | null;
    abortRequested: boolean;
  };
  engagement: {
    id: string;
    clientLabel: string;
    entityName: string | null;
    ein: string | null;
    returnType: ReturnType | null;
    taxYear: number | null;
    periodStart: string | null;
    periodEnd: string | null;
  } | null;
  stages: {
    key: StageKey;
    label: string;
    seq: number;
    status: string;
    attempt: number;
    error: string | null;
    costMicros: number | null;
  }[];
  documents: {
    fileId: string;
    filename: string;
    kind: string;
    pageCount: number | null;
    docRole: string;
    parserId: string;
    parserConfidence: number | null;
  }[];
  findings: FindingView[];
  tieOuts: {
    id: string;
    name: string;
    leftValue: number | null;
    rightValue: number | null;
    agrees: boolean;
    findingId: string | null;
  }[];
  questions: {
    id: string;
    code: string;
    findingId: string | null;
    owner: 'preparer' | 'client';
    question: string;
    figure: string | null;
    branches: { if: string; then: string }[];
    evidenceNeeded: string | null;
    status: 'open' | 'answered' | 'ignored';
    answerText: string | null;
    answeredAt: number | null;
  }[];
  approval: {
    approvedBy: string;
    approvedAt: number;
    registerVersionSeen: number;
    verdictSeen: Verdict;
  } | null;
  derived: {
    categories: Record<string, { open: number; worst: Severity | null; label: string }>;
    topFindingIds: string[];
    openCriticalHigh: number;
    escalated: number;
  };
}
