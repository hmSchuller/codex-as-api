# Agent Notes

## Python Tests

Run the Python suite with:

```bash
export PYTHON_VERSION="${PYTHON_VERSION:-3.12}"
rtk proxy uv run --python "$PYTHON_VERSION" --extra server --extra dev pytest -q
```

The repository uses a `src` layout and the server tests require the optional
`server` dependencies. RTK's `pytest` subcommand expects a standalone
`pytest` executable and may fail to spawn it in this environment; `uv run`
provides the project interpreter and dependencies.
`PYTHON_VERSION` is the one local version pin; override it for compatibility
testing without changing repository files.
