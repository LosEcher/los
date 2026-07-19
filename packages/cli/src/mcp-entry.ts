#!/usr/bin/env node

import { mcpServeCommand } from './mcp-serve.js';

mcpServeCommand([], ['serve', ...process.argv.slice(2)]).catch(error => {
  process.stderr.write(`los-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
