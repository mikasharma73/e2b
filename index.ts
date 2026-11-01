/**
 * e2b batch runner
 *
 * Runs N sandboxes in parallel (batch size) for L batches (loops).
 * Each sandbox: install bun -> bun add -g lovdacn -> bunx lovdacn init -> kill.
 * After all sandboxes of a batch are done, wait 2s, then next batch.
 *
 * Usage:
 *   E2B_API_KEY=xxx bun run index.ts --batch-size 10 --loops 10
 *   (or bun run index.ts --api-key xxx --batch-size 10 --loops 10)
 *   (or run without args and it will ask you for key, batch size, and loops)
 */

import { Sandbox } from "e2b";
import { stdin, stdout } from "node:process";

const BATCH_WAIT_MS = 200; // wait between batches
const SANDBOX_TIMEOUT_MS = 30 * 60_000; // sandbox hard limit

// ---------------------------------------------------------------------------
// colors — each sandbox gets its own random color
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";

const PALETTE = [
  "\x1b[32m", // green
  "\x1b[36m", // cyan
  "\x1b[35m", // magenta
  "\x1b[33m", // yellow
  "\x1b[34m", // blue
  "\x1b[91m", // bright red
  "\x1b[92m", // bright green
  "\x1b[96m", // bright cyan
  "\x1b[95m", // bright magenta
  "\x1b[93m", // bright yellow
  "\x1b[94m", // bright blue
];

const availableColors = [...PALETTE];
const FALLBACK_COLOR = "\x1b[32m";

/** give each sandbox a random color (no repeat while unused colors remain) */
function takeColor(): string {
  if (availableColors.length === 0) availableColors.push(...PALETTE);
  const i = Math.floor(Math.random() * availableColors.length);
  const picked = availableColors.splice(i, 1)[0] ?? FALLBACK_COLOR;
  return picked;
}

// ---------------------------------------------------------------------------
// per-sandbox spinner/loader
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const statuses = new Map<string, { color: string; text: string }>();
let spinTick = 0;
let blockLines = 0;
let spinnerTimer: ReturnType<typeof setInterval> | null = null;

/** every normal log goes through here so the spinner block never gets corrupted */
function log(msg: string) {
  if (!stdout.isTTY) {
    console.log(msg);
    return;
  }
  eraseBlock();
  console.log(msg);
  paintBlock();
}

function logErr(msg: string) {
  if (!stdout.isTTY) {
    console.error(msg);
    return;
  }
  eraseBlock();
  console.error(msg);
  paintBlock();
}

function eraseBlock() {
  if (blockLines > 0) stdout.write(`\x1b[${blockLines}A\x1b[J`);
  blockLines = 0;
}

function paintBlock() {
  if (!stdout.isTTY || statuses.size === 0) return;
  const frame = SPINNER_FRAMES[spinTick % SPINNER_FRAMES.length] ?? "⠋";
  for (const [tag, st] of statuses) {
    stdout.write(`${tag} ${DIM}${frame}${RESET} ${st.text}\x1b[K\n`);
  }
  blockLines = statuses.size;
}

function startSpinner() {
  if (!stdout.isTTY || spinnerTimer) return;
  spinnerTimer = setInterval(() => {
    spinTick++;
    if (statuses.size > 0) {
      eraseBlock();
      paintBlock();
    }
  }, 120);
}

function stopSpinner() {
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
  }
  eraseBlock();
}

function setStatus(tag: string, color: string, text: string) {
  statuses.set(tag, { color, text });
}

function clearStatus(tag: string) {
  statuses.delete(tag);
}

// Commands run inside each sandbox.
// Everything uses bun. bun installs to ~/.bun -> every fresh shell must add it to PATH.
const INSTALL_BUN_CMD =
  'curl -fsSL https://bun.sh/install | bash > /dev/null 2>&1 && export PATH="$HOME/.bun/bin:$PATH" && bun -v';

const BUN_INSTALL_CMD =
  'export PATH="$HOME/.bun/bin:$PATH" && bun add -g lovdacn';

const LOVDACN_INIT_CMD =
  'export PATH="$HOME/.bun/bin:$PATH" && ' +
  "bunx lovdacn@latest init --preset aKjNfm --engine nativewind --expo-version 54 " +
  "-n my-app -y -f -p bun";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function parseArgs(): { batchSize?: number; loops?: number; apiKey?: string } {
  const args = process.argv.slice(2);
  const out: { batchSize?: number; loops?: number; apiKey?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const val = args[i + 1];
    if ((args[i] === "--batch-size" || args[i] === "-b") && val !== undefined) {
      out.batchSize = parseInt(val, 10);
      i++;
    } else if ((args[i] === "--loops" || args[i] === "-l") && val !== undefined) {
      out.loops = parseInt(val, 10);
      i++;
    } else if ((args[i] === "--api-key" || args[i] === "-k") && val !== undefined) {
      out.apiKey = val;
      i++;
    }
  }
  return out;
}

// simple stdin line reader (works interactive & piped)
let stdinEnded = false;
const lineQueue: string[] = [];
let waitingResolve: ((line: string | null) => void) | null = null;
let inputBuffer = "";

stdin.setEncoding("utf8");
stdin.on("data", (chunk: string) => {
  inputBuffer += chunk;
  const lines = inputBuffer.split(/\r?\n/);
  inputBuffer = lines.pop() ?? "";
  for (const line of lines) {
    if (waitingResolve) {
      const r = waitingResolve;
      waitingResolve = null;
      r(line);
    } else {
      lineQueue.push(line);
    }
  }
});

const onEnd = () => {
  stdinEnded = true;
  if (inputBuffer.length > 0) {
    const remaining = inputBuffer;
    inputBuffer = "";
    if (waitingResolve) {
      const r = waitingResolve;
      waitingResolve = null;
      r(remaining);
    } else {
      lineQueue.push(remaining);
    }
  }
  if (waitingResolve) {
    const r = waitingResolve;
    waitingResolve = null;
    r(null);
  }
};
stdin.on("end", onEnd);
stdin.on("close", onEnd);

function nextLine(): Promise<string | null> {
  if (lineQueue.length > 0) return Promise.resolve(lineQueue.shift()!);
  if (stdinEnded) return Promise.resolve(null);
  return new Promise((resolve) => (waitingResolve = resolve));
}

async function askText(question: string): Promise<string> {
  stdout.write(question);
  const raw = await nextLine();
  if (raw === null) throw new Error("stdin closed");
  return raw.trim();
}

async function askNumber(question: string): Promise<number> {
  while (true) {
    stdout.write(question);
    const raw = await nextLine();
    if (raw === null) throw new Error("stdin closed");
    const n = parseInt(raw.trim(), 10);
    if (!Number.isNaN(n) && n >= 1) return n;
    log("Please enter a positive integer.");
  }
}

async function resolveApiKey(cliApiKey?: string): Promise<string> {
  if (cliApiKey && cliApiKey.trim()) {
    const key = cliApiKey.trim();
    process.env.E2B_API_KEY = key;
    log("Using E2B API key from CLI argument (saved in memory).");
    return key;
  }

  try {
    const inputKey = await askText("Enter E2B API key (press Enter to use .env): ");
    if (inputKey) {
      process.env.E2B_API_KEY = inputKey;
      log("Using provided E2B API key (saved in memory).");
      return inputKey;
    }

    const envKey = process.env.E2B_API_KEY?.trim();
    if (envKey) {
      log("Using E2B API key from .env / environment.");
      return envKey;
    }

    while (true) {
      const fallbackKey = await askText(
        "E2B API key not found in .env. Paste it here or add it to .env: ",
      );
      if (fallbackKey) {
        process.env.E2B_API_KEY = fallbackKey;
        log("Using provided E2B API key (saved in memory).");
        return fallbackKey;
      }
      log("E2B API key cannot be empty. Please paste your key or add it to .env.");
    }
  } catch (err) {
    const envKey = process.env.E2B_API_KEY?.trim();
    if (envKey) {
      log("Using E2B API key from .env / environment.");
      return envKey;
    }
    throw err;
  }
}

async function exitSoon(code: number) {
  await new Promise((r) => setTimeout(r, 150)); // let stdout drain
  process.exit(code);
}

// ---------------------------------------------------------------------------
// sandbox worker
// ---------------------------------------------------------------------------

const activeSandboxes = new Set<Sandbox>();

interface ExecOpts {
  quiet?: boolean; // hide output, just show "✔ installed"
  label?: string; // name shown for quiet steps
}

async function exec(
  sbx: Sandbox,
  tag: string,
  color: string,
  cmd: string,
  timeoutMs: number,
  opts: ExecOpts = {},
) {
  const { quiet = false, label } = opts;
  if (!quiet) log(`${tag} ${DIM}$ ${cmd}${RESET}`);

  const out: string[] = [];
  const res = await sbx.commands.run(cmd, {
    timeoutMs,
    onStdout: (d) => {
      if (quiet) out.push(d);
      else d.split("\n").forEach((l) => l.trim() && log(`${tag} ${DIM}|${RESET} ${l}`));
    },
    onStderr: (d) => {
      if (quiet) out.push(d);
      else d.split("\n").forEach((l) => l.trim() && log(`${tag} ${RED}!${RESET} ${l}`));
    },
  });

  if (res.exitCode !== 0) {
    // on failure show what went wrong
    out.join("").split("\n").slice(-25).filter((l) => l.trim())
      .forEach((l) => logErr(`${tag} ${RED}| ${l}${RESET}`));
    throw new Error(`exit ${res.exitCode}: ${label ?? cmd}`);
  }

  if (quiet) log(`${tag} ${color}${BOLD}${label ?? "step"} installed ✔${RESET}`);
}

async function runInSandbox(batch: number, index: number): Promise<boolean> {
  const color = takeColor();
  const c = (s: string) => `${color}${s}${RESET}`;
  const tag = c(`[b${batch}-sbx${index}]`);
  let sbx: Sandbox | undefined;
  try {
    setStatus(tag, color, "creating sandbox...");
    sbx = await Sandbox.create({
      timeoutMs: SANDBOX_TIMEOUT_MS,
      apiKey: process.env.E2B_API_KEY,
    });
    activeSandboxes.add(sbx);

    // real IP address of the sandbox (public IP), in its own color
    setStatus(tag, color, "getting ip...");
    const ipRes = await sbx.commands.run(
      "curl -s --max-time 10 https://api.ipify.org || hostname -I",
      { timeoutMs: 20_000 },
    );
    const ip = ipRes.stdout.trim().split("\n")[0]?.trim() ?? "unknown";

    log(`${tag} ${GREEN}STARTED${RESET} id=${sbx.sandboxId} ip=${c(ip)}`);

    setStatus(tag, color, "installing bun...");
    await exec(sbx, tag, color, INSTALL_BUN_CMD, 5 * 60_000, { quiet: true, label: "bun" });

    setStatus(tag, color, "installing lovdacn (bun -g)...");
    await exec(sbx, tag, color, BUN_INSTALL_CMD, 5 * 60_000, { quiet: true, label: "lovdacn" });

    setStatus(tag, color, "running lovdacn init (my-app)...");
    await exec(sbx, tag, color, LOVDACN_INIT_CMD, 15 * 60_000, {
      quiet: true,
      label: "my-app init",
    });

    clearStatus(tag);
    log(`${tag} ${GREEN}${BOLD}DONE ✔${RESET}`);
    return true;
  } catch (err) {
    clearStatus(tag);
    logErr(`${tag} ${RED}${BOLD}FAILED ✖${RESET} ${err instanceof Error ? err.message : err}`);
    return false;
  } finally {
    if (sbx) {
      activeSandboxes.delete(sbx);
      try {
        await sbx.kill();
        log(`${tag} ${DIM}KILLED 🗑${RESET}`);
      } catch {
        /* already gone */
      }
    }
  }
}

async function main() {
  let { batchSize, loops, apiKey } = parseArgs();

  try {
    await resolveApiKey(apiKey);
    if (batchSize === undefined)
      batchSize = await askNumber("How many parallel sandboxes per batch? ");
    if (loops === undefined)
      loops = await askNumber("How many batch loops should run? ");
  } catch (err) {
    if (!process.env.E2B_API_KEY) {
      logErr("\nMissing E2B API key. Please provide it when prompted or in .env.");
    } else {
      logErr("\nNo interactive input. Use: bun run index.ts --batch-size 10 --loops 10");
    }
    process.exitCode = 1;
    return;
  }

  log(
    `Plan: ${loops} batch loop(s) x ${batchSize} parallel sandbox(es), ` +
    `${BATCH_WAIT_MS / 1000}s pause between batches.`,
  );

  for (let batch = 1; batch <= loops; batch++) {
    log(`\n========== BATCH ${batch}: launching ${batchSize} sandbox(es) ==========\n`);
    startSpinner();

    const results = await Promise.all(
      Array.from({ length: batchSize }, (_, i) => runInSandbox(batch, i + 1)),
    );
    stopSpinner();

    const ok = results.filter(Boolean).length;
    log(`\n========== BATCH ${batch} FINISHED: ${ok}/${batchSize} succeeded (all killed) ==========`);

    if (batch < loops) {
      log(`\nWaiting ${(BATCH_WAIT_MS / 1000).toFixed(0)}s before next batch...`);
      await new Promise((r) => setTimeout(r, BATCH_WAIT_MS));
    }
  }

  log("\nAll batches completed ✔");
  await exitSoon(0);
}

process.on("SIGINT", async () => {
  stopSpinner();
  log(`\nSIGINT — killing ${activeSandboxes.size} sandbox(es)...`);
  await Promise.allSettled([...activeSandboxes].map((s) => s.kill()));
  await exitSoon(130);
});

main().catch((err) => {
  stopSpinner();
  logErr("Fatal:");
  logErr(String(err));
  void exitSoon(1);
});
