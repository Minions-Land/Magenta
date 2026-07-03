# Extension Migration Roadmap

## Executive Summary

**Completed:** 2/7 extensions (29%)  
**Strategy Change:** From "migrate all" to "migrate what makes sense, keep what works"

The initial plan to migrate all PI Extensions to HCP components revealed that most extensions are **UI/runtime features**, not tools. A more pragmatic approach:

1. ✅ **Migrate simple tools** → HCP components (e.g., todo)
2. ✅ **Remove redundant code** → Delete duplicates (e.g., local-credential-bridge)
3. 🔄 **Refactor complex features** → Integrate into core (e.g., ui-optimize)
4. ⏸️ **Keep optional advanced features** → Leave as extensions (e.g., ssh)

---

## Phase 1: Simple Migrations (DONE)

### ✅ todo → `harness/tools/todo/`
- **Effort:** 1.5 hours
- **Result:** Clean HCP tool with tests
- **Benefit:** Proper branching support, clear architecture

### ✅ local-credential-bridge → Deleted
- **Effort:** 30 minutes
- **Result:** Removed redundant code
- **Benefit:** Less code to maintain, existing implementation is better

---

## Phase 2: Core UI Features (TODO)

These should be integrated into the core codebase, not remain as "extensions":

### 🔄 ui-optimize → Core Message/UI System
**Priority:** P1 (High impact, widely used)  
**Target:** `pi/coding-agent/src/core/` and `pi/tui/src/`  
**Effort:** 1-2 days  

**Why:** UI optimization affects every user, every session. Should be built-in.

**Plan:**
1. Image token compression → `pi/coding-agent/src/core/messages.ts`
2. Tool grouping → `pi/tui/src/components/tool-display.ts`
3. Markdown truncation → `pi/tui/src/components/markdown.ts`
4. Make all optimizations configurable via settings

### 🔄 command-aliases → Core Editor + Commands
**Priority:** P2 (Simple, but touches core)  
**Target:** `pi/coding-agent/src/modes/interactive/` and `pi/tui/src/editor/`  
**Effort:** 0.5 day  

**Why:** Command aliases are basic UX, not an "extension".

**Plan:**
1. Command aliases (`exit` → `/quit`) → Add to `interactive-mode.ts` onSubmit
2. Autocomplete behavior (Enter = Tab) → Add to `pi/tui` Editor component
3. Remove EditorComponentWrapper pattern

---

## Phase 3: Feature Tools (TODO)

Complex tools that provide real functionality:

### 🔄 background-events → `harness/tools/`
**Priority:** P3 (Complex but valuable)  
**Target:** `harness/tools/bg_shell/` and `harness/tools/sub_agent/`  
**Effort:** 2-3 days  

**Why:** bg_shell and sub_agent are actual tools that agents use.

**Plan:**
1. Split into two separate tools
2. Move event management to harness event bus
3. Keep UI in pi/tui, remove from extension
4. Write comprehensive tests
5. Document usage

### 🔄 side-chat → Core Feature
**Priority:** P4 (Nice to have)  
**Target:** `pi/coding-agent/src/modes/interactive/commands/`  
**Effort:** 1 day  

**Why:** side-chat is a useful feature, but not critical.

**Plan:**
1. Move command handler to core commands
2. Move UI component to pi/tui
3. Integrate tool tracking into session state

---

## Phase 4: Optional Features (KEEP AS EXTENSIONS)

These are advanced/optional features used by few users:

### ⏸️ ssh → Keep as Extension
**Priority:** P7 (Optional)  
**Effort:** 0 (no migration)  

**Why:** 
- Used by very few users
- Already well-implemented
- Requires specific setup (SSH keys, remote access)
- Migration would take 1-2 days for minimal benefit

**Recommendation:** Mark as "stable extension", document well, keep maintained.

---

## Revised Timeline

### Immediate (This Week)
- ✅ todo migration (DONE)
- ✅ local-credential-bridge removal (DONE)
- 📝 Create migration documentation (IN PROGRESS)
- 📝 Update RETIRE_EXTENSIONS_TODO.md

### Near-term (Next 2-4 Weeks)
1. **ui-optimize → Core** (P1, 1-2 days)
   - Most user-facing impact
   - Clean up message rendering pipeline
   
2. **command-aliases → Core** (P2, 0.5 day)
   - Simple integration
   - Improves UX baseline

3. **background-events → Tools** (P3, 2-3 days)
   - Most complex migration
   - High value for power users

### Long-term (1-2 Months)
4. **side-chat → Core** (P4, 1 day)
   - Nice to have
   - Lower priority

5. **ssh → Keep** (P7, 0 days)
   - Document as stable extension
   - No migration needed

---

## Success Criteria

### Code Quality
- ✅ All migrated code has unit tests
- ✅ No functionality regression
- ✅ Clearer separation of concerns

### Architecture
- ✅ Tools are HCP components
- ✅ UI features are in pi/tui or pi/coding-agent core
- ✅ No "extension magic", everything explicit

### Developer Experience
- ✅ Easier to understand codebase
- ✅ Clear boundaries between layers
- ✅ Better discoverability

### User Experience
- ✅ No visible changes (backward compatible)
- ✅ All features work as before
- ✅ Better performance (optional optimizations)

---

## Lessons Learned

1. **Not everything should be migrated**
   - Extensions served a purpose (experimentation, optional features)
   - Some should become core features
   - Some should stay as extensions

2. **Complexity varies widely**
   - Simple tools (todo): 1-2 hours
   - UI systems (ui-optimize): 1-2 days
   - Runtime adapters (ssh): Better left alone

3. **Architecture matters**
   - HCP model works great for tools
   - UI features need different approach
   - Runtime adapters are special cases

4. **Pragmatic > Perfect**
   - Don't force migrations that don't make sense
   - Focus on high-impact improvements
   - Document and maintain what stays

---

## Next Steps

1. **Commit this documentation**
2. **Update retire-extensions-plan.md** with new strategy
3. **Start Phase 2: ui-optimize migration**
4. **Review and prioritize with team**

---

## Related Documents

- [retire-extensions-plan.md](./retire-extensions-plan.md) - Original plan
- [RETIRE_EXTENSIONS_TODO.md](./RETIRE_EXTENSIONS_TODO.md) - Task checklist
- [extension-migration-progress.md](./extension-migration-progress.md) - Detailed status
- [hcp-extension-migration.md](./hcp-extension-migration.md) - Technical approach
