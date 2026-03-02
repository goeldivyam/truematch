// ── Observation model ─────────────────────────────────────────────────────────

export interface DimensionObservation<T> {
  value: T;
  confidence: number; // 0.0–1.0
  observation_count: number;
  last_updated: string; // ISO 8601
  evidence_summary: string; // ONE sentence — NEVER transmitted to peer agents
}

// Attachment style (Bartholomew & Horowitz 1991)
export type AttachmentStyle = "secure" | "anxious" | "avoidant" | "fearful";
export interface AttachmentObservation {
  primary: AttachmentStyle;
  secondary: AttachmentStyle | null;
}

// Core values (Schwartz 1992) — ranked list
export type SchwartzValue =
  | "self-direction"
  | "stimulation"
  | "hedonism"
  | "achievement"
  | "power"
  | "security"
  | "conformity"
  | "tradition"
  | "benevolence"
  | "universalism";

export interface CoreValuesObservation {
  ranked: SchwartzValue[]; // index 0 = rank 1 (most important)
}

// Communication style (Leary circumplex + response rhythm)
export type DominanceLevel = "dominant" | "neutral" | "submissive";
export type AffiliationLevel = "warm" | "neutral" | "cold";
export type DirectnessLevel = "direct" | "indirect";
export type ConflictApproach = "confrontational" | "avoidant" | "collaborative";
export type ResponseLatency = "fast" | "moderate" | "slow";

export interface CommunicationObservation {
  dominance: DominanceLevel;
  affiliation: AffiliationLevel;
  directness: DirectnessLevel;
  emotional_disclosure: "high" | "moderate" | "low";
  conflict_approach: ConflictApproach;
  response_latency_preference: ResponseLatency;
}

// Emotional regulation (Gross 1998 + Gottman flooding signals)
export interface EmotionalRegulationObservation {
  regulation_level: "high" | "moderate" | "low";
  flooding_signals_present: boolean;
  reappraisal_tendency: "high" | "moderate" | "low";
  suppression_tendency: "high" | "moderate" | "low";
}

// Humor orientation (Martin 2007)
export type HumorOrientation =
  | "affiliative"
  | "self-enhancing"
  | "aggressive"
  | "self-defeating"
  | "dry"
  | "absurdist";

export interface HumorObservation {
  primary: HumorOrientation;
  secondary: HumorOrientation | null;
  irony_literacy: "high" | "moderate" | "low";
  levity_as_coping: boolean;
}

// Life velocity (Levinson/Arnett/Carstensen)
export type LifePhase =
  | "emerging-adulthood"
  | "early-adulthood"
  | "midlife"
  | "mature-adulthood"
  | "late-adulthood";

export type FutureOrientation = "expansive" | "stable" | "selective";

export interface LifeVelocityObservation {
  phase: LifePhase;
  future_orientation: FutureOrientation;
  ambition_domains: string[]; // e.g. ["career", "family", "creativity"]
}

// Dealbreakers
export interface Dealbreaker {
  constraint: string; // human-readable description
  is_hard: boolean; // hard = non-negotiable
  confidence: number; // 0.0–1.0
}

export interface DealbreakersObservation {
  constraints: Dealbreaker[];
}

// Full observation summary
export interface ObservationSummary {
  agent_version: string;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
  conversation_count: number;
  observation_span_days: number;
  total_signals: number;
  matching_eligible: boolean;

  attachment: DimensionObservation<AttachmentObservation>;
  core_values: DimensionObservation<CoreValuesObservation>;
  communication: DimensionObservation<CommunicationObservation>;
  emotional_regulation: DimensionObservation<EmotionalRegulationObservation>;
  humor: DimensionObservation<HumorObservation>;
  life_velocity: DimensionObservation<LifeVelocityObservation>;
  dealbreakers: DimensionObservation<DealbreakersObservation>;
}

// ── Identity ──────────────────────────────────────────────────────────────────

export interface TrueMatchIdentity {
  nsec: string; // hex-encoded private key (keep secret)
  npub: string; // hex-encoded x-only public key
  created_at: string; // ISO 8601
}

// ── Registry ──────────────────────────────────────────────────────────────────

export type ContactType = "email" | "discord" | "telegram";

export interface ContactChannel {
  type: ContactType;
  value: string;
}

export interface RegistrationRecord {
  pubkey: string;
  card_url: string;
  contact_channel: ContactChannel;
  registered_at: string;
  enrolled: boolean;
}

// ── Nostr / Negotiation ───────────────────────────────────────────────────────

export interface TrueMatchMessage {
  truematch: "1.0";
  thread_id: string;
  type: MessageType;
  timestamp: string; // ISO 8601
  payload: unknown;
}

export type MessageType =
  | "compatibility_probe"
  | "compatibility_response"
  | "match_propose"
  | "match_accept"
  | "match_decline"
  | "end";

export interface NegotiationState {
  thread_id: string;
  peer_pubkey: string;
  stage: 0 | 1 | 2 | 3 | 4 | 5;
  initiated_by_us: boolean;
  started_at: string;
  last_activity: string;
  status: "in_progress" | "matched" | "declined" | "expired";
  match_narrative?: MatchNarrative;
}

export interface MatchNarrative {
  headline: string;
  top_aligned_values: SchwartzValue[];
  shared_communication_style: string | null;
  strengths: string[];
  watch_points: string[];
}

// ── Persisted state files ─────────────────────────────────────────────────────

// ~/.truematch/identity.json
export type IdentityFile = TrueMatchIdentity;

// ~/.truematch/registration.json
export type RegistrationFile = RegistrationRecord;

// ~/.truematch/observation.json
export type ObservationFile = ObservationSummary;

// ~/.truematch/negotiation-state.json
export type NegotiationStateFile = NegotiationState | null;
