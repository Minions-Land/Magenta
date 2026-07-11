/**
 * Cross-runtime SQLite adapter.
 * Supports both Node.js (node:sqlite) and Bun (bun:sqlite).
 */

// Detect runtime and import appropriate SQLite implementation
let DatabaseSync: any;

if (typeof (globalThis as any).Bun !== "undefined") {
	// Bun runtime - use bun:sqlite
	// @ts-ignore - Bun-specific import
	const { Database } = await import("bun:sqlite");
	
	// Adapt Bun's Database to match Node.js DatabaseSync interface
	DatabaseSync = class BunDatabaseAdapter {
		private db: any;
		
		constructor(path: string, options?: { open?: boolean }) {
			this.db = new Database(path, { create: options?.open !== false });
		}
		
		prepare(sql: string) {
			const stmt = this.db.prepare(sql);
			return {
				run: (...params: any[]) => stmt.run(...params),
				get: (...params: any[]) => stmt.get(...params),
				all: (...params: any[]) => stmt.all(...params),
			};
		}
		
		exec(sql: string) {
			return this.db.exec(sql);
		}
		
		close() {
			return this.db.close();
		}
	};
} else {
	// Node.js runtime - use node:sqlite
	const nodeSqlite = await import("node:sqlite");
	DatabaseSync = nodeSqlite.DatabaseSync;
}

export { DatabaseSync };
export type DatabaseSyncType = typeof DatabaseSync;
