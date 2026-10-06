import {
  CORS_HEADERS,
  createErrorResponse,
  parseModels,
  parseProviders,
  validateClientAuth,
} from './config';
import { forwardToUpstream } from './proxy';
import { extractSessionId, persistSessionBinding, resolveSessionBinding } from './session';
import { Env, OpenAIModelItem, OpenAIModelsListResponse } from './types';
import { selectUpstreamAccount } from './upstream';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === '/' || pathname === '/health') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          service: 'workergate',
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
          },
        }
      );
    }

    if (!validateClientAuth(request, env)) {
      return createErrorResponse(
        401,
        'Incorrect API key provided.',
        'invalid_request_error',
        'invalid_api_key'
      );
    }

    if (
      pathname === '/v1/models' ||
      pathname === '/models' ||
      pathname === '/v1/models/' ||
      pathname === '/models/'
    ) {
      if (request.method !== 'GET') {
        return createErrorResponse(
          405,
          `Method ${request.method} not allowed for /v1/models`,
          'invalid_request_error'
        );
      }

      const modelList = parseModels(env);
      const now = Math.floor(Date.now() / 1000);
      const data: OpenAIModelItem[] = modelList.map((modelId) => ({
        id: modelId,
        object: 'model',
        created: now,
        owned_by: 'workergate',
      }));

      const responsePayload: OpenAIModelsListResponse = {
        object: 'list',
        data,
      };

      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...CORS_HEADERS,
        },
      });
    }

    const modelMatch = pathname.match(/^\/(?:v1\/)?models\/(.+)$/);
    if (modelMatch && request.method === 'GET') {
      const modelId = decodeURIComponent(modelMatch[1]);
      const modelList = parseModels(env);

      if (!modelList.includes(modelId)) {
        return createErrorResponse(
          404,
          `The model '${modelId}' does not exist`,
          'invalid_request_error',
          'model_not_found'
        );
      }

      const item: OpenAIModelItem = {
        id: modelId,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'workergate',
      };

      return new Response(JSON.stringify(item), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...CORS_HEADERS,
        },
      });
    }

    const providers = parseProviders(env);
    if (Object.keys(providers).length === 0) {
      return createErrorResponse(
        503,
        'No upstream providers configured in PROVIDERS secret.',
        'server_error',
        'no_providers_configured'
      );
    }

    let parsedBodyJson: Record<string, unknown> | null = null;
    let rawBodyText: string | undefined = undefined;

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      try {
        rawBodyText = await request.text();
        if (rawBodyText && rawBodyText.trim()) {
          parsedBodyJson = JSON.parse(rawBodyText) as Record<string, unknown>;
        }
      } catch {
        return createErrorResponse(
          400,
          'Invalid JSON body in request.',
          'invalid_request_error',
          'invalid_json'
        );
      }
    }

    const sessionId = extractSessionId(request);

    let targetProviderId: string | null = null;
    let targetAccountId: number | string | null = null;

    if (sessionId) {
      const existingBinding = await resolveSessionBinding(sessionId, env);
      if (existingBinding && providers[existingBinding.provider]) {
        targetProviderId = existingBinding.provider;
        targetAccountId = existingBinding.account_id;
      }
    }

    if (!targetProviderId || targetAccountId === null) {
      const requestedModel =
        parsedBodyJson && typeof parsedBodyJson.model === 'string'
          ? parsedBodyJson.model
          : null;

      if (!requestedModel) {
        return createErrorResponse(
          400,
          "Missing required 'model' parameter in request body.",
          'invalid_request_error',
          'missing_required_parameter'
        );
      }

      const selected = await selectUpstreamAccount(providers, requestedModel);
      if (!selected) {
        return createErrorResponse(
          503,
          `No available upstream provider for model '${requestedModel}'.`,
          'server_error',
          'upstream_unavailable'
        );
      }

      targetProviderId = selected.providerId;
      targetAccountId = selected.account_id;

      if (sessionId) {
        await persistSessionBinding(
          sessionId,
          {
            provider: targetProviderId,
            account_id: targetAccountId,
          },
          env
        );
      }
    }

    const providerConfig = providers[targetProviderId];
    if (!providerConfig) {
      return createErrorResponse(
        503,
        `Provider '${targetProviderId}' configuration not found.`,
        'server_error',
        'provider_not_found'
      );
    }

    try {
      return await forwardToUpstream({
        request,
        pathname,
        search: url.search,
        providerConfig,
        accountId: targetAccountId,
        parsedBodyJson,
        rawBodyText,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Upstream request failed';
      return createErrorResponse(502, message, 'bad_gateway', 'upstream_error');
    }
  },
};
