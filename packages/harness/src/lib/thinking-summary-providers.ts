import type { AssistantMessage, KnownProvider } from "@earendil-works/pi-ai";

const proprietary =
  /^(?:claude-|gpt-(?!oss(?:-|:|$))|o\d+(?:[-:]|$)|muse-spark-|gemini-|grok-(?!3-mini(?:[-:]|$)))/;
const namespaced =
  /^~?(?:anthropic\/claude-|openai\/(?:gpt-(?!oss(?:-|:|$))|o\d+(?:[-:]|$))|meta\/muse-spark-|google\/gemini-|x-ai\/grok-(?!3-mini(?:[-:]|$)))/;
const providers = {
  "amazon-bedrock":
    /^(?:[a-z0-9-]+\.)?(?:anthropic\.claude-|openai\.(?:gpt-(?!oss(?:-|:|$))|o\d+(?:[-:]|$)))/,
  "ant-ling": false,
  anthropic: true,
  google: /^(?:models\/)?gemini-/,
  "google-vertex": /^(?:models\/)?gemini-/,
  openai: /^(?!gpt-oss(?:-|:|$))/,
  azure: proprietary,
  "openai-codex": /^(?!gpt-oss(?:-|:|$))/,
  radius: proprietary,
  typesafe: false,
  nvidia: false,
  deepseek: false,
  "github-copilot": proprietary,
  xai: /^grok-(?!3-mini(?:[-:]|$))/,
  groq: false,
  cerebras: false,
  openrouter: namespaced,
  "vercel-ai-gateway": namespaced,
  zai: false,
  "zai-coding-cn": false,
  mistral: false,
  minimax: false,
  "minimax-cn": false,
  moonshotai: false,
  "moonshotai-cn": false,
  huggingface: false,
  fireworks: false,
  together: false,
  baseten: false,
  opencode: proprietary,
  "opencode-go": proprietary,
  "kimi-coding": false,
  meta: /^muse-spark-/,
  "cloudflare-workers-ai": false,
  "cloudflare-ai-gateway": proprietary,
  "qwen-token-plan": false,
  "qwen-token-plan-cn": false,
  "qwen-token-plan-individual": false,
  xiaomi: false,
  "xiaomi-token-plan-cn": false,
  "xiaomi-token-plan-ams": false,
  "xiaomi-token-plan-sgp": false,
} satisfies Record<KnownProvider, boolean | RegExp>;

export function uses_thinking_summary(message: AssistantMessage): boolean {
  const rule = Object.hasOwn(providers, message.provider)
    ? providers[message.provider as KnownProvider]
    : false;
  return typeof rule === "boolean"
    ? rule
    : rule.test(message.responseModel ?? message.model);
}
