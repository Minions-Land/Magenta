#!/usr/bin/env python3
"""
Fix internal references in migrated SKILL.md files.
Replace ./filename.md with assets/references/filename.md
"""
import os
import re
from pathlib import Path

SKILLS_ROOT = Path("/Users/mjm/Magenta3/packages/PantheonOS/skills")

def fix_internal_refs(content):
    """Fix relative references to point to assets/references/"""
    # Pattern: [text](./filename.md) or [text](filename.md)
    # Replace with: [text](assets/references/filename.md)

    # Fix ./filename.md
    content = re.sub(
        r'\]\(\./([^/)]+\.md)\)',
        r'](assets/references/\1)',
        content
    )

    # Fix plain filename.md (not starting with ../)
    content = re.sub(
        r'\]\((?!\.\./)(?!assets/)(?!http)([^/)]+\.md)\)',
        r'](assets/references/\1)',
        content
    )

    return content

def process_skill_file(skill_file):
    """Process a single SKILL.md file."""
    with open(skill_file, 'r', encoding='utf-8') as f:
        content = f.read()

    original_content = content
    content = fix_internal_refs(content)

    if content != original_content:
        with open(skill_file, 'w', encoding='utf-8') as f:
            f.write(content)
        return True
    return False

def main():
    print("Fixing internal references in SKILL.md files...")
    print()

    fixed_count = 0
    for skill_dir in sorted(SKILLS_ROOT.iterdir()):
        if not skill_dir.is_dir():
            continue

        skill_file = skill_dir / "SKILL.md"
        if not skill_file.exists():
            continue

        if process_skill_file(skill_file):
            print(f"✓ Fixed {skill_dir.name}/SKILL.md")
            fixed_count += 1
        else:
            print(f"  {skill_dir.name}/SKILL.md (no changes needed)")

    print()
    print(f"✅ Fixed {fixed_count} files")

if __name__ == "__main__":
    main()
