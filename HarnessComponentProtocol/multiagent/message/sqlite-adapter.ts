/**
 * Cross-runtime SQLite adapter.
 * Supports both Node.js (node:sqlite) and Bun (bun:sqlite).
 */

import { createRequire } from "node:module";

// Synchronous loading matters for compiled binaries that dynamically import the
// hidden peer helper: an exported mutable binding behind top-level await can be
// observed before Bun has assigned it.
const runtimeRequire = createRequire(import.meta.url);
let DatabaseSync: any;

if (typeof (globalThis as any).Bun !== "undefined") {
	const { Database } = runtimeRequire("bun:sqlite") as { Database: new (...args: any[]) => any };

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
	const nodeSqlite = runtimeRequire("node:sqlite") as { DatabaseSync: new (...args: any[]) => any };
	DatabaseSync = nodeSqlite.DatabaseSync;
}

export { DatabaseSync };
export type DatabaseSyncType = typeof DatabaseSync;
