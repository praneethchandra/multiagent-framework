#!/usr/bin/env node
import { Command } from "commander";
import dotenv from "dotenv";
import { loadConfig } from "./configLoader.js";
import { runApp } from "./orchestrator.js";
import { initTrace, closeTrace } from "./trace.js";

dotenv.config();

const program = new Command();

program
  .name("magent")
  .description("Run a config-defined multi-agent system")
  .argument("<configPath>", "path to the YAML config file")
  .option("-o, --output <var>", "print only this output variable's final value instead of the full vars dump")
  .option("-t, --trace <file>", "append a JSONL trace of every model call (agent id, latency, tokens, I/O) to this file")
  .option("-c, --checkpoint <file>", "write run progress to this file after every step/turn, for --resume later")
  .option("-r, --resume <file>", "resume a previous run from this checkpoint file (sequential/supervisor patterns only)")
  .action(async (configPath: string, opts: { output?: string; trace?: string; checkpoint?: string; resume?: string }) => {
    initTrace(opts.trace);
    try {
      const { config, baseDir } = loadConfig(configPath);
      const ctx = await runApp(config, baseDir, console.log, {
        checkpointPath: opts.checkpoint,
        resumePath: opts.resume,
      });

      if (opts.output) {
        console.log(ctx.vars[opts.output] ?? `<no output variable named "${opts.output}">`);
      } else {
        console.log("\n--- final variables ---");
        for (const [key, value] of Object.entries(ctx.vars)) {
          console.log(`\n[${key}]\n${value}`);
        }
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exitCode = 1;
    } finally {
      await closeTrace();
    }
  });

program.parse();
