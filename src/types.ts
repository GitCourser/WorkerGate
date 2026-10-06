export interface Env {
  SESSION_KV: KVNamespace;
  MODELS?: string;
  CLIENT_KEYS?: string;
  PROVIDERS?: string;
}

export interface ProviderConfig {
  url: string;
  key: string;
  models?: Record<string, string>;
}

export type ProvidersMap = Record<string, ProviderConfig>;

export interface SessionBinding {
  provider: string;
  account_id: number | string;
  expireAt?: number;
}

export interface AccountSelectResponse {
  account_id: number | string;
  expire_at: number;
}

export interface CandidateAccountResult {
  providerId: string;
  account_id: number | string;
  expire_at: number;
}

export interface OpenAIModelItem {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export interface OpenAIModelsListResponse {
  object: 'list';
  data: OpenAIModelItem[];
}

export interface OpenAIErrorResponse {
  error: {
    message: string;
    type: string;
    param?: string | null;
    code?: string | null;
  };
}
