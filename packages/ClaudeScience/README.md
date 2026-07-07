# ClaudeScience Package

Computational biology and bioinformatics harness package for Magenta, covering protein structure prediction, genomics, single-cell analysis, literature review, and scientific workflows.

## Package Structure

ClaudeScience is organized into **domain-specific profiles** for selective loading:

### Available Profiles

| Profile | Description | Skills |
|---------|-------------|--------|
| `structure` | Protein structure prediction | AlphaFold2, ESMFold2, Chai-1, Boltz, OpenFold3 |
| `design` | Protein design | ProteinMPNN, LigandMPNN, SolubleMP NN |
| `genomics` | Genomics & molecular biology | DiffDock, Borzoi, Evo2, ESM-2 |
| `singlecell` | Single-cell analysis | scvi-tools, scGPT |
| `research` | Literature & research workflows | Literature review, PDF explore, Paper narrative, Indication dossier |
| `visualization` | Figure composition | Figure composer, Figure style, Algorithmic art, Web artifacts |
| `compute` | Infrastructure & compute | Remote SSH, Modal, Env setup, Model endpoints |
| `meta` | Self-improvement | Skill creator, Learn, Self-awareness, Customize |
| `all` | All skills (extends all profiles above) | All 32 skills |

## Usage

### Load Specific Profiles

```bash
# Load only structure prediction skills
magenta --package ClaudeScience:structure

# Load multiple profiles
magenta --package ClaudeScience:structure,design,research

# Load all skills
magenta --package ClaudeScience:all
```

### Profile Inheritance

Profiles can extend other profiles. For example, the `all` profile extends all other profiles:

```toml
[[profiles]]
name = "all"
description = "All ClaudeScience skills"
extends = ["structure", "design", "genomics", "singlecell", "research", "visualization", "compute", "meta"]
```

### Default Behavior

By default, **no skills are auto-loaded** (`default_profiles = []`). This is intentional because:
- ClaudeScience has 32 skills across diverse domains
- Loading all skills would add unnecessary context
- Users should explicitly select needed profiles

### Component Naming Convention

Components follow a namespace pattern: `<profile>-<skill-name>`

Examples:
- `structure-alphafold2` - AlphaFold2 in structure profile
- `design-proteinmpnn` - ProteinMPNN in design profile
- `research-literature-review` - Literature review in research profile

This allows:
- Clear organization by domain
- No naming conflicts
- Easy filtering and selection

## Multi-Layer Loading

ClaudeScience supports **multi-layer selective loading** through profiles:

### Example 1: Research Workflow

```bash
# Load only research and visualization skills
magenta --package ClaudeScience:research,visualization

# This loads:
# - research-literature-review
# - research-pdf-explore
# - research-paper-narrative
# - research-indication-dossier
# - viz-figure-composer
# - viz-figure-style
# - viz-algorithmic-art
# - viz-web-artifacts
```

### Example 2: Protein Engineering

```bash
# Load structure prediction and design skills
magenta --package ClaudeScience:structure,design

# This loads:
# - structure-alphafold2
# - structure-esmfold2
# - structure-chai1
# - structure-boltz
# - structure-openfold3
# - design-proteinmpnn
# - design-ligandmpnn
# - design-solublempnn
```

### Example 3: Computational Biology Full Stack

```bash
# Load comprehensive set
magenta --package ClaudeScience:structure,design,genomics,singlecell,compute

# Or simply use the 'all' profile
magenta --package ClaudeScience:all
```

## Extending ClaudeScience

### Adding New Skills

1. Create skill directory under `skills/`
2. Add `SKILL.md` with proper frontmatter
3. Add component entry to `package.toml`:

```toml
[[components]]
kind = "skill"
name = "profile-skillname"
path = "skills/skillname"
description = "Brief description"
include_in_context = false
profiles = ["profile"]
```

### Creating Sub-Categories

You can create sub-profiles that extend other profiles:

```toml
[[profiles]]
name = "af-suite"
description = "AlphaFold family models"
extends = ["structure"]
harness = "profiles/af-suite.toml"
```

Then create `profiles/af-suite.toml` to filter specific components.

### Best Practices

1. **Granular Profiles**: Keep profiles focused on specific domains
2. **Clear Naming**: Use `<profile>-<skill>` naming for components
3. **Sparse Defaults**: Keep `default_profiles` empty or minimal
4. **Profile Composition**: Use `extends` to compose larger profiles from smaller ones
5. **Documentation**: Document each profile's purpose and included skills

## Architecture Notes

### Why Not Nested Packages?

ClaudeScience uses **flat structure with profiles** instead of nested sub-packages because:

1. **Compatibility**: Works with existing Magenta harness architecture
2. **Simplicity**: No need to modify core package discovery logic
3. **Flexibility**: Profiles provide more granular control than nested packages
4. **Performance**: Single-pass loading, no recursive traversal
5. **Composability**: Easy to combine profiles from same or different packages

### Profile vs Sub-Package

| Feature | Profile (Current) | Sub-Package (Alternative) |
|---------|-------------------|---------------------------|
| Selection | `:profile1,profile2` | Separate package entries |
| Inheritance | `extends = [...]` | Not supported |
| Loading | Single pass | Recursive |
| Discovery | Built-in | Requires modification |
| Composition | Flexible | Rigid |

## Migration from Legacy Structure

If you have an old ClaudeScience structure, migrate as follows:

```bash
# Old: Direct skill loading
--skill ~/.claude/skills/alphafold2

# New: Profile-based loading
--package ClaudeScience:structure
```

Benefits:
- Centralized management
- Version control
- Profile-based organization
- Consistent naming

## Testing

```bash
# Verify package structure
cd harness
npm test -- test/package-overlay.test.ts

# Check discovered packages
node -e "
const { discoverHarnessPackages } = require('./dist/hcp-client/overlay/package-overlay.js');
discoverHarnessPackages().then(r => {
  const cs = r.packages.find(p => p.id === 'ClaudeScience');
  console.log('Profiles:', cs.manifest.profiles.map(p => p.name));
});
"
```

## License

See individual skill licenses in their respective SKILL.md files.
