import { CORS_HEADERS } from './config';
import { ProviderConfig } from './types';
import { buildProviderUrl, resolveTargetModel } from './upstream';

export interface ForwardOptions {
  request: Request;
  pathname: string;
  search: string;
  providerConfig: ProviderConfig;
  accountId: number | string;
  parsedBodyJson?: Record<string, unknown> | null;
  rawBodyText?: string;
}

export async function forwardToUpstream(options: ForwardOptions): Promise<Response> {
  const {
    request,
    pathname,
    search,
    providerConfig,
    accountId,
    parsedBodyJson,
    rawBodyText,
  } = options;

  const targetBaseUrl = buildProviderUrl(providerConfig.url, pathname);
  const targetUrl = search ? `${targetBaseUrl}${search}` : targetBaseUrl;

  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey === 'authorization' ||
      lowerKey === 'content-length' ||
      lowerKey === 'host' ||
      lowerKey.startsWith('cf-')
    ) {
      continue;
    }
    headers.set(key, value);
  }

  headers.set('Authorization', `Bearer ${providerConfig.key}`);
  headers.set('x-account-id', String(accountId));

  let finalBody: BodyInit | null = null;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (parsedBodyJson && typeof parsedBodyJson === 'object') {
      const clonedJson = { ...parsedBodyJson };
      if (typeof clonedJson.model === 'string') {
        clonedJson.model = resolveTargetModel(clonedJson.model, providerConfig);
      }
      finalBody = JSON.stringify(clonedJson);
      headers.set('Content-Type', 'application/json');
    } else if (rawBodyText !== undefined) {
      finalBody = rawBodyText;
    } else {
      finalBody = request.body;
    }
  }

  const upstreamResponse = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: finalBody,
    redirect: 'follow',
  });

  const responseHeaders = new Headers();
  for (const [key, value] of upstreamResponse.headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey === 'content-encoding' ||
      lowerKey === 'content-length' ||
      lowerKey === 'transfer-encoding'
    ) {
      continue;
    }
    responseHeaders.set(key, value);
  }

  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    responseHeaders.set(key, value);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}
