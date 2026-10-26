import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { safeText, type BrowserSnapshot } from "./backend.ts";
import { privateResult, snapshotResult } from "./tool.ts";
import type { Inspections } from "../ui/inspection.ts";

const InspectionParams = Type.Object({ url: Type.Optional(Type.String({ description: "HTTP(S) URL to inspect, including localhost. Omit to use the current page." })) });
type InspectionDetails = (Omit<BrowserSnapshot, "png"> & { clicks: number; dream?: { canceled: boolean; changes: number } }) | { private: true };

export function createInspectionTool(inspections: Inspections) {
  return defineTool<typeof InspectionParams, InspectionDetails>({
    name: "browser_inspect",
    label: "Browser inspection",
    description: "Open an interactive browser inspection for the user to click around in. Optional HTTP(S) URL; omit to inspect the current page. Requires fullscreen interactive Pi and terminal image support. Pauses the agent until the user presses Esc or Done, then returns the last captured screenshot and successful click count. User clicks, wheel scrolling, typing, paste, and editing keys change the same browser state used by the browser tool. Click a field to focus it; Tab changes focus and Enter can submit forms. Ctrl+R captures a fresh screenshot; Esc/Ctrl+Q/Done end inspection. Shift+D outside text fields while idle or the Dream toolbar button transfers the authenticated session into Dream; exiting Dream saves a visual goal. The Private toolbar toggle (Ctrl+Shift+P) keeps captures local-only, blocks ordinary agent browser actions, and suppresses goal saving/logging; turn it off deliberately to share the current page. Password controls are masked/omitted regardless. This is inspection, not an approval signal. No dragging or live video yet.",
    promptSnippet: "Let the user click, scroll, and type in a browser inspection; wait until they finish.",
    promptGuidelines: [
      "When the user asks to inspect a website or try clicking a feature in Pi, use browser_inspect. For agent-only browsing or static screenshots, use browser instead.",
      "Tell the user inspection pauses the agent; they can click, scroll, and type in the page, then press Esc or Done to return control. Finishing an inspection is not approval of task completion.",
    ],
    parameters: InspectionParams,
    exposure: "model-only",
    executionMode: "sequential",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async execute(_id, params, signal, _update, ctx) {
      const inspection = await inspections.open(ctx, params.url, signal);
      if (inspection.snapshot.private) return privateResult();
      const prefix = inspection.dream
        ? `Inspection transferred to Dream. ${inspection.dream.canceled ? "Dream canceled; no goal saved." : "Dream goal saved and published as a visual reference."} This is not approval or a request to implement it.\n`
        : `Inspection ended. ${inspection.clicks} successful user click(s). This is the last captured page, not an approval signal.\n`;
      const result = snapshotResult(inspection.snapshot, prefix);
      return { ...result, details: { ...result.details, clicks: inspection.clicks,
        ...(inspection.dream ? { dream: { canceled: inspection.dream.canceled, changes: inspection.dream.state.changes.length } } : {}),
      } };
    },
    renderCall(_args, theme) { return new Text(theme.fg("toolTitle", theme.bold("Browser inspection")), 0, 0); },
    renderResult(result, _options, theme) {
      if (!result.details) return new Text(result.content.filter((item) => item.type === "text").map((item) => safeText(item.text)).join("\n"), 0, 0);
      if (!("url" in result.details)) return new Text(theme.fg("muted", "Private inspection ended; page output withheld."), 0, 0);
      return new Text(theme.fg("toolOutput", safeText(`${result.details.dream ? (result.details.dream.canceled ? "Dream canceled" : `Dream goal saved · ${result.details.dream.changes} change(s)`) : `Inspection ended · ${result.details.clicks} click(s)`}\n${result.details.url}\n${result.details.screenshotPath}`)), 0, 0);
    },
  });
}
