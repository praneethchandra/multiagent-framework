import readline from "node:readline/promises";

// Ambiguity escalation policy (spec #12): "specify in advance which classes
// of ambiguity the agent resolves autonomously and which it surfaces to a
// human." This is the mechanism a supervisor's ACTION: ask_human decision
// uses to actually pause and read from a real human instead of guessing.
export async function askHuman(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\n[HUMAN INPUT REQUESTED]\n${question}\n`);
    const answer = await rl.question("> ");
    return answer.trim();
  } finally {
    rl.close();
  }
}
