#!/usr/bin/env bun
import { launch } from "./web/launch";

await launch(process.argv.slice(2));
