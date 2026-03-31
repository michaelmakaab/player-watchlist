#!/usr/bin/env node
/**
 * ─── Player Watchlist — Weekly Sweep Runner ───
 *
 * Two-phase approach:
 *   Phase 1 — Claude searches the web for transfer intel (web_search tool).
 *   Phase 2 — A second Claude call takes the search findings and produces
 *             a structured JSON delta (no tools, guaranteed output).
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... node scripts/sweep.mjs [--player "Name"] [--dry-run] [--verbose]
 *
 * Environment:
 *   ANTHROPIC_API_KEY   — required
 *   SWEEP_MODEL         — optional, defaults to claude-haiku-4-5-20251001
 */

import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  validateRumour,
  validatePlayerIdentity,
  isDuplicate,
  validateTierConsistency,
  validateEscalation,
} from "./validate.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// ── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}
const FLASH_PLAYER = getArg("--player", null);
const DRY_RUN = args.includes("--dry-run");
const VERBOSE = args.includes("--verbose");

// ── Paths ─────────────────────────────────────────────────────────────────
const PLAYERS_PATH = path.join(ROOT, "data", "players.json");
const INTEL_PATH = path.join(ROOT, "data", "intel.json");
const DELTA_DIR = path.join(ROOT, "sweeps");
const BUILD_SCRIPT = path.join(ROOT, "build.sh");

// ── Validate ──────────────────────────────────────────────────────────────
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY environment variable is required.");
  process.exit(1);
}
if (!fs.existsSync(PLAYERS_PATH) || !fs.existsSync(INTEL_PATH)) {
  console.error("ERROR: data/players.json or data/intel.json not found.");
  process.exit(1);
}

const MODEL = process.env.SWEEP_MODEL || "claude-sonnet-4-5-20250929";
const MODEL_PHASE2 = process.env.SWEEP_MODEL_PHASE2 || "claude-haiku-4-5-20251001";

// ── Load current data ─────────────────────────────────────────────────────
const playersData = JSON.parse(fs.readFileSync(PLAYERS_PATH, "utf-8"));
const intelData = JSON.parse(fs.readFileSync(INTEL_PATH, "utf-8"));

const today = new Date().toLocaleDateString("en-US", {
  month: "short", day: "numeric", year: "numeric"
});

console.log(`\n=== SWEEP RUNNER ===`);
console.log(`Date: ${today}`);
console.log(`Model (search): ${MODEL}`);
console.log(`Model (JSON): ${MODEL_PHASE2}`);
console.log(`Players: ${playersData.players.length}`);
console.log(`Existing intel items: ${Object.keys(intelData).length}`);
if (FLASH_PLAYER) console.log(`Flash target: ${FLASH_PLAYER}`);
if (DRY_RUN) console.log(`DRY RUN — no files will be written`);
console.log("");

// ── Exit early if no players ──────────────────────────────────────────────
if (playersData.players.length === 0) {
  console.log("No players in watchlist — nothing to sweep.");
  process.exit(0);
}

// ── Get target players ────────────────────────────────────────────────────
function getTargetPlayers() {
  if (FLASH_PLAYER) {
    const targets = playersData.players.filter(
      p => p.name.toLowerCase().includes(FLASH_PLAYER.toLowerCase())
    );
    if (targets.length === 0) {
      console.error(`ERROR: No player found matching "${FLASH_PLAYER}"`);
      process.exit(1);
    }
    return targets;
  }
  return playersData.players;
}

// ── Build player detail string for a batch ────────────────────────────────
function buildPlayerDetails(players) {
  return players.map(p => {
    const intel = intelData[String(p.id)] || {};
    return `--- Player #${p.id}: ${p.name} ---
Country: ${p.country} | Position: ${p.position} | Born: ${p.birthYear}
Current Club: ${p.currentClub} | Status: ${p.status} | Tier: ${p.sweepTier}
Alt Spellings: ${(p.altSpellings || []).join(", ") || "none"}
Confusion Risk: ${p.confusionRisk || "none"}
Contract: ${intel.contract || "—"} | Previous Club: ${intel.previousClub || "—"}
Existing Rumors (${(p.rumors || []).length}):
${(p.rumors || []).map(r => `  [${r.date}] ${r.club} — ${r.detail} (${r.source}, T${r.tier})`).join("\n") || "  none"}`;
  }).join("\n\n");
}

// ── Retry helper with exponential backoff ──────────────────────────────────
async function withRetry(fn, label, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRateLimit = err.status === 429 || (err.message && err.message.includes("rate_limit"));
      if (isRateLimit && attempt < maxRetries) {
        const wait = attempt * 60;
        console.log(`  Rate limited on ${label} (attempt ${attempt}/${maxRetries}). Waiting ${wait}s...`);
        await new Promise(r => setTimeout(r, wait * 1000));
      } else {
        throw err;
      }
    }
  }
}

// ── Phase 1: Search ──────────────────────────────────────────────────────
async function phase1Search(client, players) {
  const playerDetails = buildPlayerDetails(players);
  const playerNames = players.map(p => p.name).join(", ");
  const maxSearches = FLASH_PLAYER ? 15 : Math.min(players.length * 4, 40);

  const searchPrompt = `You are a football transfer research assistant. Search for the latest transfer news and rumours for these players. Today is ${today}.

CRITICAL INSTRUCTION: You MUST use the web_search tool for EVERY player. Do NOT answer from memory. Do NOT skip searching. Each player needs at minimum 2 web searches.

For EACH player below, run these searches:
1. "[Player name] transfer 2026"
2. "[Player name] [current club]"
3. For African/francophone players: "[Player name] transfert" or "[Player name] mercato"
4. If the player has alt spellings, search those too

IMPORTANT:
- You MUST call web_search — do not just write what you think you know
- Search ALL players listed — do not skip any
- For each search result, note the ARTICLE PUBLICATION DATE, SOURCE, SOURCE URL, and KEY CLAIM
- Always include the full URL of the article/page where you found the information
- IMPORTANT: Use the article's actual publication date, NOT today's date
- Be careful about identity: check birth year and nationality match
- Only note genuinely new findings (not already in their existing rumors)
- Keep your text output brief — just list findings per player

PLAYERS TO SEARCH:
${playerDetails}

START SEARCHING NOW. Use web_search for the first player immediately. Do not write any text before your first search.`;

  console.log(`Phase 1: Searching for ${players.length} player(s): ${playerNames}`);
  console.log(`  Max searches: ${maxSearches}\n`);

  const findings = await withRetry(async () => {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 4000,
      system: "You are a football transfer research agent. Search for transfer news and report findings concisely. Do NOT produce JSON — just describe what you found for each player.",
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: maxSearches
        }
      ],
      messages: [{ role: "user", content: searchPrompt }]
    });

    let searchCount = 0;
    stream.on("event", (event) => {
      if (event.type === "content_block_start" && event.content_block?.type === "web_search_tool_result") {
        searchCount++;
        process.stdout.write(`  [Search ${searchCount}/${maxSearches}] `);
      }
    });

    const response = await stream.finalMessage();
    console.log(`\n  Phase 1 complete: ${searchCount} searches performed.`);

    if (searchCount === 0) {
      console.warn("  WARNING: Model did not perform any web searches! Results may be stale/hallucinated.");
    }

    const textBlocks = response.content.filter(b => b.type === "text");
    return textBlocks.map(b => b.text).join("\n");
  }, "Phase 1 search");

  if (VERBOSE) {
    console.log("\n=== PHASE 1 FINDINGS ===");
    console.log(findings.substring(0, 3000) + (findings.length > 3000 ? "..." : ""));
    console.log("");
  }

  return findings;
}

// ── Phase 2: Produce JSON delta ──────────────────────────────────────────
async function phase2Produce(client, players, allFindings) {
  const playerDetails = buildPlayerDetails(players);

  // Build confusion risks from player data
  const confusionRisks = players
    .filter(p => p.confusionRisk)
    .map(p => `- ${p.name} (b.${p.birthYear}): ${p.confusionRisk}`)
    .join("\n");

  const jsonPrompt = `You are the JSON formatter for the Player Watchlist. Based on the research findings below, produce the structured delta JSON.

TODAY'S DATE: ${today}

## RULES
1. Only include genuinely NEW intel not already in the player's existing rumors
2. Apply date gating: ignore anything on or before each player's latest rumour date
3. Verify identity: check birth year, club, nationality match our player
4. Max 80 chars for "detail" field. Lead with the most important fact.
5. CRITICAL — Dates: Use the ORIGINAL ARTICLE PUBLICATION DATE, NOT today's date. Format: "Feb 8, 2026". Never use "Recently" or today's sweep date. If the article was published on Jan 17, the date must be "Jan 17, 2026" even if the sweep runs on Feb 23.
6. Source tiers: T1 (Official/Romano/Transfermarkt), T2 (AfricaFoot/ESPN/Athletic), T3 (Regional), T4 (Speculative)
7. Include sourceUrl: provide the full URL of the article where the intel was found. Use null if no URL is available.
8. Rumour statuses: "rumour" (initial links), "advanced" (concrete talks), "confirmed" (agreed deal), "official" (announced by club)

${confusionRisks ? `## KNOWN CONFUSION RISKS\n${confusionRisks}\n` : ""}
## CURRENT PLAYER DATA
${playerDetails}

## RESEARCH FINDINGS FROM WEB SEARCH
${allFindings}

## OUTPUT
Return ONLY a valid JSON object with this exact structure (no markdown fences, no commentary):
{
  "sweepDate": "${today}",
  "sweepNumber": ${playersData.meta.sweepNumber + 1},
  "playersSearched": ${players.length},
  "newIntel": [
    {
      "playerId": <number>,
      "playerName": "<string>",
      "rumor": {
        "date": "<Mon DD, YYYY>",
        "club": "<club name>",
        "detail": "<max 80 chars>",
        "source": "<source name>",
        "sourceUrl": "<full URL of the source article, or null if not available>",
        "tier": <1-4>,
        "status": "<rumour|advanced|confirmed|official>",
        "recent": true
      },
      "intelUpdates": { <fields to update in intel.json, or null> },
      "reasoning": "<why this passed the delta test>"
    }
  ],
  "escalations": [
    {
      "playerId": <number>,
      "playerName": "<string>",
      "field": "status",
      "oldValue": "<previous status>",
      "newValue": "<new status>",
      "source": "<source>"
    }
  ],
  "noChange": [<names of players with no new intel>],
  "needsReview": [
    {
      "playerId": <number>,
      "playerName": "<string>",
      "detail": "<what was found>",
      "reason": "<why uncertain>"
    }
  ]
}

If no new intel was found for any player, return empty arrays and list all names in noChange.
Return ONLY the JSON — nothing else.`;

  console.log("\nPhase 2: Producing structured JSON delta...");

  const fullText = await withRetry(async () => {
    const response = await client.messages.create({
      model: MODEL_PHASE2,
      max_tokens: 4000,
      messages: [{ role: "user", content: jsonPrompt }]
    });

    return response.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n");
  }, "Phase 2 JSON");

  if (VERBOSE) {
    console.log("=== PHASE 2 RAW OUTPUT ===");
    console.log(fullText.substring(0, 2000) + (fullText.length > 2000 ? "..." : ""));
    console.log("");
  }

  return fullText;
}

// ── Run the sweep ────────────────────────────────────────────────────────
async function runSweep() {
  const client = new Anthropic();
  const targetPlayers = getTargetPlayers();

  console.log(`Target players: ${targetPlayers.length}`);
  console.log(`Players: ${targetPlayers.map(p => p.name).join(", ")}\n`);

  // Batch players for sweeps (groups of 7)
  const BATCH_SIZE = 7;
  let batches;
  if (targetPlayers.length > BATCH_SIZE) {
    batches = [];
    for (let i = 0; i < targetPlayers.length; i += BATCH_SIZE) {
      batches.push(targetPlayers.slice(i, i + BATCH_SIZE));
    }
    console.log(`Splitting into ${batches.length} batches of up to ${BATCH_SIZE} players each.\n`);
  } else {
    batches = [targetPlayers];
  }

  // Phase 1: Search each batch
  let allFindings = "";
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    if (batches.length > 1) {
      console.log(`\n─── Batch ${i + 1}/${batches.length} ───`);
    }
    try {
      const findings = await phase1Search(client, batch);
      allFindings += `\n=== Batch ${i + 1} findings ===\n${findings}\n`;
    } catch (err) {
      console.error(`Phase 1 batch ${i + 1} failed:`, err.message);
      allFindings += `\n=== Batch ${i + 1}: SEARCH FAILED ===\n`;
    }
  }

  // Save raw findings for debugging
  fs.mkdirSync(DELTA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DELTA_DIR, "last_raw_findings.txt"),
    allFindings,
    "utf-8"
  );

  // Phase 2: Produce JSON from all findings
  let jsonText;
  try {
    jsonText = await phase2Produce(client, targetPlayers, allFindings);
  } catch (err) {
    console.error("Phase 2 failed:", err.message);
    process.exit(1);
  }

  // Parse the JSON delta
  let delta;
  try {
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON object found in Phase 2 response");
    }
    delta = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error("Failed to parse delta JSON:", err.message);
    console.error("Raw Phase 2 response saved to sweeps/last_raw_response.txt");
    fs.writeFileSync(
      path.join(DELTA_DIR, "last_raw_response.txt"),
      jsonText,
      "utf-8"
    );
    process.exit(1);
  }

  // ── Validate the parsed delta ────────────────────────────────────
  console.log("\n=== VALIDATING SWEEP RESULTS ===");

  const validatedIntel = [];
  const rejectedIntel = [];

  for (const item of (delta.newIntel || [])) {
    const errors = [];

    if (item.rumor) {
      const rumourResult = validateRumour(item.rumor);
      if (!rumourResult.valid) errors.push(...rumourResult.errors);
    } else {
      errors.push("Missing rumor object");
    }

    const identityResult = validatePlayerIdentity(item, playersData);
    if (!identityResult.valid) errors.push(...identityResult.errors);

    if (item.rumor) {
      const tierResult = validateTierConsistency(item.rumor);
      if (!tierResult.valid) {
        tierResult.warnings.forEach(w => console.warn(`  TIER WARNING: ${item.playerName} — ${w}`));
      }
    }

    if (errors.length > 0) {
      rejectedIntel.push({ item, errors });
    } else {
      validatedIntel.push(item);
    }
  }

  delta.newIntel = validatedIntel;

  if (rejectedIntel.length > 0) {
    console.log(`\n=== REJECTED INTEL (${rejectedIntel.length} items) ===`);
    rejectedIntel.forEach(r => {
      console.log(`  REJECTED: ${r.item.playerName || "Unknown"} — ${r.errors.join("; ")}`);
    });
    if (!delta.needsReview) delta.needsReview = [];
    delta.needsReview.push(
      ...rejectedIntel.map(r => ({
        playerId: r.item.playerId,
        playerName: r.item.playerName || "Unknown",
        detail: r.item.rumor?.detail || "Unknown",
        reason: "Auto-rejected: " + r.errors.join("; ")
      }))
    );
  }

  if (delta.escalations && delta.escalations.length > 0) {
    delta.escalations = delta.escalations.filter(esc => {
      const result = validateEscalation(esc, playersData);
      if (!result.valid) {
        console.warn(`  REJECTED ESCALATION: ${esc.playerName} — ${result.errors.join("; ")}`);
        return false;
      }
      return true;
    });
  }

  const totalValidated = validatedIntel.length;
  const totalRejected = rejectedIntel.length;
  console.log(`\nValidation complete: ${totalValidated} accepted, ${totalRejected} rejected`);

  return delta;
}

// ── Apply delta to data files ─────────────────────────────────────────────
function applyDelta(delta) {
  let changed = false;

  if (delta.newIntel && delta.newIntel.length > 0) {
    console.log(`\n=== NEW INTEL (${delta.newIntel.length} items) ===`);
    for (const item of delta.newIntel) {
      const player = playersData.players.find(p => p.id === item.playerId);
      if (!player) {
        console.warn(`  SKIP: Player ID ${item.playerId} not found`);
        continue;
      }

      if (item.rumor) {
        if (!player.rumors) player.rumors = [];
        const isDupe = isDuplicate(item.rumor, player.rumors);
        if (isDupe) {
          console.log(`  SKIP (dupe): ${item.playerName} — ${item.rumor.detail}`);
          continue;
        }
        player.rumors.unshift(item.rumor);
        console.log(`  ADD: ${item.playerName} | ${item.rumor.date} | ${item.rumor.club} | ${item.rumor.detail}`);
        changed = true;
      }

      if (item.intelUpdates && typeof item.intelUpdates === "object") {
        const key = String(item.playerId);
        if (!intelData[key]) intelData[key] = {};
        Object.assign(intelData[key], item.intelUpdates);
        console.log(`  INTEL UPDATE: ${item.playerName} — ${Object.keys(item.intelUpdates).join(", ")}`);
        changed = true;
      }
    }
  }

  if (delta.escalations && delta.escalations.length > 0) {
    console.log(`\n=== ESCALATIONS (${delta.escalations.length}) ===`);
    for (const esc of delta.escalations) {
      const player = playersData.players.find(p => p.id === esc.playerId);
      if (!player) continue;
      if (esc.field === "status") {
        player.status = esc.newValue;
        console.log(`  ${esc.playerName}: ${esc.oldValue} → ${esc.newValue}`);
        changed = true;
      }
    }
  }

  if (delta.noChange && delta.noChange.length > 0) {
    console.log(`\n=== NO CHANGE (${delta.noChange.length} players) ===`);
    console.log(`  ${delta.noChange.join(", ")}`);
  }

  if (delta.needsReview && delta.needsReview.length > 0) {
    console.log(`\n=== NEEDS REVIEW (${delta.needsReview.length}) ===`);
    for (const nr of delta.needsReview) {
      console.log(`  ${nr.playerName}: ${nr.detail} — ${nr.reason}`);
    }
  }

  return changed;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
  fs.mkdirSync(DELTA_DIR, { recursive: true });

  const delta = await runSweep();
  const deltaPath = path.join(DELTA_DIR, `sweep_${timestamp}.json`);
  fs.writeFileSync(deltaPath, JSON.stringify(delta, null, 2), "utf-8");
  console.log(`\nDelta report saved: ${deltaPath}`);

  const hasChanges = applyDelta(delta);

  // Always update lastSweep so users know a sweep was attempted
  playersData.meta.lastSweep = today;
  playersData.meta.sweepNumber = delta.sweepNumber || playersData.meta.sweepNumber + 1;

  if (DRY_RUN) {
    console.log("\n--- DRY RUN: Changes detected but not written. ---");
    process.exit(0);
  }

  // Backups
  const backupDir = path.join(ROOT, "sweeps", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(PLAYERS_PATH, path.join(backupDir, `players_pre_sweep_${timestamp}.json`));
  fs.copyFileSync(INTEL_PATH, path.join(backupDir, `intel_pre_sweep_${timestamp}.json`));
  console.log("Pre-sweep backups saved.");

  // Write updated data
  fs.writeFileSync(PLAYERS_PATH, JSON.stringify(playersData, null, 2) + "\n", "utf-8");
  fs.writeFileSync(INTEL_PATH, JSON.stringify(intelData, null, 2) + "\n", "utf-8");
  console.log("\nData files updated.");

  // Build
  console.log("Running build...");
  try {
    const output = execSync(`bash "${BUILD_SCRIPT}"`, { cwd: ROOT, encoding: "utf-8" });
    console.log(output.trim());
  } catch (err) {
    console.error("Build failed:", err.message);
    process.exit(1);
  }

  console.log("\n=== SWEEP COMPLETE ===");
  const newCount = delta.newIntel ? delta.newIntel.length : 0;
  const escCount = delta.escalations ? delta.escalations.length : 0;
  const reviewCount = delta.needsReview ? delta.needsReview.length : 0;
  console.log(`New: ${newCount} | Escalated: ${escCount} | Review: ${reviewCount}`);
}

main().catch(err => {
  console.error("Sweep failed:", err);
  process.exit(1);
});
