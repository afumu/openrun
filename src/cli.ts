import { runCli } from './cli/app.js';

process.exitCode = await runCli({
  argv: process.argv.slice(2),
});
