import { createJiti } from "jiti";

const load = createJiti(import.meta.url, { tryNative: false });
const { createSessionOwner, sessionArtifactDirectory } = await load.import(
  "../src/lib/storage/owner.ts",
);
const { storage_directory } = await load.import("../src/lib/storage/paths.ts");
const id = process.env.CPI_ARTIFACT_SESSION_ID;
const directory = process.env.CPI_ARTIFACT_SESSION_DIR;
if ((id === undefined) !== (directory === undefined))
  throw new Error("incomplete artifact session owner");
process.stdout.write(
  id !== undefined
    ? sessionArtifactDirectory(
        createSessionOwner(id, directory),
        "env-captures",
      )
    : storage_directory("state", "env-captures"),
);
