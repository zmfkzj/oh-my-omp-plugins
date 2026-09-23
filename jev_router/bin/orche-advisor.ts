#!/usr/bin/env bun

import { runCli } from "../src/advisor-cli.ts";

process.exitCode = await runCli();
