/**
 * MCP (Model Context Protocol) management overlay
 * 
 * Displays and manages MCP server connections
 */

import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

interface McpServer {
	id: string;
	name: string;
	command: string;
	status: "connected" | "disconnected" | "error";
	tools?: number;
	resources?: number;
	prompts?: number;
}

export class McpOverlayComponent extends Container {
	private servers: McpServer[] = [];
	private selectedIndex = 0;
	private listContainer: Container;
	private onSelectCallback: (serverId: string) => void;
	private onCancelCallback: () => void;

	constructor(onSelect: (serverId: string) => void, onCancel: () => void) {
		super();

		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		// TODO: Load servers from config/state
		this.loadServers();

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("  MCP Server Management")), 1, 0));
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.updateList();

		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0
			)
		);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(theme.fg("muted", "  Note: MCP server management is under development"), 1, 0)
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	private loadServers(): void {
		// Placeholder - will be replaced with actual server registry
		this.servers = [
			{
				id: "example-1",
				name: "Example Server",
				command: "node example-server.js",
				status: "disconnected",
				tools: 0,
				resources: 0,
				prompts: 0,
			},
		];
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.servers.length === 0) {
			this.listContainer.addChild(
				new Text(theme.fg("muted", "  No MCP servers configured"), 1, 0)
			);
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(
				new Text(theme.fg("muted", "  Add servers in ~/.pi/agent/mcp-servers.json"), 1, 0)
			);
		} else {
			for (let i = 0; i < this.servers.length; i++) {
				const server = this.servers[i];
				const isSelected = i === this.selectedIndex;

				// Status icon
				let statusIcon = "";
				let statusColor = theme.fg("muted", "");
				switch (server.status) {
					case "connected":
						statusIcon = "●";
						statusColor = theme.fg("success", statusIcon);
						break;
					case "disconnected":
						statusIcon = "○";
						statusColor = theme.fg("muted", statusIcon);
						break;
					case "error":
						statusIcon = "✖";
						statusColor = theme.fg("error", statusIcon);
						break;
				}

				// Format line
				const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
				const name = isSelected ? theme.fg("accent", server.name) : theme.fg("text", server.name);
				const stats =
					server.status === "connected"
						? theme.fg(
								"muted",
								` (${server.tools || 0} tools, ${server.resources || 0} resources, ${server.prompts || 0} prompts)`
						  )
						: "";

				this.listContainer.addChild(
					new Text(`${prefix}${statusColor} ${name}${stats}`, 1, 0)
				);

				// Show command on selected
				if (isSelected) {
					this.listContainer.addChild(
						new Text(theme.fg("muted", `    ${server.command}`), 1, 0)
					);
				}
			}
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();

		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.servers.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			if (this.servers.length > 0) {
				this.onSelectCallback(this.servers[this.selectedIndex].id);
			}
		} else if (kb.matches(keyData, "tui.select.cancel") || kb.matches(keyData, "app.interrupt")) {
			this.onCancelCallback();
		}
	}
}

/**
 * Factory function to create MCP overlay
 */
export function createMcpOverlay(onSelect: (serverId: string) => void, onCancel: () => void): McpOverlayComponent {
	return new McpOverlayComponent(onSelect, onCancel);
}
