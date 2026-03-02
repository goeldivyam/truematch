// ── Observation model ─────────────────────────────────────────────────────────

export interface DimensionObservation<T> {
  value: T;
  confidence: number; // 0.0–1.0
  observation_count: number;
  last_updated: string; // ISO 8601
  evidence_summary: string; // ONE sentence — NEVER transmitted to peer agents
  // low = single context only (e.g. only work chat); caps composite contribution at 0.65
  behavioral_context_diversity: "low" | "medium" | "high";
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
  truematch: "2.0";
  thread_id: string;
  type: MessageType;
  timestamp: string; // ISO 8601
  content: string; // free-form text or JSON-serialised MatchNarrative
}

export type MessageType =
  | "negotiation"
  | "match_propose"
  | "match_decline"
  | "end";

export interface NegotiationMessage {
  role: "us" | "peer";
  content: string;
  timestamp: string; // ISO 8601
}

export interface NegotiationState {
  thread_id: string;
  peer_pubkey: string;
  round_count: number;
  initiated_by_us: boolean;
  started_at: string;
  last_activity: string;
  status: "in_progress" | "matched" | "declined" | "expired";
  messages: NegotiationMessage[];
  match_narrative?: MatchNarrative;
}

export interface MatchNarrative {
  headline: string;
  strengths: string[];
  watch_points: string[];
  confidence_summary: string;
}

// ── Persisted state files ─────────────────────────────────────────────────────

// ~/.truematch/identity.json
export type IdentityFile = TrueMatchIdentity;

// ~/.truematch/registration.json
export type RegistrationFile = RegistrationRecord;

// ~/.truematch/observation.json
export type ObservationFile = ObservationSummary;

// ~/.truematch/threads/<thread_id>.json
export type ThreadFile = NegotiationState;
