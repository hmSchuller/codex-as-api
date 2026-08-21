from __future__ import annotations

import dataclasses
from typing import Any


@dataclasses.dataclass(frozen=True, slots=True)
class ReasoningLevel:
    effort: str
    description: str | None = None


@dataclasses.dataclass(frozen=True, slots=True)
class ModelCatalogEntry:
    slug: str
    display_name: str
    description: str | None
    default_reasoning_effort: str | None
    supported_reasoning_levels: tuple[ReasoningLevel, ...]
    context_window: int | None
    max_context_window: int | None
    supported_in_api: bool | None
    capabilities: dict[str, Any]


@dataclasses.dataclass(frozen=True, slots=True)
class ResolvedModel:
    requested_model: str
    upstream_model: str
    reasoning_effort: str | None
    catalog_entry: ModelCatalogEntry | None
    alias: bool


def normalize_model_catalog(value: object) -> list[ModelCatalogEntry]:
    if isinstance(value, list):
        raw_models = value
    elif isinstance(value, dict):
        candidates = [value.get(key) for key in ("models", "data")]
        raw_models = next((candidate for candidate in candidates if isinstance(candidate, list)), None)
    else:
        raw_models = None
    if not isinstance(raw_models, list):
        raise ValueError("Codex model catalog response is missing a models array")

    entries: list[ModelCatalogEntry] = []
    for index, raw in enumerate(raw_models):
        if not isinstance(raw, dict):
            continue
        slug = _string(raw.get("slug") or raw.get("model") or raw.get("id"))
        if slug is None:
            raise ValueError(f"Codex model catalog entry {index} is missing a slug")
        levels = _reasoning_levels(
            raw.get("supported_reasoning_levels")
            or raw.get("supported_reasoning_efforts")
            or raw.get("reasoning_levels")
        )
        default_effort = _string(
            raw.get("default_reasoning_level")
            or raw.get("default_reasoning_effort")
            or raw.get("default_reasoning")
        )
        if default_effort is not None and levels and default_effort not in {level.effort for level in levels}:
            raise ValueError(f"Codex model catalog entry {slug!r} has an unsupported default reasoning level")
        entries.append(
            ModelCatalogEntry(
                slug=slug,
                display_name=_string(raw.get("display_name") or raw.get("displayName") or raw.get("name")) or slug,
                description=_string(raw.get("description")),
                default_reasoning_effort=default_effort,
                supported_reasoning_levels=tuple(levels),
                context_window=_positive_int(raw.get("context_window")),
                max_context_window=_positive_int(raw.get("max_context_window")),
                supported_in_api=(
                    raw.get("supported_in_api")
                    if isinstance(raw.get("supported_in_api"), bool)
                    else raw.get("supportedInApi")
                    if isinstance(raw.get("supportedInApi"), bool)
                    else None
                ),
                capabilities=dict(raw),
            )
        )
    return entries


def resolve_model_alias(requested_model: str, catalog: list[ModelCatalogEntry]) -> ResolvedModel:
    exact = next((entry for entry in catalog if entry.slug == requested_model), None)
    if exact is not None:
        return ResolvedModel(requested_model, exact.slug, None, exact, False)
    for entry in catalog:
        prefix = f"{entry.slug}-"
        if not requested_model.startswith(prefix):
            continue
        effort = requested_model[len(prefix) :]
        if effort and any(level.effort == effort for level in entry.supported_reasoning_levels):
            return ResolvedModel(requested_model, entry.slug, effort, entry, True)
    return ResolvedModel(requested_model, requested_model, None, None, False)


def public_models_from_catalog(catalog: list[ModelCatalogEntry], created: int) -> list[dict[str, Any]]:
    models: list[dict[str, Any]] = []
    for entry in catalog:
        if entry.supported_in_api is False:
            continue
        models.append(_public_model(entry, entry.slug, created, None))
        for level in entry.supported_reasoning_levels:
            models.append(_public_model(entry, f"{entry.slug}-{level.effort}", created, level.effort))
    return models


def _public_model(entry: ModelCatalogEntry, model_id: str, created: int, effort: str | None) -> dict[str, Any]:
    return {
        "id": model_id,
        "object": "model",
        "created": created,
        "owned_by": "openai",
        "display_name": entry.display_name if effort is None else f"{entry.display_name} ({effort})",
        "description": entry.description,
        "context_window": entry.context_window or entry.max_context_window,
        "default_reasoning_effort": effort or entry.default_reasoning_effort,
    }


def _reasoning_levels(value: object) -> list[ReasoningLevel]:
    if not isinstance(value, list):
        return []
    levels: list[ReasoningLevel] = []
    seen: set[str] = set()
    for raw in value:
        if isinstance(raw, str):
            effort, description = raw, None
        elif isinstance(raw, dict):
            effort = _string(raw.get("effort") or raw.get("level") or raw.get("name"))
            description = _string(raw.get("description"))
        else:
            continue
        if effort is None or effort in seen:
            continue
        seen.add(effort)
        levels.append(ReasoningLevel(effort, description))
    return levels


def _string(value: object) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def _positive_int(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None
