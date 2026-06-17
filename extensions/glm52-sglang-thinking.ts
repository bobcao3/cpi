/**
 * GLM-5.2 SGLang Thinking Bridge
 *
 * Pi's default thinkingFormat ("openai") sends top-level `reasoning_effort`
 * for effort levels, but cannot disable thinking for GLM-5.2 (which defaults
 * to thinking ON). SGLang requires `chat_template_kwargs.enable_thinking`
 * to control on/off. This extension injects that parameter.
 *
 * It also enables preserved thinking (clear_thinking: false) for coding
 * agent scenarios, so reasoning_content is retained across turns.
 *
 * Note: we do not log to stderr here. pi's TUI renders stderr inline and it
 * corrupts the layout. For agent-level debug info use the `/debug` command,
 * which writes to ~/.pi/agent/pi-debug.log. For user-facing notifications from
 * an event handler with a ctx, use ctx.ui.notify(...).
 */

const MODEL_ID = "zai-org/GLM-5.2-FP8";

export default function (pi: any) {
  pi.on("before_provider_request", (event: { payload: Record<string, unknown> }) => {
    const payload = event.payload;
    if (payload.model !== MODEL_ID) return;

    const reasoningEffort = payload.reasoning_effort as string | undefined;
    const thinkingEnabled = !!reasoningEffort && reasoningEffort !== "none";

    const existingKwargs = (payload.chat_template_kwargs as Record<string, unknown>) || {};
    payload.chat_template_kwargs = {
      ...existingKwargs,
      enable_thinking: thinkingEnabled,
      ...(thinkingEnabled ? { clear_thinking: false } : {}),
    };

    if (!thinkingEnabled && payload.reasoning_effort) {
      delete payload.reasoning_effort;
    }
  });
}
