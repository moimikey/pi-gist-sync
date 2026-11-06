// Thin glue between Pi's extension API and the testable command layer in src/command.ts.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runCommand, startupCheck, SUBCOMMAND_SUMMARY, SUBCOMMANDS } from "../src/command.ts";
import type { CommandIO } from "../src/command.ts";

const EXEC_TIMEOUT_MS = 15_000;

function makeIO(pi: ExtensionAPI, ctx: ExtensionContext, reload: () => Promise<void>): CommandIO {
  return {
    hasUI: ctx.hasUI,
    notify: (message, level) => ctx.ui.notify(message, level),
    confirm: async (title, message) => (ctx.hasUI ? ctx.ui.confirm(title, message) : false),
    input: async (title, placeholder) => (ctx.hasUI ? ctx.ui.input(title, placeholder) : undefined),
    reload,
    exec: async (cmd, args) => {
      const res = await pi.exec(cmd, args, { timeout: EXEC_TIMEOUT_MS });
      return { stdout: res.stdout, code: res.code };
    },
  };
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("gist-sync", {
    description: "Sync your Pi setup through a secret GitHub Gist (init, status, push, pull, scan, unlink)",
    getArgumentCompletions: (prefix) => {
      if (/\s/.test(prefix.trimStart())) return null;
      const typed = prefix.trim().toLowerCase();
      const items = SUBCOMMANDS.filter((s) => s.startsWith(typed)).map((s) => ({
        value: s,
        label: s,
        description: SUBCOMMAND_SUMMARY[s],
      }));
      return items.length > 0 ? items : null;
    },
    handler: (args, ctx) => runCommand(args, makeIO(pi, ctx, () => ctx.reload())),
  });

  pi.on("session_start", (event, ctx) => {
    // Reloads and session switches would re-query GitHub for no new information.
    if (event.reason !== "startup") return;
    // Detached so a slow or offline GitHub never delays startup; startupCheck never rejects.
    void startupCheck(makeIO(pi, ctx, async () => {}));
  });
}
