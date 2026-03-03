// ── Observation model — slim pre-flight manifest ──────────────────────────────
// Stores only what the eligibility gate needs (confidence scores, diversity flags,
// observation counts). Claude reasons about personality from its own memory —
// the value sub-objects (attachment style, values array, etc.) live there, not here.

export interface DimensionMeta {
  confidence: number; // 0.0–1.0, pre-decayed at last /new hook
  observation_count: number; // signals observed for this dimension
  behavioral_context_diversity: "low" | "medium" | "high";
  // "low" = single context only — caps composite contribution at 0.65
}

export type DealbreakersGateState =
  | "confirmed" // ≥1 hard constraint at confidence ≥ 0.50, OR positively observed open
  | "below_floor" // has constraints but none clear the 0.50 confidence floor yet
  | "none_observed"; // no dealbreaker signals at all — blocks pool entry

export type InferredIntentCategory = "serious" | "casual" | "unclear";

export interface ObservationSummary {
  // Manifest metadata
  updated_at: string; // ISO 8601 — when Claude last wrote this file
  eligibility_computed_at: string; // ISO 8601 — when gate was last evaluated
  matching_eligible: boolean; // pre-computed gate result

  // Global observation span
  conversation_count: number;
  observation_span_days: number;

  // Per-dimension metadata (×7)
  attachment: DimensionMeta;
  core_values: DimensionMeta;
  communication: DimensionMeta;
  emotional_regulation: DimensionMeta;
  humor: DimensionMeta;
  life_velocity: DimensionMeta;
  dealbreakers: DimensionMeta;

  // Dealbreaker gate state (3-valued — can't collapse to boolean)
  dealbreaker_gate_state: DealbreakersGateState;

  // Inferred relationship intent — derived from life_velocity + relationship orientation signals.
  // NOT user-set. Used for pre-negotiation early termination only when both agents have
  // non-unclear categories at ≥0.65 confidence on the underlying dimensions.
  inferred_intent_category?: InferredIntentCategory;
}

// ── User preferences — Layer 0 eligibility predicates ────────────────────────
// Hard filters set by the user. Checked privately before any negotiation starts.
// Never transmitted. Pass/fail only.

export interface UserPreferences {
  gender_preference?: string[]; // e.g. ["woman", "non-binary"] — empty = no filter
  location?: string; // plain text, e.g. "London, UK" — geocoded server-side
  distance_radius_km?: number; // derived from natural-language selection at onboarding
  age_range?: { min?: number; max?: number };
  // serious/casual is NOT here — agent infers this from life_velocity + behavior
}

// ── Identity ──────────────────────────────────────────────────────────────────

export interface TrueMatchIdentity {
  /** Raw hex-encoded private key (64 hex chars, NOT bech32 "nsec1..."). Keep secret. */
  nsec: string;
  npub: string; // hex-encoded x-only public key
  created_at: string; // ISO 8601
}

// ── Registry ──────────────────────────────────────────────────────────────────

export type ContactType =
  | "email"
  | "discord"
  | "telegram"
  | "whatsapp"
  | "imessage";

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

export type MessageType = "negotiation" | "match_propose" | "end";

export interface NegotiationMessage {
  role: "us" | "peer";
  content: string;
  timestamp: string; // ISO 8601
}

export interface NegotiationState {
  thread_id: string;
  peer_pubkey: string;
  round_count: number; // counts only our outgoing messages
  initiated_by_us: boolean;
  we_proposed: boolean; // true once we have sent a match_propose
  peer_proposed: boolean; // true once peer has sent a match_propose
  started_at: string;
  last_activity: string;
  status: "in_progress" | "matched" | "declined" | "expired";
  messages: NegotiationMessage[];
  match_narrative?: MatchNarrative; // populated from peer's match_propose content
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

// ~/.truematch/preferences.json
export type PreferencesFile = UserPreferences;

// ~/.truematch/threads/<thread_id>.json
export type ThreadFile = NegotiationState;
