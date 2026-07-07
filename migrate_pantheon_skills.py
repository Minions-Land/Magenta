#!/usr/bin/env python3
"""
Migrate PantheonOS skills to Magenta3 package structure.
"""
import os
import re
import yaml
from pathlib import Path
import shutil

SOURCE_ROOT = Path("/Users/mjm/BioAgent/PantheonOS-main/pantheon/factory/templates/skills")
TARGET_ROOT = Path("/Users/mjm/Magenta3/packages/PantheonOS/skills")

# Mapping: source_path -> (target_name, has_subdocs)
SKILL_MAP = {
    "omics/SKILL.md": ("omics", False),
    "omics/single_cell": ("single-cell", True),
    "omics/spatial": ("spatial", True),
    "omics/scfm": ("scfm", True),
    "omics/database_access": ("database-access", True),
    "omics/gene_panel_selection": ("gene-panel", True),
    "omics/general_data_analysis": ("data-analysis", True),
    "omics/sc_best_practices": ("sc-best-practices", True),
    "omics/upstream_processing": ("upstream", True),
    "omics/upstream_processing/nfcore": ("nfcore", True),
    "omics/upstream_processing/openst": ("openst", True),
    "bio_image_processing/SKILL.md": ("bio-imaging", False),
    "bio_image_processing/segmentation": ("cell-segmentation", True),
    "paper_writing": ("paper-writing", True),
    "figure_styling": ("figure-styling", True),
    "presentation": ("presentation", True),
}

def flatten_yaml_multiline(description):
    """Convert YAML multiline string to single line."""
    if isinstance(description, str):
        # Remove leading/trailing whitespace and collapse multiple spaces
        return ' '.join(description.strip().split())
    return description

def transform_frontmatter(frontmatter):
    """Transform PantheonOS frontmatter to Magenta package format."""
    # Extract original fields
    original_name = frontmatter.get('name', frontmatter.get('id', ''))
    description = frontmatter.get('description', '')
    tags = frontmatter.get('tags', [])

    # Flatten description
    description = flatten_yaml_multiline(description)

    # Create new frontmatter
    new_frontmatter = {
        'name': '',  # Will be set by caller
        'description': description,
        'tags': tags if tags else [],
        'source': 'PantheonOS',
        'license': 'BSD-2-Clause'
    }

    return new_frontmatter

def update_cross_references(content, source_path):
    """Update internal cross-references to match new structure."""
    # Convert relative paths like ./spatial/SKILL.md to ../spatial/SKILL.md
    content = re.sub(r'\]\(\./([^/]+)/SKILL\.md\)', r'](../\1/SKILL.md)', content)

    # Convert ../sc_best_practices/SKILL.md to ../sc-best-practices/SKILL.md
    content = content.replace('sc_best_practices', 'sc-best-practices')
    content = content.replace('database_access', 'database-access')
    content = content.replace('gene_panel_selection', 'gene-panel')
    content = content.replace('general_data_analysis', 'data-analysis')
    content = content.replace('upstream_processing', 'upstream')
    content = content.replace('bio_image_processing', 'bio-imaging')
    content = content.replace('paper_writing', 'paper-writing')
    content = content.replace('figure_styling', 'figure-styling')
    content = content.replace('single_cell', 'single-cell')

    return content

def process_skill_file(source_file, target_name):
    """Process a single SKILL.md file."""
    with open(source_file, 'r', encoding='utf-8') as f:
        content = f.read()

    # Split frontmatter and body
    parts = content.split('---', 2)
    if len(parts) < 3:
        print(f"Warning: No frontmatter in {source_file}")
        return content

    frontmatter_text = parts[1]
    body = parts[2]

    # Parse frontmatter
    try:
        frontmatter = yaml.safe_load(frontmatter_text)
    except yaml.YAMLError as e:
        print(f"Warning: YAML parse error in {source_file}: {e}")
        return content

    # Transform frontmatter
    new_frontmatter = transform_frontmatter(frontmatter)
    new_frontmatter['name'] = target_name

    # Update cross-references in body
    body = update_cross_references(body, source_file)

    # Reconstruct file
    new_content = "---\n"
    new_content += yaml.dump(new_frontmatter, allow_unicode=True, sort_keys=False)
    new_content += "---"
    new_content += body

    return new_content

def migrate_skill(source_path, target_name, has_subdocs):
    """Migrate a single skill."""
    source_dir = SOURCE_ROOT / source_path
    target_dir = TARGET_ROOT / target_name

    # Determine source SKILL.md location
    if source_path.endswith('.md'):
        skill_file = SOURCE_ROOT / source_path
    else:
        skill_file = source_dir / "SKILL.md"

    if not skill_file.exists():
        print(f"Warning: {skill_file} not found")
        return

    # Create target directory
    target_dir.mkdir(parents=True, exist_ok=True)

    # Process and write SKILL.md
    new_content = process_skill_file(skill_file, target_name)
    target_skill = target_dir / "SKILL.md"
    with open(target_skill, 'w', encoding='utf-8') as f:
        f.write(new_content)
    print(f"✓ Created {target_skill}")

    # Copy subdocs if they exist
    if has_subdocs and source_dir.is_dir():
        assets_dir = target_dir / "assets" / "references"
        assets_dir.mkdir(parents=True, exist_ok=True)

        for item in source_dir.iterdir():
            if item.name == "SKILL.md":
                continue

            target_path = assets_dir / item.name
            if item.is_file():
                shutil.copy2(item, target_path)
                print(f"  ✓ Copied {item.name} to assets/references/")
            elif item.is_dir():
                shutil.copytree(item, target_path, dirs_exist_ok=True)
                print(f"  ✓ Copied directory {item.name}/ to assets/references/")

def main():
    print("Starting PantheonOS skills migration...")
    print(f"Source: {SOURCE_ROOT}")
    print(f"Target: {TARGET_ROOT}")
    print()

    for source_path, (target_name, has_subdocs) in SKILL_MAP.items():
        print(f"Migrating: {source_path} -> {target_name}")
        migrate_skill(source_path, target_name, has_subdocs)
        print()

    print("✅ Migration complete!")
    print(f"Total skills migrated: {len(SKILL_MAP)}")

if __name__ == "__main__":
    main()
