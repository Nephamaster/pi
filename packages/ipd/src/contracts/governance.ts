// Store output-level provenance, review subjects, quality findings, and exact release authority.
import type { JsonValue } from "./primitives.ts";
import type { NodeOutputRef } from "./workflow.ts";

export type InputPurpose = "content_basis" | "test_subject" | "historical_reference";
export interface ArtifactRef {
	submissionId: string;
	nodeId: string;
	outputId: string;
	revisionId: string;
}
export interface ArtifactRevisionRecord extends ArtifactRef {
	manifestHash: string;
	contractHash: string;
	attemptId: string;
	participantId: string;
	status: "current" | "invalidated";
	bases: Array<{ revisionId: string; purpose: InputPurpose }>;
	createdAt: number;
}
export interface AdoptionRecord {
	adoptionId: string;
	submissionId: string;
	attemptId: string;
	inputRevisionIds: string[];
	releaseIds: string[];
	status: "active" | "held" | "superseded";
	replaces?: string;
	createdAt: number;
}
export interface ConsumptionView {
	outputId: string;
	purpose: string;
	keyResult: string;
	requirementRefs: string[];
	decisionRefs: string[];
	limitations: string[];
	navigation: string[];
	provenance: "producer_authored_summary";
}
export interface ReviewBundleRecord {
	bundleId: string;
	digest: string;
	baselineId: string;
	reviewNodeId: string;
	attemptId: string;
	targets: ArtifactRef[];
	inputs: ArtifactRef[];
	criteria: Array<{
		criterionId: string;
		blocking: boolean;
		subjectRevisionIds: string[];
		requiredParticipantIds: string[];
	}>;
	requiredRelations: Array<{ consumerRevisionId: string; basisRevisionId: string }>;
	policy: { aggregation: "all_required"; independentProduction: boolean };
	backgroundHash: string;
	createdAt: number;
}
export interface EvidenceRecord {
	evidenceId: string;
	attemptId: string;
	participantId: string;
	criterionId?: string;
	subjects: string[];
	provenance: "producer_statement" | "reviewer_observation" | "mechanical_execution";
	method: string;
	environmentRef?: string;
	observation: JsonValue;
	rawRef: string;
	rawDigest?: string;
	subjectFileRef?: string;
	locator?: string;
	limitations: string[];
	createdAt: number;
}
export interface AssessmentRecord {
	assessmentId: string;
	reviewId: string;
	bundleId: string;
	criterionId: string;
	participantId: string;
	subjectRevisionIds: string[];
	result: "PASS" | "FAIL" | "BLOCKED";
	evidenceIds: string[];
	rationale: string;
	status: "active" | "stale";
	independence: { productionContributors: string[]; sameModel: boolean | null };
}
export interface FindingRecord {
	findingId: string;
	assessmentId: string;
	reviewNodeId: string;
	criterionId: string;
	observedRevisionIds: string[];
	observation: string;
	locator?: string;
	rootCause: { status: "unknown" | "supported"; explanation: string };
	owner: NodeOutputRef;
	affectedRevisionId: string;
	expectedCondition: string;
	blocking: boolean;
	status: "open" | "addressed" | "resolved" | "withdrawn" | "superseded";
	claims: Array<{ submissionId: string; revisionId: string; evidence: string[]; explanation: string }>;
	resolution?: { assessmentId: string; revisionId: string; reason: string; replacementFindingId?: string };
	createdAt: number;
}
export interface GateDecisionRecord {
	decisionId: string;
	reviewId: string;
	bundleId: string;
	assessmentIds: string[];
	result: "PASS" | "REWORK" | "BLOCKED";
	blockingFindingIds: string[];
	status: "active" | "stale";
}
export interface ReleaseCertificateRecord {
	releaseId: string;
	decisionId: string;
	reviewNodeId: string;
	bundleId: string;
	subjectRevisionIds: string[];
	criterionIds: string[];
	stageIds: string[];
	status: "active" | "revoked";
}
export interface ContributionRecord {
	contributionId: string;
	participantId: string;
	nodeId: string;
	attemptId: string;
	revisionId: string;
	kind: "production";
	sessionId?: string;
}
export interface GovernanceState {
	artifacts: ArtifactRevisionRecord[];
	adoptions: AdoptionRecord[];
	reviewBundles: ReviewBundleRecord[];
	evidence: EvidenceRecord[];
	assessments: AssessmentRecord[];
	findings: FindingRecord[];
	decisions: GateDecisionRecord[];
	releases: ReleaseCertificateRecord[];
	contributions: ContributionRecord[];
}

export function emptyGovernanceState(): GovernanceState {
	return {
		artifacts: [],
		adoptions: [],
		reviewBundles: [],
		evidence: [],
		assessments: [],
		findings: [],
		decisions: [],
		releases: [],
		contributions: [],
	};
}
