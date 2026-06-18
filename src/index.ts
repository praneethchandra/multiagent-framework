#!/usr/bin/env node
import { Command } from "commander";
import dotenv from "dotenv";
import { loadConfig } from "./configLoader.js";
import { runApp } from "./orchestrator.js";

dotenv.config();

const program = new Command();

program
  .name("magent")
  .description("Run a config-defined multi-agent system")
  .argument("<configPath>", "path to the YAML config file")
  .option("-o, --output <var>", "print only this output variable's final value instead of the full vars dump")
  .action(async (configPath: string, opts: { output?: string }) => {
    try {
      const { config, baseDir } = loadConfig(configPath);
      const ctx = await runApp(config, baseDir);

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
    }
  });

program.parse();
