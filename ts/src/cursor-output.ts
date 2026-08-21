export interface CursorConfiguration {
  baseUrl: string;
  apiKey: string;
  models: string[];
  revealApiKey?: boolean;
}

export function formatCursorConfiguration(config: CursorConfiguration): string {
  const apiKey = config.revealApiKey === true ? config.apiKey : "********";
  const models = config.models.length > 0
    ? config.models.map((model) => `  ${model}`).join("\n")
    : "  Start the proxy to load the authenticated model catalog.";
  return [
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    " Cursor → GPT-5.6 Luna",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    "OpenAI Base URL",
    "",
    `  ${config.baseUrl}`,
    "",
    "API Key",
    "",
    `  ${apiKey}`,
    "",
    "Available models",
    "",
    models,
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    " Ready",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  ].join("\n");
}
