#!/usr/bin/env node
/**
 * ─── Player Watchlist — Onboard Script ───
 *
 * Verifies a suggested player using Claude + web_search, then generates
 * the data objects to add them to the tracker.
 *
 * Two-phase approach (same as sweep):
 *   Phase 1 — Claude searches the web to verify the player's identity.
 *   Phase 2 — A second Claude call produces structured JSON data.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... node scripts/onboard.mjs \
 *     --name "Player Name" --year 2008 --country "Senegal" \
 *     --position "FW" --club "Diambars FC" [--context "extra info"]
 *
 * Output: JSON to stdout with { confidence, player, intel, reasoning }
 */

import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// ── CLI args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const playerName = getArg("--name", "");
const birthYear = parseInt(getArg("--year", "0"), 10);
const country = getArg("--country", "");
const position = getArg("--position", "");
const currentClub = getArg("--club", "");
const extraContext = getArg("--context", "");

// ── Country → Flag emoji mapping ──────────────────────────────────────
const COUNTRY_FLAGS = {
  "Algeria": "\u{1F1E9}\u{1F1FF}",
  "Angola": "\u{1F1E6}\u{1F1F4}",
  "Benin": "\u{1F1E7}\u{1F1EF}",
  "Burkina Faso": "\u{1F1E7}\u{1F1EB}",
  "Burundi": "\u{1F1E7}\u{1F1EE}",
  "Cameroon": "\u{1F1E8}\u{1F1F2}",
  "Cape Verde": "\u{1F1E8}\u{1F1FB}",
  "Central African Republic": "\u{1F1E8}\u{1F1EB}",
  "Chad": "\u{1F1F9}\u{1F1E9}",
  "Comoros": "\u{1F1F0}\u{1F1F2}",
  "Congo": "\u{1F1E8}\u{1F1EC}",
  "Congo DR": "\u{1F1E8}\u{1F1E9}",
  "Djibouti": "\u{1F1E9}\u{1F1EF}",
  "Egypt": "\u{1F1EA}\u{1F1EC}",
  "Equatorial Guinea": "\u{1F1EC}\u{1F1F6}",
  "Eritrea": "\u{1F1EA}\u{1F1F7}",
  "Eswatini": "\u{1F1F8}\u{1F1FF}",
  "Ethiopia": "\u{1F1EA}\u{1F1F9}",
  "Gabon": "\u{1F1EC}\u{1F1E6}",
  "Gambia": "\u{1F1EC}\u{1F1F2}",
  "Ghana": "\u{1F1EC}\u{1F1ED}",
  "Guinea": "\u{1F1EC}\u{1F1F3}",
  "Guinea-Bissau": "\u{1F1EC}\u{1F1FC}",
  "Ivory Coast": "\u{1F1E8}\u{1F1EE}",
  "Kenya": "\u{1F1F0}\u{1F1EA}",
  "Lesotho": "\u{1F1F1}\u{1F1F8}",
  "Liberia": "\u{1F1F1}\u{1F1F7}",
  "Libya": "\u{1F1F1}\u{1F1FE}",
  "Madagascar": "\u{1F1F2}\u{1F1EC}",
  "Malawi": "\u{1F1F2}\u{1F1FC}",
  "Mali": "\u{1F1F2}\u{1F1F1}",
  "Mauritania": "\u{1F1F2}\u{1F1F7}",
  "Mauritius": "\u{1F1F2}\u{1F1FA}",
  "Morocco": "\u{1F1F2}\u{1F1E6}",
  "Mozambique": "\u{1F1F2}\u{1F1FF}",
  "Namibia": "\u{1F1F3}\u{1F1E6}",
  "Niger": "\u{1F1F3}\u{1F1EA}",
  "Nigeria": "\u{1F1F3}\u{1F1EC}",
  "Rwanda": "\u{1F1F7}\u{1F1FC}",
  "Senegal": "\u{1F1F8}\u{1F1F3}",
  "Sierra Leone": "\u{1F1F8}\u{1F1F1}",
  "Somalia": "\u{1F1F8}\u{1F1F4}",
  "South Africa": "\u{1F1FF}\u{1F1E6}",
  "South Sudan": "\u{1F1F8}\u{1F1F8}",
  "Sudan": "\u{1F1F8}\u{1F1E9}",
  "Tanzania": "\u{1F1F9}\u{1F1FF}",
  "Togo": "\u{1F1F9}\u{1F1EC}",
  "Tunisia": "\u{1F1F9}\u{1F1F3}",
  "Uganda": "\u{1F1FA}\u{1F1EC}",
  "Zambia": "\u{1F1FF}\u{1F1F2}",
  "Zimbabwe": "\u{1F1FF}\u{1F1FC}",
  "Other": "\u{1F30D}"
};

// ── Validate inputs ───────────────────────────────────────────────────
if (!playerName || playerName.length < 2 || playerName.length > 80) {
  console.error(JSON.stringify({ error: "Invalid player name (must be 2-80 chars)" }));
  process.exit(1);
}
if (!birthYear || birthYear < 2000 || birthYear > 2015) {
  console.error(JSON.stringify({ error: "Invalid birth year (must be 2000-2015)" }));
  process.exit(1);
}
// Country and position are optional — bot auto-detects during verification
const autoDetectCountry = !country || country === "_Auto-detect_";
const autoDetectPosition = !position || position === "_Auto-detect_";
if (country && !autoDetectCountry && !COUNTRY_FLAGS[country]) {
  console.error(JSON.stringify({ error: `Unknown country: "${country}"` }));
  process.exit(1);
}
if (!currentClub || currentClub.length < 2) {
  console.error(JSON.stringify({ error: "Current club is required" }));
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error(JSON.stringify({ error: "ANTHROPIC_API_KEY is required" }));
  process.exit(1);
}

// ── Load existing data ────────────────────────────────────────────────
const PLAYERS_PATH = path.join(ROOT, "data", "players.json");
const INTEL_PATH = path.join(ROOT, "data", "intel.json");
const playersData = JSON.parse(fs.readFileSync(PLAYERS_PATH, "utf-8"));
const intelData = JSON.parse(fs.readFileSync(INTEL_PATH, "utf-8"));

// ── Duplicate check ───────────────────────────────────────────────────
function normalizeName(s) {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

function checkDuplicate() {
  const normInput = normalizeName(playerName);
  for (const p of playersData.players) {
    const normExisting = normalizeName(p.name);
    // Exact name match
    if (normExisting === normInput) return p;
    // Alt spelling match
    if ((p.altSpellings || []).some(alt => normalizeName(alt) === normInput)) return p;
    // Same country + same birth year + high name similarity (skip if country unknown)
    if (!autoDetectCountry && p.country === country && p.birthYear === birthYear) {
      const words1 = new Set(normInput.split(/\s+/));
      const words2 = new Set(normExisting.split(/\s+/));
      const overlap = [...words1].filter(w => words2.has(w)).length;
      if (overlap >= Math.min(words1.size, words2.size) && overlap > 0) return p;
    }
  }
  return null;
}

const dupe = checkDuplicate();
if (dupe) {
  console.log(JSON.stringify({
    error: "duplicate",
    message: `"${playerName}" appears to match existing player: ${dupe.name} (ID ${dupe.id}, ${dupe.country}, ${dupe.birthYear})`,
    existingPlayer: dupe.name,
    existingId: dupe.id
  }));
  process.exit(0);
}

// ── Next ID ───────────────────────────────────────────────────────────
const nextId = playersData.players.length > 0
  ? Math.max(...playersData.players.map(p => p.id)) + 1
  : 1;

const today = new Date().toLocaleDateString("en-US", {
  month: "short", day: "numeric", year: "numeric"
});

const MODEL = process.env.SWEEP_MODEL || "claude-haiku-4-5-20251001";

// ── Retry helper ──────────────────────────────────────────────────────
async function withRetry(fn, label, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRateLimit = err.status === 429 || (err.message && err.message.includes("rate_limit"));
      if (isRateLimit && attempt < maxRetries) {
        const wait = attempt * 30;
        console.error(`  Rate limited on ${label} (attempt ${attempt}/${maxRetries}). Waiting ${wait}s...`);
        await new Promise(r => setTimeout(r, wait * 1000));
      } else {
        throw err;
      }
    }
  }
}

// ── Phase 1: Verify player identity ───────────────────────────────────
async function phase1Verify(client) {
  const countryHint = autoDetectCountry ? "Unknown — please determine from search results" : country;
  const positionHint = autoDetectPosition ? "Unknown — please determine from search results" : position;

  const searchPrompt = `You are a football player identity verification assistant. Today is ${today}.

A user has suggested adding this player to a transfer tracker:
- Name: ${playerName}
- Birth Year: ~${birthYear} (approximate)
- Country: ${countryHint}
- Position: ${positionHint}
- Current Club: ${currentClub}
${extraContext ? `- Additional context: ${extraContext}` : ""}

Your task:
1. Search for this player to VERIFY their identity
2. Run 3-5 web searches:
   - "${playerName}" ${currentClub} football
   - "${playerName}" ${birthYear} football youth
   - "${playerName}" transfer 2026
   - Also try French variants if the club/name suggests a francophone player
3. Determine if this is a REAL youth football player matching the provided details
4. IMPORTANT: Determine the player's NATIONALITY and POSITION from search results if not provided
5. Check for CONFUSION RISKS — older or more famous players with similar names
6. Gather any available info: height, foot preference, contract, stats, transfer rumours

Report your findings clearly. For each search, note what you found or didn't find.
Include the player's COUNTRY and POSITION in your findings.
Rate your confidence:
- HIGH: Found in 2+ independent sources, all details match
- MEDIUM: Found in 1 source, most details match
- LOW: Could not confirm, or found a major confusion risk`;

  console.error("Phase 1: Verifying player identity...");

  const findings = await withRetry(async () => {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 3000,
      system: "You are a football player identity verification agent. Search for the player and report findings concisely. Do NOT produce JSON.",
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
      messages: [{ role: "user", content: searchPrompt }]
    });

    let searchCount = 0;
    stream.on("event", (event) => {
      if (event.type === "content_block_start" && event.content_block?.type === "web_search_tool_result") {
        searchCount++;
        process.stderr.write(`  [Search ${searchCount}/8] `);
      }
    });

    const response = await stream.finalMessage();
    console.error(`\n  Phase 1 complete: ${searchCount} searches performed.`);

    return response.content.filter(b => b.type === "text").map(b => b.text).join("\n");
  }, "Phase 1 verification");

  return findings;
}

// ── Phase 2: Generate JSON data ───────────────────────────────────────
async function phase2Generate(client, findings) {
  const countryHint = autoDetectCountry ? "DETERMINE FROM SEARCH FINDINGS" : country;
  const positionHint = autoDetectPosition ? "DETERMINE FROM SEARCH FINDINGS" : position;
  const flagHint = autoDetectCountry ? "DETERMINE — use country flag emoji" : (COUNTRY_FLAGS[country] || "\u{1F30D}");

  const countryFlagList = Object.entries(COUNTRY_FLAGS).map(([c, f]) => `${c}: ${f}`).join(", ");

  const jsonPrompt = `You are the JSON formatter for the Player Watchlist. Based on the verification findings below, produce the structured data for a new player.

TODAY'S DATE: ${today}

## PLAYER SUGGESTION
- Name: ${playerName}
- Birth Year: ~${birthYear} (approximate)
- Country: ${countryHint}
- Position: ${positionHint}
- Current Club: ${currentClub}
- Assigned ID: ${nextId}

## VERIFICATION FINDINGS
${findings}

## RULES
1. confidence must be "high", "medium", or "low" based on the verification findings
2. If confidence is "low", still produce the data but explain why in reasoning
3. For the player object, use EXACTLY this schema — no extra fields
4. IMPORTANT: Determine the correct COUNTRY and POSITION from the search findings
5. Use the correct flag emoji for the country. Available flags: ${countryFlagList}
6. Valid positions: GK, CB, LB, RB, DF, DM, CM, MF, AM, LW, RW, FW, ST
7. altSpellings: include common alternate spellings found during search
8. confusionRisk: if there's an older/more famous player with a similar name, describe them (format: "Name (b.YYYY, Club)")
9. If transfer rumours were found during verification, include them in rumors[]
10. Rumour status must be one of: rumour, advanced, confirmed, official
11. Dates must use format: "Mon DD, YYYY" (e.g. "Feb 8, 2026")
12. For intel fields, use "—" if not found
13. birthYear should be the VERIFIED birth year from search, or the approximate one provided

## OUTPUT
Return ONLY a valid JSON object (no markdown fences, no commentary):
{
  "confidence": "high|medium|low",
  "reasoning": "<why this confidence level>",
  "player": {
    "id": ${nextId},
    "name": "<verified full name>",
    "country": "<country determined from findings>",
    "flag": "<country flag emoji>",
    "position": "<position determined from findings>",
    "birthYear": <verified or approximate birth year>,
    "currentClub": "<verified club name>",
    "status": "no_rumours",
    "sweepTier": "C",
    "altSpellings": [],
    "confusionRisk": null,
    "rumors": []
  },
  "intel": {
    "height": "<or —>",
    "foot": "<Left/Right/Both feet or —>",
    "contract": "<or —>",
    "previousClub": "<or —>",
    "seasonStats": "<or —>",
    "clubStanding": "<or —>",
    "notes": "<scout-style summary of what was found>"
  }
}

Return ONLY the JSON — nothing else.`;

  console.error("Phase 2: Generating player data...");

  const fullText = await withRetry(async () => {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: jsonPrompt }]
    });
    return response.content.filter(b => b.type === "text").map(b => b.text).join("\n");
  }, "Phase 2 JSON");

  return fullText;
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  const client = new Anthropic();

  console.error(`\n=== ONBOARD: ${playerName} ===`);
  console.error(`Country: ${autoDetectCountry ? "auto-detect" : country} | Position: ${autoDetectPosition ? "auto-detect" : position} | Born: ~${birthYear}`);
  console.error(`Club: ${currentClub}`);
  console.error(`Next ID: ${nextId}\n`);

  // Phase 1: Verify
  const findings = await phase1Verify(client);

  // Phase 2: Generate data
  const jsonText = await phase2Generate(client, findings);

  // Parse result
  let result;
  try {
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON object found");
    result = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error("Failed to parse JSON:", err.message);
    console.log(JSON.stringify({ error: "parse_failed", raw: jsonText }));
    process.exit(1);
  }

  // Validate required fields
  if (!result.player || !result.player.name || !result.intel) {
    console.error("Missing required fields in result");
    console.log(JSON.stringify({ error: "missing_fields", raw: jsonText }));
    process.exit(1);
  }

  // Ensure correct ID and flag
  result.player.id = nextId;
  result.player.flag = COUNTRY_FLAGS[country] || "\u{1F30D}";

  // Output result to stdout (workflow reads this)
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error("Onboard failed:", err.message);
  console.log(JSON.stringify({ error: "fatal", message: err.message }));
  process.exit(1);
});
