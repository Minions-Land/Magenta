// Local UI polish extension.
// - Markdown rendering polish.
// - Aggregated tool-call display while collapsed.
// - Compact image paste tokens such as [image1].

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createImageIntegration } from "./images.ts";
import { installMarkdownPatch } from "./markdown.ts";
import { installToolExecutionGroupingPatch } from "./tool-groups.ts";

export default async function uiOptimize(pi: ExtensionAPI) {
  installMarkdownPatch();
  await installToolExecutionGroupingPatch();

  const images = createImageIntegration();

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setToolsExpanded(false);

    images.clear();
    ctx.ui.setEditorComponent(images.createEditorFactory(ctx));
  });

  pi.on("agent_start", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setToolsExpanded(false);
  });

  pi.on("session_shutdown", () => {
    images.clear();
  });

  pi.on("input", async (event) => {
    const result = images.transformInput(event.text);
    if (result.action === "continue") return result;
    return { action: "transform", text: result.text, images: event.images };
  });
}
