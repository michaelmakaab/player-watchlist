/**
 * ─── Validation module for Player Watchlist sweeps ───
 *
 * Validates API-returned intel before writing to data files.
 * Catches identity confusion, schema errors, tier mismatches, and duplicates.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// ── Load club alias registry ─────────────────────────────────────────
let clubsRegistry = { aliases: {}, academyPipelines: {} };
const CLUBS_PATH = path.join(ROOT, "data", "clubs.json");
try {
  clubsRegistry = JSON.parse(fs.readFileSync(CLUBS_PATH, "utf-8"));
} catch (e) {
  console.warn("Warning: data/clubs.json not found — club validation limited.");
}

// ── Date format regex ────────────────────────────────────────────────
const DATE_PATTERN = /^(Mid-)?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}$/;

// ── Known source tiers (lowercase) ──────────────────────────────────
const TIER_1_KEYWORDS = ["official", "club site", "transfermarkt", "romano", "ornstein", "moretto"];
const TIER_2_KEYWORDS = ["africafoot", "africa top sports", "foot africa", "panafricafootball", "teamtalk", "the athletic", "espn", "sky", "l'équipe", "l'equipe", "bold.dk", "gazzetta"];
const TIER_4_KEYWORDS = ["fan blog", "unverified", "tabloid", "rumour mill"];

// ── Helpers ──────────────────────────────────────────────────────────
export function normalizeName(s) {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

function normalizeClub(club) {
  for (const [canonical, aliases] of Object.entries(clubsRegistry.aliases || {})) {
    const allForms = [canonical, ...aliases].map(s => s.toLowerCase());
    if (allForms.includes(club.toLowerCase())) return canonical.toLowerCase();
  }
  return club.toLowerCase()
    .replace(/^fc\s+/i, "").replace(/\s+fc$/i, "")
    .replace(/^ac\s+/i, "").replace(/\s+ac$/i, "")
    .trim();
}

// ── 1. Validate rumour schema ────────────────────────────────────────
export function validateRumour(rumour) {
  const errors = [];

  if (!rumour.date || typeof rumour.date !== "string") {
    errors.push("Missing or invalid date");
  } else if (!DATE_PATTERN.test(rumour.date)) {
    errors.push(`Date format invalid: "${rumour.date}" — expected "Mon DD, YYYY"`);
  }

  if (!rumour.club || typeof rumour.club !== "string" || rumour.club.trim().length === 0) {
    errors.push("Missing club name");
  } else if (rumour.club.length > 60) {
    errors.push(`Club name too long (${rumour.club.length} chars, max 60)`);
  }

  if (!rumour.detail || typeof rumour.detail !== "string" || rumour.detail.trim().length === 0) {
    errors.push("Missing detail");
  } else if (rumour.detail.length > 100) {
    errors.push(`Detail too long (${rumour.detail.length} chars, max 100)`);
  }

  if (!rumour.source || typeof rumour.source !== "string") {
    errors.push("Missing source");
  }

  if (rumour.sourceUrl !== undefined && rumour.sourceUrl !== null) {
    if (typeof rumour.sourceUrl !== "string") {
      errors.push("sourceUrl must be a string or null");
    } else if (rumour.sourceUrl.length > 0) {
      try { new URL(rumour.sourceUrl); } catch { errors.push(`sourceUrl is not a valid URL`); }
    }
  }

  if (rumour.tier === undefined || rumour.tier === null) {
    errors.push("Missing tier");
  } else if (!Number.isInteger(rumour.tier) || rumour.tier < 1 || rumour.tier > 4) {
    errors.push(`Invalid tier: ${rumour.tier} — must be 1-4`);
  }

  const VALID_RUMOUR_STATUSES = ["rumour", "advanced", "confirmed", "official"];
  if (!rumour.status || typeof rumour.status !== "string") {
    errors.push("Missing status");
  } else if (!VALID_RUMOUR_STATUSES.includes(rumour.status)) {
    errors.push(`Invalid rumour status "${rumour.status}" — must be one of: ${VALID_RUMOUR_STATUSES.join(", ")}`);
  }

  if (typeof rumour.recent !== "boolean") {
    errors.push("Missing or invalid 'recent' boolean");
  }

  return { valid: errors.length === 0, errors };
}

// ── 2. Validate player identity ──────────────────────────────────────
export function validatePlayerIdentity(intelItem, playersData) {
  const errors = [];
  const player = playersData.players.find(p => p.id === intelItem.playerId);

  if (!player) {
    errors.push(`Player ID ${intelItem.playerId} not found in master list`);
    return { valid: false, errors };
  }

  if (intelItem.playerName) {
    const apiName = normalizeName(intelItem.playerName);
    const masterName = normalizeName(player.name);
    if (apiName !== masterName) {
      const altMatch = (player.altSpellings || []).some(alt => normalizeName(alt) === apiName);
      if (!altMatch) {
        errors.push(`Name mismatch: API returned "${intelItem.playerName}" but ID ${intelItem.playerId} is "${player.name}"`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── 3. Duplicate detection ───────────────────────────────────────────

function parseDateStr(str) {
  const cleaned = str.replace("Mid-", "15 ");
  const d = new Date(cleaned);
  return isNaN(d.getTime()) ? null : d;
}

function wordOverlap(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const overlap = [...wordsA].filter(w => wordsB.has(w)).length;
  const maxLen = Math.max(wordsA.size, wordsB.size);
  return maxLen > 0 ? overlap / maxLen : 0;
}

export function isDuplicate(newRumour, existingRumours) {
  const normNewClub = normalizeClub(newRumour.club);
  const newDate = parseDateStr(newRumour.date);

  return existingRumours.some(r => {
    if (r.date === newRumour.date && r.club === newRumour.club && r.detail === newRumour.detail) return true;
    const normExistClub = normalizeClub(r.club);
    const sameClub = normNewClub === normExistClub;
    if (r.date === newRumour.date && sameClub) {
      if (wordOverlap(newRumour.detail, r.detail) > 0.6) return true;
    }
    if (sameClub && newDate) {
      const existDate = parseDateStr(r.date);
      if (existDate) {
        const daysDiff = Math.abs(newDate - existDate) / (1000 * 60 * 60 * 24);
        if (daysDiff > 0 && daysDiff <= 7 && wordOverlap(newRumour.detail, r.detail) > 0.75) return true;
      }
    }
    return false;
  });
}

// ── 4. Tier consistency check ────────────────────────────────────────
export function validateTierConsistency(rumour) {
  const warnings = [];
  const sourceLower = (rumour.source || "").toLowerCase();
  if (TIER_1_KEYWORDS.some(k => sourceLower.includes(k)) && rumour.tier >= 3) {
    warnings.push(`Source "${rumour.source}" appears T1/T2 but labeled Tier ${rumour.tier}`);
  }
  if (TIER_4_KEYWORDS.some(k => sourceLower.includes(k)) && rumour.tier === 1) {
    warnings.push(`Source "${rumour.source}" appears speculative but labeled Tier 1`);
  }
  return { valid: warnings.length === 0, warnings };
}

// ── 5. Validate escalation ───────────────────────────────────────────
const VALID_STATUSES = ["active", "confirmed", "monitoring", "no_rumours"];

export function validateEscalation(esc, playersData) {
  const errors = [];
  const player = playersData.players.find(p => p.id === esc.playerId);
  if (!player) { errors.push(`Player ID ${esc.playerId} not found`); return { valid: false, errors }; }
  if (esc.field === "status" && !VALID_STATUSES.includes(esc.newValue)) {
    errors.push(`Invalid status "${esc.newValue}" — must be one of: ${VALID_STATUSES.join(", ")}`);
  }
  return { valid: errors.length === 0, errors };
}
