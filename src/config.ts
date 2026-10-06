import { Env, ProviderConfig, ProvidersMap } from './types';

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

export function createErrorResponse(
  status: number,
  message: string,
  type: string = 'api_error',
  code: string | null = null
): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type,
        param: null,
        code,
      },
    }),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...CORS_HEADERS,
      },
    }
  );
}

export function parseClientKeys(env: Env): string[] {
  const raw = env.CLIENT_KEYS || '';
  return raw
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

export function parseModels(env: Env): string[] {
  const raw = env.MODELS || '';
  return raw
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
}

export function parseProviders(env: Env): ProvidersMap {
  const raw = env.PROVIDERS || '';
  if (!raw.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }

    const result: ProvidersMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'object' && value !== null) {
        const item = value as Partial<ProviderConfig>;
        if (typeof item.url === 'string' && typeof item.key === 'string') {
          result[key] = {
            url: item.url.replace(/\/+$/, ''),
            key: item.key,
            models:
              typeof item.models === 'object' && item.models !== null
                ? (item.models as Record<string, string>)
                : undefined,
          };
        }
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function validateClientAuth(request: Request, env: Env): boolean {
  const allowedKeys = parseClientKeys(env);
  if (allowedKeys.length === 0) {
    return true;
  }

  const authHeader = request.headers.get('authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return false;
  }

  const token = match[1].trim();
  return allowedKeys.includes(token);
}
