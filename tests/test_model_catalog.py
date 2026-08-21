from codex_as_api.model_catalog import (
    normalize_model_catalog,
    public_models_from_catalog,
    resolve_model_alias,
)


def _catalog():
    return normalize_model_catalog(
        {
            "models": [
                {
                    "slug": "gpt-5.6-luna",
                    "display_name": "GPT-5.6 Luna",
                    "default_reasoning_level": "medium",
                    "supported_reasoning_levels": [
                        {"effort": "medium"},
                        {"effort": "high"},
                        {"effort": "xhigh"},
                        {"effort": "max"},
                    ],
                }
            ]
        }
    )


def test_luna_alias_resolution_does_not_guess_unknown_effort():
    catalog = _catalog()
    resolved = resolve_model_alias("gpt-5.6-luna-high", catalog)
    assert resolved.upstream_model == "gpt-5.6-luna"
    assert resolved.reasoning_effort == "high"
    assert resolve_model_alias("gpt-5.6-luna-unknown", catalog).upstream_model == "gpt-5.6-luna-unknown"


def test_luna_models_are_generated_from_catalog_levels():
    ids = [model["id"] for model in public_models_from_catalog(_catalog(), 123)]
    assert ids == [
        "gpt-5.6-luna",
        "gpt-5.6-luna-medium",
        "gpt-5.6-luna-high",
        "gpt-5.6-luna-xhigh",
        "gpt-5.6-luna-max",
    ]
