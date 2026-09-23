import { piExecutableOnPath } from "../bin/host-pi.mjs";

process.env.CPI_PI_HOST_ENTRY ??= piExecutableOnPath();
