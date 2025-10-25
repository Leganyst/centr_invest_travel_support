export interface GeoPoint {
  lat: number;
  lon: number;
  accuracy_m?: number | null;
}

export type StartPointSource = "city" | "user";

export interface StartPoint extends GeoPoint {
  source: StartPointSource;
}

export interface Stop {
  name: string;
  lat: number;
  lon: number;
  description?: string | null;
  arrive: string;
  leave: string;
  tags: string[];
}

export interface PlanResponse {
  stops: Stop[];
  total_time: string;
  total_minutes: number;
  ics: string;
  data_source: "seed" | "2gis" | string;
  optimized: boolean;
}

export interface PlanRequestPayload {
  city: string;
  date: string;
  tags?: string[];
  budget?: string | null;
  pace?: string | null;
  user_location?: GeoPoint | null;
  radius_m?: number | null;
}

export interface AppConfig {
  mapglKey: string;
  defaultCity: string;
  allowedTags: string[];
  llmEnabled: boolean;
}

export interface ChatResponseAsk {
  mode: "ask";
  question: string;
  field: string;
  input: "date" | "single" | "multiselect";
  options: string[];
  known_prefs?: Record<string, unknown>;
  note?: string;
}

export interface ChatResponseReady {
  mode: "ready";
  prefs: Record<string, unknown>;
  note?: string;
}

export type ChatResponse = ChatResponseAsk | ChatResponseReady | Record<string, unknown>;
