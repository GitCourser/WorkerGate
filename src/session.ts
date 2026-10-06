import { Env, SessionBinding } from './types';

const SESSION_TTL_SECONDS = 12 * 3600; // 12 hours
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
const MAX_MEMORY_CACHE_SIZE = 5000;

const memorySessionCache = new Map<string, SessionBinding>();

export function extractSessionId(request: Request): string | null {
  const directSessionId = request.headers.get('session-id');
  if (directSessionId && directSessionId.trim()) {
    return directSessionId.trim();
  }

  for (const [key, value] of request.headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (lowerKey !== 'session-id' && lowerKey.endsWith('-session-id')) {
      if (value && value.trim()) {
        return value.trim();
      }
    }
  }

  return null;
}

export function getSessionFromMemory(sessionId: string): SessionBinding | null {
  const item = memorySessionCache.get(sessionId);
  if (!item) {
    return null;
  }

  if (item.expireAt && Date.now() > item.expireAt) {
    memorySessionCache.delete(sessionId);
    return null;
  }

  return item;
}

export function setSessionToMemory(sessionId: string, binding: SessionBinding): void {
  if (memorySessionCache.size >= MAX_MEMORY_CACHE_SIZE) {
    const now = Date.now();
    for (const [key, val] of memorySessionCache.entries()) {
      if (val.expireAt && now > val.expireAt) {
        memorySessionCache.delete(key);
      }
    }
    if (memorySessionCache.size >= MAX_MEMORY_CACHE_SIZE) {
      const firstKey = memorySessionCache.keys().next().value;
      if (firstKey) {
        memorySessionCache.delete(firstKey);
      }
    }
  }

  memorySessionCache.set(sessionId, {
    ...binding,
    expireAt: Date.now() + SESSION_TTL_MS,
  });
}

export async function resolveSessionBinding(
  sessionId: string,
  env: Env
): Promise<SessionBinding | null> {
  const memoryHit = getSessionFromMemory(sessionId);
  if (memoryHit) {
    return memoryHit;
  }

  if (!env.SESSION_KV) {
    return null;
  }

  try {
    const kvValue = await env.SESSION_KV.get(sessionId, 'json');
    if (kvValue && typeof kvValue === 'object') {
      const binding = kvValue as SessionBinding;
      if (binding.provider && binding.account_id !== undefined) {
        setSessionToMemory(sessionId, binding);
        return binding;
      }
    }
  } catch {
    // KV read error: fall through to re-select
  }

  return null;
}

export async function persistSessionBinding(
  sessionId: string,
  binding: SessionBinding,
  env: Env
): Promise<void> {
  setSessionToMemory(sessionId, binding);

  if (!env.SESSION_KV) {
    return;
  }

  try {
    await env.SESSION_KV.put(sessionId, JSON.stringify(binding), {
      expirationTtl: SESSION_TTL_SECONDS,
    });
  } catch {
    // KV write error: memory cache is already updated
  }
}
