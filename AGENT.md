# Agent Notes

## Python Tests

Run the Python suite with:

```bash
rtk proxy uv run --extra server --extra dev pytest -q
```

The repository uses a `src` layout and the server tests require the optional
`server` dependencies. RTK's `pytest` subcommand expects a standalone
`pytest` executable and may fail to spawn it in this environment; `uv run`
provides the project interpreter and dependencies.
