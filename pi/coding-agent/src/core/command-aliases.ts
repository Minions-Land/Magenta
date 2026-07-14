export function applyCommandAlias(text: string): string {
	const trimmed = text.trim();
	if (trimmed === "exit" || trimmed === "quit") return "/quit";
	if (trimmed === "clear" || trimmed === "/clear") return "/new";
	return text;
}
