import {
  createAgentSession,
  createAgentSessionServices,
  createVcsSource,
  DefaultResourceLoader,
  FooterDataProvider,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionOptions,
} from "@cpi/cli";

const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
const loader = new DefaultResourceLoader({
  cwd: ".",
  agentDir: ".",
  settingsManager: settings,
});
const options: CreateAgentSessionOptions = {
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(),
};
export async function consumeSdk(): Promise<string[]> {
  const services = await createAgentSessionServices({
    cwd: ".",
    agentDir: ".",
    settingsManager: settings,
  });
  await services.resourceLoader.reload();
  const { session } = await createAgentSession(options);
  const footer = new FooterDataProvider(".", createVcsSource);
  footer.dispose();
  try {
    return session.getActiveToolNames();
  } finally {
    session.dispose();
  }
}
// @ts-expect-error The compiler must reject an invalid session option rather than accepting an untyped SDK.
const invalid: CreateAgentSessionOptions = { cwd: 123 };
void invalid;
