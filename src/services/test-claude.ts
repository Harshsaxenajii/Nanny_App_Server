// test-claude.ts
// ─────────────────────────────────────────────────────────────────────────────
// Reads prompt.txt → fires Claude API → logs raw JSON response
//
// Run:
//   ANTHROPIC_API_KEY=your_key npx ts-node test-claude.ts
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";

async function main() {
  // 1. Read the prompt from the text file
  const promptPath = path.join(__dirname, "prompt.txt");
  const prompt = fs.readFileSync(promptPath, "utf-8").trim();

  console.log("─────────────────────────────────");
  console.log("PROMPT:");
  console.log(prompt);
  console.log("─────────────────────────────────");

  // 2. Fire Claude API
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const response = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  // 3. Extract raw text from response
  const rawText = response.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { type: "text"; text: string }).text)
    .join("");

  console.log("RAW RESPONSE FROM CLAUDE:");
  console.log(rawText);
  console.log("─────────────────────────────────");

  // 4. Parse as JSON to verify it worked
  try {
    const parsed = JSON.parse(rawText);
    console.log("PARSED JSON:");
    console.log(JSON.stringify(parsed, null, 2));
    console.log("─────────────────────────────────");
    console.log("✅ Claude integration working.");
  } catch (err) {
    console.error("❌ Response is not valid JSON:", err);
    console.log("Raw text was:", rawText);
  }
}

main().catch(console.error);