import { ChatGPTOAuthError } from "./auth.js";

export interface ReasoningLevel {
  effort: string;
  description?: string;
}

export interface ModelCatalogEntry {
  slug: string;
  displayName: string;
  description?: string;
  defaultReasoningEffort?: string;
  supportedReasoningLevels: ReasoningLevel[];
  contextWindow?: number;
  maxContextWindow?: number;
  supportedInApi?: boolean;
  capabilities: Record<string, unknown>;
}

export interface ResolvedModel {
  requestedModel: string;
  upstreamModel: string;
  reasoningEffort?: string;
  catalogEntry?: ModelCatalogEntry;
  alias: boolean;
}

const MODEL_LIST_KEYS = ["models", "data"] as const;
const LUNA_MODEL_SLUG = "gpt-5.6-luna";
const LUNA_ALIAS_PREFIX = "luna-";

export function isLunaModelId(model: string): boolean {
  return model === LUNA_MODEL_SLUG
    || model.startsWith(`${LUNA_MODEL_SLUG}-`)
    || model.startsWith(LUNA_ALIAS_PREFIX);
}

export function normalizeModelCatalog(value: unknown): ModelCatalogEntry[] {
  const rawModels = Array.isArray(value)
    ? value
    : isRecord(value)
      ? MODEL_LIST_KEYS
        .map((key) => value[key])
        .find((candidate): candidate is unknown[] => Array.isArray(candidate))
      : undefined;
  if (!Array.isArray(rawModels)) {
    throw new ChatGPTOAuthError("Codex model catalog response is missing a models array");
  }

  const entries: ModelCatalogEntry[] = [];
  for (const [index, raw] of rawModels.entries()) {
    if (!isRecord(raw)) continue;
    const slug = stringValue(raw.slug ?? raw.model ?? raw.id);
    if (!slug) {
      throw new ChatGPTOAuthError(`Codex model catalog entry ${index} is missing a slug`);
    }
    const supported = normalizeReasoningLevels(
      raw.supported_reasoning_levels
        ?? raw.supported_reasoning_efforts
        ?? raw.reasoning_levels,
    );
    const defaultReasoningEffort = stringValue(
      raw.default_reasoning_level
        ?? raw.default_reasoning_effort
        ?? raw.default_reasoning,
    );
    if (
      defaultReasoningEffort != null
      && supported.length > 0
      && !supported.some((level) => level.effort === defaultReasoningEffort)
    ) {
      throw new ChatGPTOAuthError(
        `Codex model catalog entry ${JSON.stringify(slug)} has an unsupported default reasoning level`,
      );
    }
    entries.push({
      slug,
      displayName: stringValue(raw.display_name ?? raw.displayName ?? raw.name) ?? slug,
      description: stringValue(raw.description),
      defaultReasoningEffort,
      supportedReasoningLevels: supported,
      contextWindow: positiveInteger(raw.context_window),
      maxContextWindow: positiveInteger(raw.max_context_window),
      supportedInApi: typeof raw.supported_in_api === "boolean"
        ? raw.supported_in_api
        : typeof raw.supportedInApi === "boolean"
          ? raw.supportedInApi
          : undefined,
      capabilities: { ...raw },
    });
  }
  return entries;
}

export function resolveModelAlias(
  requestedModel: string,
  catalog: readonly ModelCatalogEntry[],
): ResolvedModel {
  const exact = catalog.find((entry) => entry.slug === requestedModel);
  if (exact) {
    return {
      requestedModel,
      upstreamModel: exact.slug,
      catalogEntry: exact,
      alias: false,
    };
  }

  // Only strip a suffix when the complete base model is present and the suffix
  // is advertised by that model. Unknown IDs therefore remain untouched.
  for (const entry of catalog) {
    const prefix = `${entry.slug}-`;
    if (!requestedModel.startsWith(prefix)) continue;
    const effort = requestedModel.slice(prefix.length);
    if (!effort || !entry.supportedReasoningLevels.some((level) => level.effort === effort)) {
      continue;
    }
    return {
      requestedModel,
      upstreamModel: entry.slug,
      reasoningEffort: effort,
      catalogEntry: entry,
      alias: true,
    };
  }

  if (requestedModel.startsWith(LUNA_ALIAS_PREFIX)) {
    const luna = catalog.find((entry) => entry.slug === LUNA_MODEL_SLUG);
    const effort = requestedModel.slice(LUNA_ALIAS_PREFIX.length);
    if (
      luna != null
      && effort
      && luna.supportedReasoningLevels.some((level) => level.effort === effort)
    ) {
      return {
        requestedModel,
        upstreamModel: luna.slug,
        reasoningEffort: effort,
        catalogEntry: luna,
        alias: true,
      };
    }
  }

  return {
    requestedModel,
    upstreamModel: requestedModel,
    alias: false,
  };
}

export function publicModelsFromCatalog(
  catalog: readonly ModelCatalogEntry[],
  now = Math.floor(Date.now() / 1000),
): Record<string, unknown>[] {
  const models: Record<string, unknown>[] = [];
  for (const entry of catalog) {
    if (entry.supportedInApi === false) continue;
    const virtualAliases: string[] = [];
    const add = (id: string, suffix?: string): void => {
      models.push({
        id,
        object: "model",
        created: now,
        owned_by: "openai",
        display_name: suffix == null
          ? entry.displayName
          : `${entry.displayName} (${suffix})`,
        description: entry.description,
        context_window: entry.contextWindow ?? entry.maxContextWindow,
        default_reasoning_effort: suffix ?? entry.defaultReasoningEffort,
      });
    };
    add(entry.slug);
    for (const level of entry.supportedReasoningLevels) {
      add(`${entry.slug}-${level.effort}`, level.effort);
      if (entry.slug === LUNA_MODEL_SLUG) {
        virtualAliases.push(level.effort);
      }
    }
    for (const effort of virtualAliases) {
      add(`${LUNA_ALIAS_PREFIX}${effort}`, effort);
    }
  }
  return models;
}

function normalizeReasoningLevels(value: unknown): ReasoningLevel[] {
  if (!Array.isArray(value)) return [];
  const levels: ReasoningLevel[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const effort = typeof raw === "string"
      ? raw
      : isRecord(raw)
        ? stringValue(raw.effort ?? raw.level ?? raw.name)
        : undefined;
    if (!effort || seen.has(effort)) continue;
    seen.add(effort);
    levels.push({
      effort,
      description: isRecord(raw) ? stringValue(raw.description) : undefined,
    });
  }
  return levels;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
