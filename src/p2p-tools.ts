#!/usr/bin/env node
import { runCli } from './cli-app.js';

process.exitCode = await runCli(process.argv.slice(2));
