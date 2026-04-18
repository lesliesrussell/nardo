/**
 * nardo extension for pi-coding-agent
 *
 * Install: copy (or symlink) to ~/.pi/agent/extensions/nardo.ts
 *
 * Provides:
 *   - Session start: loads nardo wake-up context (L0 + L1 memory)
 *   - Per-turn: searches nardo for relevant context and injects it
 *   - Slash commands:
 *       /nardo:search <query>   — search palace, show results
 *       /nardo:add <text>       — save a drawer to the palace
 *       /nardo:status           — show palace stats
 *       /nardo:wake             — re-run wake-up context
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawnSync } from "node:child_process";

function nardo(args: string[]): { ok: boolean; out: string } {
  const result = spawnSync("nardo", args, { encoding: "utf-8", timeout: 15000 });
  if (result.error) return { ok: false, out: result.error.message };
  const out = (result.stdout ?? "").trim();
  return { ok: result.status === 0, out };
}

export default function (pi: ExtensionAPI) {
  let wakeupContext = "";
  let firstTurn = true;

  pi.on("session_start", async (_event, ctx) => {
    const { ok, out } = nardo(["wake-up", "--token-budget", "600"]);
    if (ok && out) {
      wakeupContext = out;
      ctx.ui.notify("nardo: memory loaded", "info");
    } else {
      ctx.ui.notify("nardo: wake-up failed", "warning");
    }
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    const parts: string[] = [];

    if (firstTurn && wakeupContext) {
      parts.push("## nardo session memory\n\n" + wakeupContext);
      firstTurn = false;
    }

    const prompt = (event as { prompt?: string }).prompt?.trim();
    if (prompt) {
      const { ok, out } = nardo(["search", prompt, "--limit", "3"]);
      if (ok && out) {
        parts.push("## nardo: relevant context\n\n" + out);
      }
    }

    if (parts.length === 0) return;
    return {
      message: {
        customType: "nardo-context",
        content: parts.join("\n\n---\n\n"),
        display: true,
      },
    };
  });

  pi.on("input", async (event, ctx) => {
    if (!event.text.startsWith("/nardo:")) return { action: "continue" };

    const rest = event.text.slice(7).trim();

    if (rest.startsWith("search ")) {
      const query = rest.slice(7).trim();
      const { ok, out } = nardo(["search", query, "--limit", "5"]);
      ctx.ui.notify(ok && out ? out : "No results", "info");
      return { action: "handled" };
    }

    if (rest.startsWith("add ")) {
      const content = rest.slice(4).trim();
      const { ok } = nardo(["add-drawer", "--content", content, "--wing", "agent", "--room", "notes"]);
      ctx.ui.notify(ok ? "nardo: saved" : "nardo: save failed", ok ? "info" : "error");
      return { action: "handled" };
    }

    if (rest === "status") {
      const { ok, out } = nardo(["status"]);
      ctx.ui.notify(ok && out ? out : "nardo: status failed", ok ? "info" : "error");
      return { action: "handled" };
    }

    if (rest === "wake") {
      const { ok, out } = nardo(["wake-up", "--token-budget", "600"]);
      if (ok && out) {
        wakeupContext = out;
        ctx.ui.notify("nardo: memory refreshed", "info");
      } else {
        ctx.ui.notify("nardo: wake-up failed", "warning");
      }
      return { action: "handled" };
    }

    ctx.ui.notify(`unknown: /nardo:${rest}  (search|add|status|wake)`, "warning");
    return { action: "handled" };
  });
}
