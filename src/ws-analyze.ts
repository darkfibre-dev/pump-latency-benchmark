import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// Types
interface Row {
  mint: string;
  signature: string;
  timestamp: number;
  platform: string;
  server: string;
}

interface DelayStats {
  mean: number;
  stddev: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  count: number;
}

// Map each platform to its home server for the colocated view
const PLATFORM_HOME_SERVER: Record<string, string> = {
  darkfibre: "FRA",
  pumpportal: "NY",
  pumpapi: "NY"
};

// Helpers
function parseCSV(filePath: string): Row[] {
  const content = readFileSync(filePath, "utf-8").trim();
  if (!content) return [];

  return content.split("\n").map((line) => {
    const [mint, signature, timestampStr, platform, server] = line.split(",");
    return { mint, signature, timestamp: Number(timestampStr), platform, server };
  });
}

function loadAllCSVs(dir: string): Row[] {
  const allRows: Row[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Recurse into subdirectories
      allRows.push(...loadAllCSVs(fullPath));
    } else if (entry.name.endsWith(".csv")) {
      const rows = parseCSV(fullPath);
      allRows.push(...rows);
      console.log(`  ${fullPath} (${rows.length} rows)`);
    }
  }

  return allRows;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function computeDelayStats(values: number[]): DelayStats {
  if (values.length === 0)
    return { mean: 0, stddev: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;
  const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / sorted.length;
  return {
    mean,
    stddev: Math.sqrt(variance),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    count: sorted.length,
  };
}

function fmt(n: number, decimals = 1): string {
  return n.toFixed(decimals);
}

// Analysis
function analyzeRows(rows: Row[], label: string) {
  if (rows.length === 0) {
    console.log(`  No data for view: ${label}\n`);
    return;
  }

  // Group rows by mint (each mint = one token creation event)
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const existing = groups.get(row.mint);
    if (existing) existing.push(row);
    else groups.set(row.mint, [row]);
  }

  // Discover platforms
  const platformSet = new Set(rows.map((r) => r.platform));
  const platforms = [...platformSet].sort();

  const totalTokens = groups.size;

  console.log("═".repeat(100));
  console.log(`  ${label}`);
  console.log(
    `  Total rows: ${rows.length}  |  Unique tokens: ${totalTokens}  |  Platforms: ${platforms.join(", ")}`
  );
  console.log("═".repeat(100));

  // Win Rate
  const wins = new Map<string, number>();
  const ties = new Map<string, number>();
  for (const platform of platforms) {
    wins.set(platform, 0);
    ties.set(platform, 0);
  }

  for (const [, entries] of groups) {
    if (entries.length === 0) continue;
    const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
    const fastest = sorted[0].timestamp;

    const winners = sorted
      .filter((e) => e.timestamp === fastest)
      .map((e) => e.platform);
    const uniqueWinners = [...new Set(winners)];

    if (uniqueWinners.length === 1) {
      wins.set(uniqueWinners[0], wins.get(uniqueWinners[0])! + 1);
    } else {
      for (const w of uniqueWinners) {
        ties.set(w, ties.get(w)! + 1);
      }
    }
  }

  console.log("\n  WIN RATE (% of tokens seen first)");
  console.log("  " + "─".repeat(100));
  for (const platform of platforms) {
    const w = wins.get(platform)!;
    const t = ties.get(platform)!;
    const pct = (w / totalTokens) * 100;
    const tiePct = (t / totalTokens) * 100;
    const bar = "█".repeat(Math.round(pct / 2));
    console.log(
      `  ${platform.padEnd(14)} ${String(w).padStart(5)} wins  ${fmt(pct, 1).padStart(6)}%  ` +
        (t > 0 ? `(+${t} ties, ${fmt(tiePct, 1)}%)` : "") +
        `  ${bar}`
    );
  }

  // Delay vs Fastest (all tokens)
  const delaysByPlatform = new Map<string, number[]>();
  for (const platform of platforms) {
    delaysByPlatform.set(platform, []);
  }

  for (const [, entries] of groups) {
    if (entries.length < 2) continue;
    const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
    const fastest = sorted[0].timestamp;

    const platformTimes = new Map<string, number>();
    for (const entry of sorted) {
      if (!platformTimes.has(entry.platform)) {
        platformTimes.set(entry.platform, entry.timestamp);
      }
    }

    for (const [platform, ts] of platformTimes) {
      const delay = ts - fastest;
      delaysByPlatform.get(platform)!.push(delay);
    }
  }

  const delayHeader =
    `  ${"platform".padEnd(14)} ${"count".padStart(5)}  ${"mean".padStart(7)}  ${"stddev".padStart(7)}  ` +
    `${"p50".padStart(7)}  ${"p95".padStart(7)}  ${"p99".padStart(7)}  ${"min".padStart(5)}  ${"max".padStart(5)}`;

  const printDelayRow = (platform: string, delays: number[]) => {
    const stats = computeDelayStats(delays);
    console.log(
      `  ${platform.padEnd(14)} ${String(stats.count).padStart(5)}  ` +
        `${fmt(stats.mean).padStart(7)}  ${fmt(stats.stddev).padStart(7)}  ` +
        `${fmt(stats.p50).padStart(7)}  ${fmt(stats.p95).padStart(7)}  ` +
        `${fmt(stats.p99).padStart(7)}  ` +
        `${fmt(stats.min, 0).padStart(5)}  ${fmt(stats.max, 0).padStart(5)}`
    );
  };

  console.log("\n  DELAY vs. FASTEST — all tokens (ms)");
  console.log("  " + "─".repeat(100));
  console.log(delayHeader);
  console.log("  " + "─".repeat(100));
  for (const platform of platforms) {
    printDelayRow(platform, delaysByPlatform.get(platform)!);
  }

  // Coverage
  const platformTokenCount = new Map<string, number>();
  for (const platform of platforms) {
    let count = 0;
    for (const [, entries] of groups) {
      if (entries.some((e) => e.platform === platform)) count++;
    }
    platformTokenCount.set(platform, count);
  }

  console.log("\n  COVERAGE (% of unique tokens seen)");
  console.log("  " + "─".repeat(100));
  for (const platform of platforms) {
    const count = platformTokenCount.get(platform)!;
    const pct = (count / totalTokens) * 100;
    const bar = "█".repeat(Math.round(pct / 2));
    console.log(
      `  ${platform.padEnd(14)} ${String(count).padStart(5)} / ${totalTokens}  ${fmt(pct, 3).padStart(8)}%  ${bar}`
    );
  }

  console.log("\n" + "═".repeat(100));
}

// Colocated view: for each platform, only keep rows from its "home" server
// This is the fairest comparison — each service measured from the server closest to its infrastructure
function filterColocated(rows: Row[]): Row[] {
  return rows.filter((r) => {
    const home = PLATFORM_HOME_SERVER[r.platform];
    return home ? r.server === home : true;
  });
}

// Entry Point
const args = process.argv.slice(2);
const target = args[0] ?? "data";
const resolved = resolve(target);

let allRows: Row[];

try {
  const stat = statSync(resolved);
  if (stat.isDirectory()) {
    console.log(`\nLoading CSVs from: ${resolved}`);
    allRows = loadAllCSVs(resolved);
  } else {
    console.log(`\nLoading file: ${resolved}`);
    allRows = parseCSV(resolved);
    console.log(`  ${resolved} (${allRows.length} rows)`);
  }
} catch {
  console.error(`Path not found: ${resolved}`);
  process.exit(1);
}

if (allRows.length === 0) {
  console.log("No CSV data found.");
  process.exit(1);
}

const servers = [...new Set(allRows.map((r) => r.server))].sort();
const platforms = [...new Set(allRows.map((r) => r.platform))].sort();
console.log(
  `\n  Total: ${allRows.length} rows  |  Servers: ${servers.join(", ")}  |  Platforms: ${platforms.join(", ")}\n`
);

// Colocated perspective
const colocated = filterColocated(allRows);
const homeMap = Object.entries(PLATFORM_HOME_SERVER)
  .map(([p, s]) => `${p}->${s}`)
  .join(", ");
analyzeRows(colocated, `Colocated Perspective (${homeMap})`);
console.log();