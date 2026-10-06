import { CandidateAccountResult, ProviderConfig, ProvidersMap } from './types';

const SELECT_TIMEOUT_MS = 15000;

export function buildProviderUrl(baseUrl: string, endpointPath: string): string {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const cleanPath = endpointPath.replace(/^\/+/, '');

  if (cleanBase.endsWith('/v1')) {
    if (cleanPath.startsWith('v1/')) {
      return `${cleanBase}/${cleanPath.slice(3)}`;
    }
    return `${cleanBase}/${cleanPath}`;
  }

  if (cleanPath.startsWith('v1/')) {
    return `${cleanBase}/${cleanPath}`;
  }
  return `${cleanBase}/v1/${cleanPath}`;
}

export function resolveTargetModel(
  requestedModel: string,
  providerConfig: ProviderConfig
): string {
  if (providerConfig.models && providerConfig.models[requestedModel]) {
    return providerConfig.models[requestedModel];
  }
  return requestedModel;
}

async function queryAccountSelect(
  providerId: string,
  config: ProviderConfig,
  modelId: string
): Promise<CandidateAccountResult | null> {
  const actualModel = resolveTargetModel(modelId, config);
  const targetUrl = buildProviderUrl(
    config.url,
    `/v1/account/select?model=${encodeURIComponent(actualModel)}`
  );

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SELECT_TIMEOUT_MS);

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.key}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as Record<string, unknown>;
    if (!data || typeof data !== 'object') {
      return null;
    }

    const accountId = data.account_id;
    const expireAt = data.expire_at;

    if (
      (typeof accountId === 'number' || typeof accountId === 'string') &&
      typeof expireAt === 'number' &&
      !Number.isNaN(expireAt)
    ) {
      return {
        providerId,
        account_id: accountId,
        expire_at: expireAt,
      };
    }

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function selectUpstreamAccount(
  providers: ProvidersMap,
  modelId: string
): Promise<CandidateAccountResult | null> {
  const providerEntries = Object.entries(providers);
  if (providerEntries.length === 0) {
    return null;
  }

  const queryTasks = providerEntries.map(([providerId, config]) =>
    queryAccountSelect(providerId, config, modelId)
  );

  const results = await Promise.allSettled(queryTasks);
  const candidates: CandidateAccountResult[] = [];

  for (const item of results) {
    if (item.status === 'fulfilled' && item.value !== null) {
      candidates.push(item.value);
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  let earliestCandidate = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i].expire_at < earliestCandidate.expire_at) {
      earliestCandidate = candidates[i];
    }
  }

  return earliestCandidate;
}
