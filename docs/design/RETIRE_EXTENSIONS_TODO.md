# Extension Migration Status

**Last Updated:** 2026-07-03

## ✅ Completed (2/7)

### 1. todo → `harness/tools/todo/`
**Status:** ✅ DONE (Commits: 326e2e0, 806c203)  
**Type:** Tool migration  
**Effort:** 1.5 hours  
**Outcome:** Clean HCP tool with 11 unit tests, proper branching support

### 2. local-credential-bridge → Deleted
**Status:** ✅ DONE (Commit: f583ef6)  
**Type:** Redundant code removal  
**Effort:** 30 minutes  
**Outcome:** Removed duplicate of existing `external-auth-loader.ts`

---

## 🔄 Planned Migrations (3/7)

### 3. ui-optimize → Core UI System
**Status:** 🔄 TODO  
**Priority:** P1 (High impact)  
**Effort:** 1-2 days  
**Target:** `pi/coding-agent/src/core/` + `pi/tui/src/`  
**Why:** UI optimization should be built-in, not optional

### 4. command-aliases → Core Editor + Commands  
**Status:** 🔄 TODO  
**Priority:** P2 (Simple UX)  
**Effort:** 0.5 day  
**Target:** `interactive-mode.ts` + `pi/tui/src/editor/`  
**Why:** Basic command aliases should be core functionality

### 5. background-events → `harness/tools/`
**Status:** 🔄 TODO  
**Priority:** P3 (Complex but valuable)  
**Effort:** 2-3 days  
**Target:** `harness/tools/bg_shell/` + `harness/tools/sub_agent/`  
**Why:** These are real tools that agents use frequently

---

## ⏸️ Deferred (2/7)

### 6. side-chat → Keep for Now
**Status:** ⏸️ DEFERRED  
**Priority:** P4 (Nice to have)  
**Effort:** 1 day  
**Why:** Complex UI feature, lower priority, can migrate later

### 7. ssh → Keep as Extension
**Status:** ⏸️ KEEP AS EXTENSION  
**Priority:** P7 (Optional)  
**Effort:** 0 (no migration)  
**Why:** 
- Advanced/niche use case
- Already well-implemented
- Requires specific setup
- Migration cost exceeds benefit

---

## Strategy Change

**Original Plan:** Migrate all 7 extensions to HCP  
**Revised Plan:** Pragmatic approach

1. ✅ **Migrate simple tools** (todo) → HCP components
2. ✅ **Remove redundancy** (local-credential-bridge) → Delete
3. 🔄 **Integrate core features** (ui-optimize, command-aliases) → Core codebase
4. 🔄 **Migrate valuable tools** (background-events) → HCP components
5. ⏸️ **Keep optional features** (ssh) → Stable extensions

**Why the change?**
- Most "extensions" are UI/UX features, not tools
- Some features should be core, not optional
- Some advanced features work better as extensions
- Pragmatic > dogmatic

---

## Next Actions

1. **Immediate:** Commit current progress documentation
2. **This Week:** Start ui-optimize migration (P1)
3. **Next Week:** Migrate command-aliases (P2)
4. **Next 2-3 Weeks:** Migrate background-events (P3)
5. **Future:** Revisit side-chat migration

---

## Metrics

- **Completed:** 2/7 (29%)
- **Planned:** 3/7 (43%)
- **Deferred:** 2/7 (29%)
- **Total Effort Spent:** ~2 hours
- **Total Effort Estimated:** 4-6 more days

---

## Related Docs

- [extension-migration-progress.md](./extension-migration-progress.md) - Detailed analysis
- [extension-migration-roadmap.md](./extension-migration-roadmap.md) - Strategy & timeline
- [retire-extensions-plan.md](./retire-extensions-plan.md) - Original plan
- [hcp-extension-migration.md](./hcp-extension-migration.md) - Technical patterns
