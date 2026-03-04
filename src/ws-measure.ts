import WebSocket from "ws";
import "dotenv/config";
import { appendFile, mkdir } from "node:fs/promises";

const startTime = Date.now();
const DURATION = 24 * 3600 * 1000;

const { DARKFIBRE_API_KEY, SERVER } = process.env;
if (!DARKFIBRE_API_KEY) throw new Error("DARKFIBRE_API_KEY not set");
if (!SERVER) throw new Error("SERVER not set");

const LOG = `data/log_${startTime}_${SERVER}`;
const CSV = `data/measurements_${startTime}_${SERVER}.csv`;
const expired = () => Date.now() > startTime + DURATION;
const err2str = (e: unknown) => e instanceof Error ? e.stack ?? e.message : String(e);

async function log(level: "INFO" | "WARN" | "ERROR", msg: string) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  (level === "ERROR" ? console.error : console.log)(line);
  await appendFile(LOG, line + "\n").catch(() => {});
}

process.on("uncaughtException", (e) => log("ERROR", `Uncaught: ${err2str(e)}`));
process.on("unhandledRejection", (e) => log("ERROR", `Unhandled rejection: ${err2str(e)}`));
process.on("exit", (code) => log("WARN", `Process exiting with code ${code}`));
process.on("SIGINT", () => { log("WARN", "Received SIGINT"); process.exit(130); });
process.on("SIGTERM", () => { log("WARN", "Received SIGTERM"); process.exit(143); });
process.on("SIGHUP", () => { log("WARN", "Received SIGHUP"); process.exit(129); });

const platforms: Record<string, { url: string; subscribeMessage?: string; headers?: Record<string, string> }> = {
  darkfibre: {
    url: `wss://ws.darkfibre.dev/v1?apiKey=${DARKFIBRE_API_KEY}`,
    subscribeMessage: JSON.stringify({
      type: "subscribe",
      filters: { platform: ["pump_fun"], eventType: ["create"] },
    }),
  },
  pumpportal: {
    url: `wss://pumpportal.fun/api/data`,
    subscribeMessage: JSON.stringify({ method: "subscribeNewToken" }),
  },
  pumpapi: {
    url: `wss://stream.pumpapi.io`,
  }
};

function extractCreate(platform: string, msg: any): { mint: string; signature: string } | null {
  switch (platform) {
    case "darkfibre":
      if (msg.type === "transaction")
        return { mint: msg.data.mint, signature: msg.data.signature };
      break;
    case "pumpapi":
      if (msg.txType === "create" && msg.pool === "pump")
        return { mint: msg.mint, signature: msg.signature };
      break;
    case "pumpportal":
      if (!msg.message && msg.txType === "create" && msg.pool === "pump")
        return { mint: msg.mint, signature: msg.signature };
      break;
  }
  return null;
}

class WsClient {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private platform: string,
    private url: string,
    private subMsg?: string,
    private headers?: Record<string, string>,
  ) {}

  private tag(msg: string) { return `[${this.platform}] ${msg}`; }

  async connect(): Promise<void> {
    await mkdir("data/ws", { recursive: true });
    log("INFO", this.tag(`Connecting... ${this.platform}`));

    this.ws = new WebSocket(this.url, { headers: this.headers });

    this.ws.on("open", () => {
      this.attempts = 0;
      log("INFO", this.tag(`Connected ${this.platform}`));
      if (this.subMsg) this.ws!.send(this.subMsg);
    });

    this.ws.on("message", async (raw) => {
      if (expired()) { this.ws?.close(1000, "done"); return; }
      try {
        const hit = extractCreate(this.platform, JSON.parse(raw.toString()));
        if (hit) await appendFile(CSV, `${hit.mint},${hit.signature},${Date.now()},${this.platform},${SERVER}\n`).catch(e => log("ERROR", this.tag(`Save failed: ${err2str(e)}`)));
      } catch (e) { log("ERROR", this.tag(`Parse error: ${err2str(e)}`)); }
    });

    this.ws.on("close", (code, reason) => {
      log("WARN", this.tag(`Closed: ${code} ${reason?.toString() ?? ""}`));
      if (!expired()) this.reconnect();
    });

    this.ws.on("error", (e) => log("ERROR", this.tag(`Error: ${e.message}`)));
  }

  private reconnect() {
    const delay = Math.min(1000 * 2 ** this.attempts++, 30_000);
    log("INFO", this.tag(`Reconnecting in ${delay}ms (attempt ${this.attempts})`));
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect().catch(e => {
      log("ERROR", this.tag(`Reconnect failed: ${err2str(e)}`));
      if (!expired()) this.reconnect();
    }), delay);
  }
}

// Start the WS clients
log("INFO", `Starting — ${DURATION / 3600_000}h, server=${SERVER}, pid=${process.pid}`);

for (const [name, cfg] of Object.entries(platforms))
  new WsClient(name, cfg.url, cfg.subscribeMessage, cfg.headers).connect().catch(e =>
    log("ERROR", `[${name}] Initial connect failed: ${err2str(e)}`));