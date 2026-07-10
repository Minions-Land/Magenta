import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";

export type NativeToolSpec<TParameters extends TSchema = TSchema, TDetails = any> = {
	name: string;
	label?: string;
	description: string;
	parameters: TParameters;
	createExecute: (cwd: string) => AgentTool<TParameters, TDetails>["execute"];
	renderKind?: string;
};

export function createNativeTool<TParameters extends TSchema = TSchema, TDetails = any>(
	spec: NativeToolSpec<TParameters, TDetails>,
	cwd: string,
): AgentTool<TParameters, TDetails> {
	return {
		name: spec.name,
		label: spec.label ?? spec.name,
		description: spec.description,
		parameters: spec.parameters,
		execute: spec.createExecute(cwd),
		renderKind: spec.renderKind,
	};
}
