import "../bootstrap.mjs";
import { main, setupCli } from "./index.ts";

setupCli();
process.env.AI_AGENT = "cpi";
await main(process.argv.slice(2));
