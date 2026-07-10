export type PackageToolDiagnosticCode =
	| "package_tool_descriptor_missing"
	| "package_tool_descriptor_read_failed"
	| "package_tool_descriptor_invalid"
	| "package_tool_environment_missing"
	| "package_tool_sandbox_missing"
	| "package_tool_runtime_missing"
	| "package_tool_runtime_unsupported";

export type PackageToolDiagnostic = {
	type: "warning" | "error";
	code: PackageToolDiagnosticCode;
	message: string;
	path?: string;
	packageId?: string;
	profile?: string;
};
