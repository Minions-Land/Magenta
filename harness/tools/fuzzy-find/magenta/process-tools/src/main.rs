use anyhow::{anyhow, Context, Result};
use ast_grep_core::{
    matcher::{Pattern, PatternBuilder},
    tree_sitter::{LanguageExt, StrDoc, TSLanguage},
    Language, MatchStrictness,
};
use globset::{GlobBuilder, GlobSetBuilder};
use serde::Deserialize;
use std::{
    borrow::Cow,
    collections::{BTreeMap, BTreeSet, HashMap},
    env, fs,
    hash::Hasher,
    io::{self, Read as IoRead},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use walkdir::WalkDir;

const DEFAULT_MAX_LINES: usize = 2000;
const DEFAULT_WEB_LIMIT: usize = 10;
const MAX_WEB_LIMIT: usize = 20;
const DEFAULT_AST_LIMIT: usize = 50;
const MAX_AST_LIMIT: usize = 200;
const DEFAULT_LSP_LIMIT: usize = 80;
const MAX_LSP_LIMIT: usize = 500;
const MAX_URL_BYTES: u64 = 2 * 1024 * 1024;
const MAX_URL_OUTPUT_CHARS: usize = 80_000;
// ============================================================================
// Tool Input/Output Structures
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct ReadInput {
    file_path: String,
    #[serde(default)]
    offset: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct ReadAnchoredInput {
    file_path: String,
    #[serde(default)]
    offset: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct WriteInput {
    file_path: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct EditInput {
    file_path: String,
    old_string: String,
    new_string: String,
    #[serde(default)]
    replace_all: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct EditHashlineInput {
    file_path: String,
    patch: String,
    #[serde(default)]
    dry_run: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct LsInput {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct GrepInput {
    pattern: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    file_pattern: Option<String>,
    #[serde(default)]
    case_sensitive: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct FindInput {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    pattern: Option<String>,
    #[serde(default)]
    file_type: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct GlobInput {
    path: String,
    pattern: String,
    #[serde(default)]
    file_type: Option<String>,
    #[serde(default)]
    include_hidden: bool,
    #[serde(default)]
    include_node_modules: bool,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct FuzzyFindInput {
    query: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    file_type: Option<String>,
    #[serde(default)]
    include_hidden: bool,
    #[serde(default)]
    include_node_modules: bool,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct AstGrepInput {
    pattern: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    lang: Option<String>,
    #[serde(default)]
    glob: Option<String>,
    #[serde(default)]
    selector: Option<String>,
    #[serde(default)]
    strictness: Option<String>,
    #[serde(default)]
    include_hidden: bool,
    #[serde(default)]
    include_node_modules: bool,
    #[serde(default)]
    include_meta: bool,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    offset: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct AstEditPlanInput {
    file_path: String,
    pattern: String,
    replacement: String,
    #[serde(default)]
    lang: Option<String>,
    #[serde(default)]
    selector: Option<String>,
    #[serde(default)]
    strictness: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct LspInput {
    action: String,
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    line: Option<usize>,
    #[serde(default)]
    symbol: Option<String>,
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    new_name: Option<String>,
    #[serde(default)]
    apply: Option<bool>,
    #[serde(default)]
    timeout: Option<u64>,
    #[serde(default)]
    payload: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct WebSearchInput {
    query: String,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    recency: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct ReadUrlInput {
    url: String,
    #[serde(default)]
    raw: bool,
    #[serde(default)]
    offset: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct BashInput {
    command: String,
    #[serde(default, rename = "timeout")]
    _timeout: Option<u64>,
}

// ============================================================================
// Main Entry Point
// ============================================================================

fn main() -> Result<()> {
    let mut argv = env::args().skip(1);
    match argv.next().as_deref() {
        Some("read") => {
            let input: ReadInput = read_json_stdin()?;
            let output = tool_read(input)?;
            print!("{}", output);
        }
        Some("read-anchored") => {
            let input: ReadAnchoredInput = read_json_stdin()?;
            let output = tool_read_anchored(input)?;
            print!("{}", output);
        }
        Some("write") => {
            let input: WriteInput = read_json_stdin()?;
            let output = tool_write(input)?;
            print!("{}", output);
        }
        Some("edit") => {
            let input: EditInput = read_json_stdin()?;
            let output = tool_edit(input)?;
            print!("{}", output);
        }
        Some("edit-hashline") => {
            let input: EditHashlineInput = read_json_stdin()?;
            let output = tool_edit_hashline(input)?;
            print!("{}", output);
        }
        Some("ls") => {
            let input: LsInput = read_json_stdin()?;
            let output = tool_ls(input)?;
            print!("{}", output);
        }
        Some("grep") => {
            let input: GrepInput = read_json_stdin()?;
            let output = tool_grep(input)?;
            print!("{}", output);
        }
        Some("find") => {
            let input: FindInput = read_json_stdin()?;
            let output = tool_find(input)?;
            print!("{}", output);
        }
        Some("glob") => {
            let input: GlobInput = read_json_stdin()?;
            let output = tool_glob(input)?;
            print!("{}", output);
        }
        Some("fuzzy-find") => {
            let input: FuzzyFindInput = read_json_stdin()?;
            let output = tool_fuzzy_find(input)?;
            print!("{}", output);
        }
        Some("ast-grep") => {
            let input: AstGrepInput = read_json_stdin()?;
            let output = tool_ast_grep(input)?;
            print!("{}", output);
        }
        Some("ast-edit-plan") => {
            let input: AstEditPlanInput = read_json_stdin()?;
            let output = tool_ast_edit_plan(input)?;
            print!("{}", output);
        }
        Some("lsp") => {
            let input: LspInput = read_json_stdin()?;
            let output = tool_lsp(input)?;
            print!("{}", output);
        }
        Some("web-search") => {
            let input: WebSearchInput = read_json_stdin()?;
            let output = tool_web_search(input)?;
            print!("{}", output);
        }
        Some("read-url") => {
            let input: ReadUrlInput = read_json_stdin()?;
            let output = tool_read_url(input)?;
            print!("{}", output);
        }
        Some("bash") => {
            let input: BashInput = read_json_stdin()?;
            let output = tool_bash(input)?;
            print!("{}", output);
        }
        Some("--help") | Some("-h") | None => {
            println!("Magenta Process Tools");
            println!("\nUsage:");
            println!("  magenta-process-tools read < input.json");
            println!("  magenta-process-tools read-anchored < input.json");
            println!("  magenta-process-tools write < input.json");
            println!("  magenta-process-tools edit < input.json");
            println!("  magenta-process-tools edit-hashline < input.json");
            println!("  magenta-process-tools ls < input.json");
            println!("  magenta-process-tools grep < input.json");
            println!("  magenta-process-tools find < input.json");
            println!("  magenta-process-tools glob < input.json");
            println!("  magenta-process-tools fuzzy-find < input.json");
            println!("  magenta-process-tools ast-grep < input.json");
            println!("  magenta-process-tools ast-edit-plan < input.json");
            println!("  magenta-process-tools lsp < input.json");
            println!("  magenta-process-tools web-search < input.json");
            println!("  magenta-process-tools read-url < input.json");
            println!("  magenta-process-tools bash < input.json");
        }
        Some(other) => return Err(anyhow!("unknown command: {}", other)),
    }
    Ok(())
}

fn read_json_stdin<T: for<'de> Deserialize<'de>>() -> Result<T> {
    let mut raw = String::new();
    io::stdin().read_to_string(&mut raw)?;
    if raw.trim().is_empty() {
        return Err(anyhow!("expected JSON input on stdin"));
    }
    serde_json::from_str(&raw).context("failed to parse stdin JSON")
}

// ============================================================================
// Tool Implementations
// ============================================================================

fn tool_read(input: ReadInput) -> Result<String> {
    let path = PathBuf::from(&input.file_path);
    if !path.exists() {
        return Err(anyhow!("File not found: {}", input.file_path));
    }
    let content = fs::read_to_string(&path)
        .with_context(|| format!("Failed to read file: {}", input.file_path))?;
    let lines: Vec<&str> = content.lines().collect();
    let total_lines = lines.len();
    let offset = input.offset.unwrap_or(0);
    let limit = input.limit.unwrap_or(DEFAULT_MAX_LINES);
    if offset >= total_lines {
        return Ok(format!(
            "[File has {} lines, offset {} is out of range]",
            total_lines, offset
        ));
    }
    let end = (offset + limit).min(total_lines);
    let selected_lines = &lines[offset..end];
    let mut output = String::new();
    for (idx, line) in selected_lines.iter().enumerate() {
        let line_num = offset + idx + 1;
        output.push_str(&format!("{}\t{}\n", line_num, line));
    }
    if end < total_lines {
        output.push_str(&format!(
            "\n[Showing lines {}-{} of {}]\n",
            offset + 1,
            end,
            total_lines
        ));
    }
    Ok(output)
}

fn tool_read_anchored(input: ReadAnchoredInput) -> Result<String> {
    let path = PathBuf::from(&input.file_path);
    if !path.exists() {
        return Err(anyhow!("File not found: {}", input.file_path));
    }
    let content = fs::read_to_string(&path)
        .with_context(|| format!("Failed to read file: {}", input.file_path))?;
    let normalized = normalize_text(&content);
    let (lines, _) = split_normalized_lines(&normalized);
    let total_lines = lines.len();
    let offset = input.offset.unwrap_or(0);
    let limit = input.limit.unwrap_or(DEFAULT_MAX_LINES);
    if offset >= total_lines {
        return Ok(format!(
            "[{}#{}]\n[File has {} lines, offset {} is out of range]\n",
            input.file_path,
            stable_hash_hex(&normalized, 8),
            total_lines,
            offset
        ));
    }
    let end = (offset + limit).min(total_lines);
    let selected_lines = &lines[offset..end];
    let mut output = String::new();
    output.push_str(&format!(
        "[{}#{}]\n",
        input.file_path,
        stable_hash_hex(&normalized, 8)
    ));
    for (idx, line) in selected_lines.iter().enumerate() {
        let line_num = offset + idx + 1;
        output.push_str(&format!(
            "{}:{}| {}\n",
            line_num,
            stable_hash_hex(line, 4),
            line
        ));
    }
    if end < total_lines {
        output.push_str(&format!(
            "\n[Showing lines {}-{} of {}]\n",
            offset + 1,
            end,
            total_lines
        ));
    }
    output.push_str(
        "\n[Edit with EditHashline using a patch section like:]\n\
         [path#tag]\n\
         SWAP 2.=2:\n\
         +replacement line\n",
    );
    Ok(output)
}

fn tool_write(input: WriteInput) -> Result<String> {
    let path = PathBuf::from(&input.file_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "Failed to create parent directories for: {}",
                input.file_path
            )
        })?;
    }
    fs::write(&path, &input.content)
        .with_context(|| format!("Failed to write file: {}", input.file_path))?;
    let line_count = input.content.lines().count();
    Ok(format!(
        "Successfully wrote {} lines to {}",
        line_count, input.file_path
    ))
}

// More tools to be added

fn tool_edit(input: EditInput) -> Result<String> {
    let path = PathBuf::from(&input.file_path);
    if !path.exists() {
        return Err(anyhow!("File not found: {}", input.file_path));
    }
    let content = fs::read_to_string(&path)
        .with_context(|| format!("Failed to read file: {}", input.file_path))?;
    let (new_content, replacements) = if input.replace_all {
        let count = content.matches(&input.old_string).count();
        (content.replace(&input.old_string, &input.new_string), count)
    } else {
        if let Some(pos) = content.find(&input.old_string) {
            let mut new_content = String::with_capacity(content.len());
            new_content.push_str(&content[..pos]);
            new_content.push_str(&input.new_string);
            new_content.push_str(&content[pos + input.old_string.len()..]);
            (new_content, 1)
        } else {
            return Err(anyhow!("String not found in file"));
        }
    };
    if replacements == 0 {
        return Err(anyhow!("String not found in file"));
    }
    fs::write(&path, &new_content)
        .with_context(|| format!("Failed to write file: {}", input.file_path))?;
    Ok(format!(
        "Successfully replaced {} occurrence(s) in {}",
        replacements, input.file_path
    ))
}

fn tool_edit_hashline(input: EditHashlineInput) -> Result<String> {
    let path = PathBuf::from(&input.file_path);
    if !path.exists() {
        return Err(anyhow!("File not found: {}", input.file_path));
    }
    let section = parse_hashline_patch(&input.patch)?;
    if section.path != input.file_path {
        return Err(anyhow!(
            "Patch section path {} does not match file_path {}",
            section.path,
            input.file_path
        ));
    }

    let content = fs::read_to_string(&path)
        .with_context(|| format!("Failed to read file: {}", input.file_path))?;
    let line_ending = preferred_line_ending(&content);
    let normalized = normalize_text(&content);
    let live_tag = stable_hash_hex(&normalized, 8);
    if section.tag != live_tag {
        return Err(anyhow!(
            "Stale hashline tag for {}: patch has {}, live file has {}",
            input.file_path,
            section.tag,
            live_tag
        ));
    }

    let (mut lines, trailing_newline) = split_normalized_lines(&normalized);
    let original_line_count = lines.len();
    let mut edits = section.edits;
    edits.sort_by(|left, right| right.anchor_index().cmp(&left.anchor_index()));

    // Detect overlapping edits to prevent silent corruption
    validate_edit_ranges(&edits, original_line_count)?;

    for edit in edits {
        apply_hashline_edit(&mut lines, original_line_count, edit)?;
    }

    let new_normalized = join_lines(&lines, trailing_newline);
    let new_content = if line_ending == "\r\n" {
        new_normalized.replace('\n', "\r\n")
    } else {
        new_normalized
    };
    if !input.dry_run {
        fs::write(&path, &new_content)
            .with_context(|| format!("Failed to write file: {}", input.file_path))?;
    }
    let next_tag = stable_hash_hex(&normalize_text(&new_content), 8);
    let mode = if input.dry_run { "Dry run" } else { "Applied" };
    Ok(format!(
        "{} hashline patch to {} ({} -> {}, {} line(s))",
        mode,
        input.file_path,
        live_tag,
        next_tag,
        lines.len()
    ))
}

fn tool_ls(input: LsInput) -> Result<String> {
    let path = input.path.as_deref().unwrap_or(".");
    let dir_path = PathBuf::from(path);
    if !dir_path.exists() {
        return Err(anyhow!("Path not found: {}", path));
    }
    if !dir_path.is_dir() {
        return Err(anyhow!("Not a directory: {}", path));
    }
    let mut entries: Vec<String> = Vec::new();
    for entry in
        fs::read_dir(&dir_path).with_context(|| format!("Failed to read directory: {}", path))?
    {
        let entry = entry?;
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        let metadata = entry.metadata()?;
        let suffix = if metadata.is_dir() { "/" } else { "" };
        entries.push(format!("{}{}", name, suffix));
    }
    entries.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    let limit = input.limit.unwrap_or(500);
    let total = entries.len();
    let truncated = total > limit;
    if truncated {
        entries.truncate(limit);
    }
    let mut output = entries.join("\n");
    if truncated {
        output.push_str(&format!("\n\n[Showing {} of {} entries]", limit, total));
    }
    if output.is_empty() {
        output = "(empty directory)".to_string();
    }
    Ok(output)
}

// Grep and Find to be added

fn tool_grep(input: GrepInput) -> Result<String> {
    let path = input.path.as_deref().unwrap_or(".");
    let root_path = PathBuf::from(path);
    if !root_path.exists() {
        return Err(anyhow!("Path not found: {}", path));
    }
    let case_sensitive = input.case_sensitive.unwrap_or(true);
    let pattern_str = if case_sensitive {
        input.pattern.clone()
    } else {
        format!("(?i){}", input.pattern)
    };
    let pattern = regex::Regex::new(&pattern_str)
        .with_context(|| format!("Invalid regex pattern: {}", input.pattern))?;
    let file_pattern = input
        .file_pattern
        .as_ref()
        .map(|p| regex::Regex::new(p).context("Invalid file pattern regex"))
        .transpose()?;
    let mut results = Vec::new();
    let mut files_searched = 0;
    for entry in workspace_walk(&root_path, false, false) {
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }
        let file_path = entry.path();
        let file_name = file_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if let Some(ref fp) = file_pattern {
            if !fp.is_match(file_name) {
                continue;
            }
        }
        files_searched += 1;
        if let Ok(content) = fs::read_to_string(file_path) {
            for (line_num, line) in content.lines().enumerate() {
                if pattern.is_match(line) {
                    let relative_path = file_path
                        .strip_prefix(&root_path)
                        .unwrap_or(file_path)
                        .display();
                    results.push(format!("{}:{}:{}", relative_path, line_num + 1, line));
                    if results.len() >= 1000 {
                        results.push("[Limit of 1000 matches reached]".to_string());
                        return Ok(results.join("\n"));
                    }
                }
            }
        }
    }
    if results.is_empty() {
        Ok(format!(
            "No matches found (searched {} files)",
            files_searched
        ))
    } else {
        Ok(results.join("\n"))
    }
}

// Find to be added

fn tool_find(input: FindInput) -> Result<String> {
    let path = input.path.as_deref().unwrap_or(".");
    let root_path = PathBuf::from(path);
    if !root_path.exists() {
        return Err(anyhow!("Path not found: {}", path));
    }
    let pattern = input
        .pattern
        .as_ref()
        .map(|p| regex::Regex::new(p).context("Invalid pattern regex"))
        .transpose()?;
    let file_type = input.file_type.as_deref();
    let mut results = Vec::new();
    for entry in workspace_walk(&root_path, false, false) {
        let entry = entry?;
        let entry_path = entry.path();
        let matches_type = matches_file_type(&entry, file_type)?;
        if !matches_type {
            continue;
        }
        let file_name = entry_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        let matches_pattern = if let Some(ref p) = pattern {
            p.is_match(file_name)
        } else {
            true
        };
        if matches_pattern {
            let relative_path = entry_path
                .strip_prefix(&root_path)
                .unwrap_or(entry_path)
                .display();
            results.push(relative_path.to_string());
            if results.len() >= 1000 {
                results.push("[Limit of 1000 results reached]".to_string());
                break;
            }
        }
    }
    if results.is_empty() {
        Ok("No files found".to_string())
    } else {
        Ok(results.join("\n"))
    }
}

fn tool_glob(input: GlobInput) -> Result<String> {
    let root_path = PathBuf::from(&input.path);
    if !root_path.exists() {
        return Err(anyhow!("Path not found: {}", input.path));
    }
    if !root_path.is_dir() {
        return Err(anyhow!("Not a directory: {}", input.path));
    }
    let mut builder = GlobSetBuilder::new();
    let glob = GlobBuilder::new(&normalize_glob_pattern(&input.pattern))
        .literal_separator(true)
        .build()
        .with_context(|| format!("Invalid glob pattern: {}", input.pattern))?;
    builder.add(glob);
    let glob_set = builder.build().context("Failed to build glob set")?;
    let limit = input.limit.unwrap_or(1000);
    let mut results = Vec::new();
    for entry in workspace_walk(&root_path, input.include_hidden, input.include_node_modules) {
        let entry = entry?;
        if !matches_file_type(&entry, input.file_type.as_deref())? {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(&root_path)
            .unwrap_or(entry.path());
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if glob_set.is_match(&rel_str) {
            results.push(format_entry_path(&root_path, entry.path()));
            if results.len() >= limit {
                results.push(format!("[Limit of {} results reached]", limit));
                break;
            }
        }
    }
    results.sort();
    if results.is_empty() {
        Ok("No files matched".to_string())
    } else {
        Ok(results.join("\n"))
    }
}

fn tool_fuzzy_find(input: FuzzyFindInput) -> Result<String> {
    let root = input.path.as_deref().unwrap_or(".");
    let root_path = PathBuf::from(root);
    if !root_path.exists() {
        return Err(anyhow!("Path not found: {}", root));
    }
    if !root_path.is_dir() {
        return Err(anyhow!("Not a directory: {}", root));
    }
    let query = normalize_fuzzy_text(&input.query);
    if query.is_empty() {
        return Err(anyhow!("FuzzyFind query must not be empty"));
    }
    let limit = input.limit.unwrap_or(100);
    let mut scored = Vec::new();
    for entry in workspace_walk(&root_path, input.include_hidden, input.include_node_modules) {
        let entry = entry?;
        if !matches_file_type(&entry, input.file_type.as_deref())? {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(&root_path)
            .unwrap_or(entry.path());
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if let Some(score) = fuzzy_score(&query, &rel_str) {
            scored.push((score, rel_str));
        }
    }
    scored.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    let mut results = scored
        .into_iter()
        .take(limit)
        .map(|(score, path)| format!("{}\t{}", score, path))
        .collect::<Vec<_>>();
    if results.is_empty() {
        Ok("No fuzzy matches found".to_string())
    } else {
        if results.len() >= limit {
            results.push(format!("[Showing top {} fuzzy matches]", limit));
        }
        Ok(results.join("\n"))
    }
}

fn tool_ast_grep(input: AstGrepInput) -> Result<String> {
    let pattern = input.pattern.trim();
    if pattern.is_empty() {
        return Err(anyhow!("AstGrep pattern must not be empty"));
    }
    let root = input.path.as_deref().unwrap_or(".");
    let root_path = PathBuf::from(root);
    if !root_path.exists() {
        return Err(anyhow!("Path not found: {}", root));
    }
    let strictness = parse_ast_strictness(input.strictness.as_deref())?;
    let explicit_lang = input
        .lang
        .as_deref()
        .map(resolve_ast_language)
        .transpose()?;
    let glob_set = input
        .glob
        .as_deref()
        .map(build_single_glob_set)
        .transpose()?;
    let candidates = collect_ast_candidates(
        &root_path,
        glob_set.as_ref(),
        input.include_hidden,
        input.include_node_modules,
        explicit_lang.is_some(),
    )?;
    let limit = normalize_limit(input.limit, DEFAULT_AST_LIMIT, MAX_AST_LIMIT);
    let offset = input.offset.unwrap_or(0);
    let mut matches = Vec::new();
    let mut parse_errors = Vec::new();
    let mut files_searched = 0usize;
    let mut compiled_by_lang: HashMap<AstLanguage, Result<Pattern, String>> = HashMap::new();

    for candidate in candidates {
        let Some(lang) = explicit_lang.or_else(|| AstLanguage::from_path(&candidate.path)) else {
            continue;
        };
        files_searched += 1;
        let compile_result = compiled_by_lang.entry(lang).or_insert_with(|| {
            compile_ast_pattern(pattern, input.selector.as_deref(), strictness.clone(), lang)
                .map_err(|err| err.to_string())
        });
        let compiled = match compile_result {
            Ok(pattern) => pattern.clone(),
            Err(error) => {
                parse_errors.push(format!(
                    "{}: failed to compile pattern as {}: {}",
                    candidate.display,
                    lang.canonical_name(),
                    error
                ));
                continue;
            }
        };
        let content = match fs::read_to_string(&candidate.path) {
            Ok(content) => content,
            Err(err) => {
                parse_errors.push(format!(
                    "{}: failed to read file: {}",
                    candidate.display, err
                ));
                continue;
            }
        };
        let found = collect_ast_matches(
            &candidate.display,
            &content,
            lang,
            compiled,
            input.include_meta,
        );
        matches.extend(found);
    }

    matches.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| left.byte_start.cmp(&right.byte_start))
            .then_with(|| left.byte_end.cmp(&right.byte_end))
    });
    let total_matches = matches.len();
    let files_with_matches = matches
        .iter()
        .map(|item| item.path.as_str())
        .collect::<std::collections::BTreeSet<_>>()
        .len();
    let limit_reached = total_matches > offset.saturating_add(limit);
    let visible = matches
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();
    Ok(render_ast_grep_output(
        &visible,
        total_matches,
        files_with_matches,
        files_searched,
        limit_reached,
        &parse_errors,
    ))
}

fn tool_ast_edit_plan(input: AstEditPlanInput) -> Result<String> {
    let pattern = input.pattern.trim();
    if pattern.is_empty() {
        return Err(anyhow!("AstEdit pattern must not be empty"));
    }
    let path = PathBuf::from(&input.file_path);
    if !path.exists() {
        return Err(anyhow!("File not found: {}", input.file_path));
    }
    if !path.is_file() {
        return Err(anyhow!("AstEdit currently requires one file path"));
    }
    let lang = input
        .lang
        .as_deref()
        .map(resolve_ast_language)
        .transpose()?
        .or_else(|| AstLanguage::from_path(&path))
        .ok_or_else(|| {
            anyhow!(
                "Could not infer AstEdit language for {}. Provide lang.",
                input.file_path
            )
        })?;
    let strictness = parse_ast_strictness(input.strictness.as_deref())?;
    let compiled = compile_ast_pattern(pattern, input.selector.as_deref(), strictness, lang)?;
    let content = fs::read_to_string(&path)
        .with_context(|| format!("Failed to read file: {}", input.file_path))?;
    let normalized = normalize_text(&content);
    let mut matches = collect_ast_matches(&input.file_path, &normalized, lang, compiled, false);
    matches.sort_by(|left, right| {
        left.byte_start
            .cmp(&right.byte_start)
            .then_with(|| left.byte_end.cmp(&right.byte_end))
    });
    let limit = normalize_limit(input.limit, DEFAULT_AST_LIMIT, MAX_AST_LIMIT);
    let limit_reached = matches.len() > limit;
    matches.truncate(limit);
    reject_overlapping_matches(&matches)?;
    reject_overlapping_line_ranges(&matches)?;
    if matches.is_empty() {
        return Ok(format!(
            "AstEdit preview: No replacements made in {}",
            input.file_path
        ));
    }
    let (lines, _) = split_normalized_lines(&normalized);
    let line_ranges = normalized_line_ranges(&lines);
    let tag = stable_hash_hex(&normalized, 8);
    let mut patch = String::new();
    patch.push_str(&format!("[{}#{}]\n", input.file_path, tag));
    for item in &matches {
        patch.push_str(&format!("SWAP {}.={}:\n", item.start_line, item.end_line));
        for line in ast_edit_replacement_lines(item, &lines, &line_ranges, &input.replacement)? {
            patch.push('+');
            patch.push_str(&line);
            patch.push('\n');
        }
    }

    let mut out = Vec::new();
    out.push(format!(
        "AstEdit preview: {} replacement(s) in {}",
        matches.len(),
        input.file_path
    ));
    out.push(format!("language: {}", lang.canonical_name()));
    if limit_reached {
        out.push("Limit reached; narrow pattern or increase limit.".to_string());
    }
    out.push(String::new());
    out.push("Patch:".to_string());
    out.push(patch.trim_end().to_string());
    out.push(String::new());
    out.push("Changes:".to_string());
    for item in &matches {
        let before = first_line_preview(&item.text);
        let after = first_line_preview(&input.replacement);
        out.push(format!("-{}:{}", item.start_line, before));
        out.push(format!("+{}:{}", item.start_line, after));
    }
    out.push(String::new());
    out.push(format!(
        "details: totalReplacements={}, filesTouched=1, filesSearched=1, applied=false, limitReached={}",
        matches.len(),
        limit_reached
    ));
    if lines.is_empty() {
        out.push("warning: source file has no line content".to_string());
    }
    Ok(out.join("\n"))
}

fn tool_lsp(input: LspInput) -> Result<String> {
    let action = normalize_lsp_action(&input.action)?;
    let limit = normalize_limit(input.limit, DEFAULT_LSP_LIMIT, MAX_LSP_LIMIT);
    let _compat_fields = (
        &input.new_name,
        &input.apply,
        &input.timeout,
        &input.payload,
    );
    match action.as_str() {
        "status" => Ok(lsp_status()),
        "capabilities" => Ok(lsp_capabilities(input.file.as_deref())),
        "diagnostics" => lsp_diagnostics(input.file.as_deref(), limit),
        "symbols" => lsp_symbols(input.file.as_deref(), input.query.as_deref(), limit),
        "definition" | "type_definition" | "implementation" => {
            lsp_definition_like(&action, &input, limit)
        }
        "references" => lsp_references(&input, limit),
        "hover" => lsp_hover(&input),
        "reload" => Ok("Reloaded native LSP-style indexer (stateless process tool).".to_string()),
        "request" => Ok(format!(
            "Native LSP-style fallback does not support raw JSON-RPC request{}.",
            input
                .query
                .as_deref()
                .filter(|query| !query.trim().is_empty())
                .map(|query| format!(" {}", query.trim()))
                .unwrap_or_default()
        )),
        "rename" | "rename_file" | "code_actions" => Ok(format!(
            "Lsp action {} is declared but requires a project language-server backend; use AstEdit/Resolve for Magenta-native previewed edits.",
            action
        )),
        other => Err(anyhow!("Unsupported Lsp action: {}", other)),
    }
}

fn normalize_lsp_action(action: &str) -> Result<String> {
    let normalized = action.trim().to_ascii_lowercase().replace('-', "_");
    match normalized.as_str() {
        "diagnostics" | "definition" | "references" | "hover" | "symbols" | "rename"
        | "rename_file" | "code_actions" | "type_definition" | "implementation" | "status"
        | "reload" | "capabilities" | "request" => Ok(normalized),
        "" => Err(anyhow!("Lsp action is required")),
        other => Err(anyhow!("Unsupported Lsp action: {}", other)),
    }
}

fn lsp_status() -> String {
    let servers = detect_lsp_candidates(&PathBuf::from("."));
    let mut out = vec![
        "Language servers: native LSP-style fallback active".to_string(),
        "Backend: Magenta process Magnet; stateless AST/text indexer".to_string(),
        "Supported now: status, diagnostics, symbols, definition, references, hover, capabilities"
            .to_string(),
        "Deferred to future language-server backend: rename, rename_file, code_actions, raw request"
            .to_string(),
    ];
    if servers.is_empty() {
        out.push("Detected project servers: none from local markers/PATH".to_string());
    } else {
        out.push("Detected project servers:".to_string());
        for server in servers {
            out.push(format!("- {}", server));
        }
    }
    out.join("\n")
}

fn lsp_capabilities(file: Option<&str>) -> String {
    let mut out = vec![
        "native-lsp-style-fallback:".to_string(),
        "  capabilities:".to_string(),
        "    textDocument/documentSymbol: true".to_string(),
        "    textDocument/definition: true (same-file/static import-aware fallback)".to_string(),
        "    textDocument/references: true (workspace text references)".to_string(),
        "    textDocument/hover: true (symbol summary)".to_string(),
        "    textDocument/publishDiagnostics: true (workspace command fallback)".to_string(),
        "    textDocument/rename: false (use AstEdit + Resolve)".to_string(),
        "    textDocument/codeAction: false".to_string(),
    ];
    if let Some(file) = file.filter(|file| !file.trim().is_empty() && *file != "*") {
        out.push(format!("  scoped_file: {}", file));
        if let Some(lang) = AstLanguage::from_path(Path::new(file)) {
            out.push(format!("  inferred_language: {}", lang.canonical_name()));
        }
    }
    out.join("\n")
}

fn lsp_diagnostics(file: Option<&str>, limit: usize) -> Result<String> {
    let target = file.unwrap_or("*").trim();
    if target.is_empty() || target == "*" {
        return lsp_workspace_diagnostics(limit);
    }
    if looks_like_glob(target) {
        let root = PathBuf::from(".");
        let glob = build_single_glob_set(target)?;
        let mut outputs = Vec::new();
        for candidate in collect_ast_candidates(&root, Some(&glob), false, false, true)?
            .into_iter()
            .take(limit)
        {
            outputs.push(lsp_file_diagnostics(&candidate.path, &candidate.display)?);
        }
        return Ok(if outputs.is_empty() {
            format!("No diagnostic targets matched {}", target)
        } else {
            outputs.join("\n\n")
        });
    }
    let path = PathBuf::from(target);
    lsp_file_diagnostics(&path, target)
}

fn lsp_workspace_diagnostics(limit: usize) -> Result<String> {
    for (label, command, args, marker) in [
        (
            "Rust cargo check",
            "cargo",
            vec!["check", "--message-format=short"],
            "Cargo.toml",
        ),
        (
            "TypeScript tsc",
            "npx",
            vec!["tsc", "--noEmit", "--pretty", "false"],
            "tsconfig.json",
        ),
        ("Go build", "go", vec!["build", "./..."], "go.mod"),
        (
            "Python pyright",
            "pyright",
            Vec::<&str>::new(),
            "pyproject.toml",
        ),
    ] {
        if !Path::new(marker).exists() || !command_available(command) {
            continue;
        }
        let output = Command::new(command)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .with_context(|| format!("Failed to run workspace diagnostics command {}", command))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let mut body = String::new();
        body.push_str(stdout.trim_end());
        if !stderr.trim().is_empty() {
            if !body.is_empty() {
                body.push('\n');
            }
            body.push_str(stderr.trim_end());
        }
        if body.trim().is_empty() && output.status.success() {
            body = "OK".to_string();
        }
        body = body.lines().take(limit).collect::<Vec<_>>().join("\n");
        return Ok(format!("Workspace diagnostics ({}):\n{}", label, body));
    }
    Ok(
        "Workspace diagnostics unavailable: no supported project marker with an available local diagnostic command."
            .to_string(),
    )
}

fn lsp_file_diagnostics(path: &Path, display: &str) -> Result<String> {
    if !path.exists() {
        return Err(anyhow!("File not found: {}", display));
    }
    let content =
        fs::read_to_string(path).with_context(|| format!("Failed to read file: {}", display))?;
    let Some(lang) = AstLanguage::from_path(path) else {
        return Ok(format!(
            "{}: diagnostics unavailable for unsupported file type",
            display
        ));
    };
    let ast = lang.ast_grep(&content);
    if tree_has_error(ast.root().get_inner_node()) {
        Ok(format!(
            "{}:1:1 [error] Parse error detected by native tree-sitter fallback",
            display
        ))
    } else {
        Ok("OK".to_string())
    }
}

fn lsp_symbols(file: Option<&str>, query: Option<&str>, limit: usize) -> Result<String> {
    match file.map(str::trim).filter(|file| !file.is_empty()) {
        Some("*") | None => lsp_workspace_symbols(query.unwrap_or(""), limit),
        Some(file) => lsp_document_symbols(file, query, limit),
    }
}

fn lsp_workspace_symbols(query: &str, limit: usize) -> Result<String> {
    let root = PathBuf::from(".");
    let query = query.trim();
    if query.is_empty() {
        return Err(anyhow!("Lsp symbols workspace mode requires query"));
    }
    let candidates = collect_ast_candidates(&root, None, false, false, false)?;
    let mut matches = Vec::new();
    for candidate in candidates {
        let Ok(symbols) = collect_lsp_symbols_for_file(&candidate.path, &candidate.display) else {
            continue;
        };
        for symbol in symbols {
            if symbol.name.to_lowercase().contains(&query.to_lowercase()) {
                matches.push(symbol);
            }
        }
    }
    matches.sort_by(|left, right| {
        left.file
            .cmp(&right.file)
            .then_with(|| left.line.cmp(&right.line))
            .then_with(|| left.name.cmp(&right.name))
    });
    render_lsp_symbols(
        &format!("Found {} symbol(s) matching \"{}\":", matches.len(), query),
        &matches,
        limit,
    )
}

fn lsp_document_symbols(file: &str, query: Option<&str>, limit: usize) -> Result<String> {
    let path = PathBuf::from(file);
    let mut symbols = collect_lsp_symbols_for_file(&path, file)?;
    if let Some(query) = query.map(str::trim).filter(|query| !query.is_empty()) {
        let query = query.to_lowercase();
        symbols.retain(|symbol| symbol.name.to_lowercase().contains(&query));
    }
    render_lsp_symbols(&format!("Symbols in {}:", file), &symbols, limit)
}

fn render_lsp_symbols(header: &str, symbols: &[LspSymbol], limit: usize) -> Result<String> {
    let mut out = vec![header.to_string()];
    if symbols.is_empty() {
        out.push("No symbols found".to_string());
    } else {
        for symbol in symbols.iter().take(limit) {
            out.push(format!(
                "{}{} [{}] @ {}:{}:{}",
                "  ".repeat(symbol.depth),
                symbol.name,
                symbol.kind,
                symbol.file,
                symbol.line,
                symbol.column
            ));
        }
        if symbols.len() > limit {
            out.push(format!(
                "... {} additional symbol(s) omitted",
                symbols.len() - limit
            ));
        }
    }
    Ok(out.join("\n"))
}

fn lsp_definition_like(action: &str, input: &LspInput, limit: usize) -> Result<String> {
    let file = required_lsp_file(input)?;
    let symbol = resolve_lsp_symbol(input)?;
    let mut locations = find_symbol_definitions(&symbol, Some(Path::new(&file)), limit)?;
    if action == "definition" && locations.is_empty() {
        locations = find_text_occurrences(&symbol, Some(Path::new(&file)), 1)?;
    }
    let label = match action {
        "type_definition" => "type definition",
        "implementation" => "implementation",
        _ => "definition",
    };
    render_lsp_locations(label, &locations, limit)
}

fn lsp_references(input: &LspInput, limit: usize) -> Result<String> {
    let file = required_lsp_file(input)?;
    let symbol = resolve_lsp_symbol(input)?;
    let locations = find_text_occurrences(&symbol, Some(Path::new(&file)), limit)?;
    render_lsp_locations("reference", &locations, limit)
}

fn lsp_hover(input: &LspInput) -> Result<String> {
    let file = required_lsp_file(input)?;
    let symbol = resolve_lsp_symbol(input)?;
    let definitions = find_symbol_definitions(&symbol, Some(Path::new(&file)), 5)?;
    let references = find_text_occurrences(&symbol, Some(Path::new(&file)), 500)?;
    let mut out = vec![format!("{} ({})", symbol, file)];
    if let Some(definition) = definitions.first() {
        out.push(format!(
            "Defined at {}:{}:{} [{}]",
            definition.file, definition.line, definition.column, definition.kind
        ));
        if !definition.preview.is_empty() {
            out.push(definition.preview.clone());
        }
    } else {
        out.push("No definition found by native fallback".to_string());
    }
    out.push(format!("Workspace references: {}", references.len()));
    Ok(out.join("\n"))
}

fn render_lsp_locations(label: &str, locations: &[LspLocation], limit: usize) -> Result<String> {
    if locations.is_empty() {
        return Ok(format!("No {}s found", label));
    }
    let mut out = vec![format!("Found {} {}(s):", locations.len(), label)];
    for location in locations.iter().take(limit) {
        out.push(format!(
            "{}:{}:{} [{}] {}",
            location.file, location.line, location.column, location.kind, location.preview
        ));
    }
    if locations.len() > limit {
        out.push(format!(
            "... {} additional {}(s) shown without context",
            locations.len() - limit,
            label
        ));
    }
    Ok(out.join("\n"))
}

fn tool_web_search(input: WebSearchInput) -> Result<String> {
    let query = input.query.trim();
    if query.is_empty() {
        return Err(anyhow!("WebSearch query must not be empty"));
    }
    let limit = normalize_limit(input.limit, DEFAULT_WEB_LIMIT, MAX_WEB_LIMIT);
    let mut provider_notes = Vec::new();
    if let Some(rendered) = try_duckduckgo_search(query, limit, &mut provider_notes)? {
        return Ok(rendered);
    }
    try_bing_search(query, limit, input.recency.as_deref(), &provider_notes)
}

fn try_duckduckgo_search(
    query: &str,
    limit: usize,
    provider_notes: &mut Vec<String>,
) -> Result<Option<String>> {
    let url = format!(
        "https://api.duckduckgo.com/?q={}&format=json&no_html=1&skip_disambig=1",
        urlencoding::encode(query)
    );
    let response = match ureq::get(&url)
        .set("Accept", "application/json")
        .set("User-Agent", "Magenta-WebSearch/0.1")
        .call()
    {
        Ok(response) => response,
        Err(err) => {
            provider_notes.push(format!("DuckDuckGo failed: {}", err));
            return Ok(None);
        }
    };
    let value: serde_json::Value = response
        .into_json()
        .context("failed to decode DuckDuckGo search JSON")?;
    let mut out = Vec::new();
    out.push("Provider: duckduckgo-instant-answer".to_string());
    out.push(String::new());
    if let Some(answer) = first_nonempty([
        value
            .get("AbstractText")
            .and_then(serde_json::Value::as_str),
        value.get("Answer").and_then(serde_json::Value::as_str),
        value.get("Definition").and_then(serde_json::Value::as_str),
    ]) {
        out.push(answer.to_string());
        out.push(String::new());
    }

    let mut sources = Vec::new();
    collect_duckduckgo_sources(&value, &mut sources);
    sources.truncate(limit);
    if sources.is_empty() && out.len() <= 2 {
        provider_notes.push("DuckDuckGo returned no renderable results".to_string());
        return Ok(None);
    }
    append_sources(&mut out, &sources);
    Ok(Some(format!("{}\n", out.join("\n"))))
}

fn try_bing_search(
    query: &str,
    limit: usize,
    recency: Option<&str>,
    provider_notes: &[String],
) -> Result<String> {
    let url = bing_search_url(query, recency);
    let response = ureq::get(&url)
        .set(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .set("User-Agent", "Magenta-WebSearch/0.1")
        .call()
        .map_err(|err| anyhow!("Bing search request failed after fallback: {}", err))?;
    let html = response
        .into_string()
        .context("failed to read Bing search HTML")?;
    let mut sources = extract_bing_sources(&html);
    sources.truncate(limit);
    let mut out = vec![
        "Provider: bing-html-fallback".to_string(),
        format!("Query: {}", query),
        String::new(),
    ];
    if !provider_notes.is_empty() {
        out.push("Provider notes:".to_string());
        for note in provider_notes {
            out.push(format!("- {}", note));
        }
        out.push(String::new());
    }
    if sources.is_empty() {
        out.push(format!(
            "No Bing HTML results extracted for query: {}",
            query
        ));
    } else {
        append_sources(&mut out, &sources);
    }
    if let Some(recency) = recency.filter(|recency| !recency.is_empty()) {
        out.push(String::new());
        out.push(format!(
            "Note: Bing fallback maps recency best-effort; requested recency was {}.",
            recency
        ));
    }
    Ok(format!("{}\n", out.join("\n")))
}

fn tool_read_url(input: ReadUrlInput) -> Result<String> {
    let url = normalize_url(&input.url)?;
    let response = ureq::get(&url)
        .set(
            "Accept",
            "text/markdown,text/plain,application/json,text/html,*/*;q=0.8",
        )
        .set("User-Agent", "Magenta-ReadUrl/0.1")
        .call()
        .map_err(|err| anyhow!("URL request failed for {}: {}", url, err))?;
    let final_url = response.get_url().to_string();
    let status = response.status();
    let content_type = response
        .header("content-type")
        .unwrap_or("application/octet-stream")
        .to_string();
    let limited = response
        .into_reader()
        .take(MAX_URL_BYTES + 1)
        .bytes()
        .collect::<std::result::Result<Vec<_>, _>>()
        .context("failed to read URL response body")?;
    let byte_truncated = limited.len() as u64 > MAX_URL_BYTES;
    let bytes = if byte_truncated {
        &limited[..MAX_URL_BYTES as usize]
    } else {
        &limited
    };
    let body = String::from_utf8_lossy(bytes);
    let (method, mut text) = render_url_body(&body, &content_type, input.raw);
    let total_lines = text.lines().count();
    text = slice_lines(&text, input.offset.unwrap_or(1), input.limit);
    let char_truncated = text.chars().count() > MAX_URL_OUTPUT_CHARS;
    if char_truncated {
        text = truncate_chars(&text, MAX_URL_OUTPUT_CHARS);
    }

    let mut out = format!(
        "URL: {}\nFinal-URL: {}\nStatus: {}\nContent-Type: {}\nMethod: {}\n",
        url, final_url, status, content_type, method
    );
    if byte_truncated || char_truncated || input.offset.is_some() || input.limit.is_some() {
        out.push_str(&format!(
            "Truncation: bytes_truncated={}, chars_truncated={}, total_lines={}\n",
            byte_truncated, char_truncated, total_lines
        ));
    }
    out.push_str("\n---\n");
    out.push_str(text.trim_end());
    out.push('\n');
    Ok(out)
}

fn tool_bash(input: BashInput) -> Result<String> {
    let output = Command::new("bash")
        .arg("-c")
        .arg(&input.command)
        .stdin(Stdio::null())
        .output()
        .with_context(|| "Failed to execute bash command")?;

    let mut result = String::new();

    if !output.stdout.is_empty() {
        result.push_str(&String::from_utf8_lossy(&output.stdout));
    }

    if !output.stderr.is_empty() {
        if !result.is_empty() {
            result.push_str("\n");
        }
        result.push_str(&String::from_utf8_lossy(&output.stderr));
    }

    if !output.status.success() {
        return Err(anyhow!(
            "Command failed with exit code: {:?}\n{}",
            output.status.code(),
            result
        ));
    }

    Ok(result)
}

fn workspace_walk(
    root_path: &PathBuf,
    include_hidden: bool,
    include_node_modules: bool,
) -> impl Iterator<Item = walkdir::Result<walkdir::DirEntry>> {
    WalkDir::new(root_path)
        .max_depth(20)
        .follow_links(false)
        .into_iter()
        .filter_entry(move |entry| should_visit(entry, include_hidden, include_node_modules))
}

fn should_visit(
    entry: &walkdir::DirEntry,
    include_hidden: bool,
    include_node_modules: bool,
) -> bool {
    let Some(name) = entry.file_name().to_str() else {
        return true;
    };
    if name == ".git" {
        return false;
    }
    if !include_node_modules && name == "node_modules" {
        return false;
    }
    if !include_hidden && name.starts_with('.') && entry.depth() > 0 {
        return false;
    }
    true
}

fn matches_file_type(entry: &walkdir::DirEntry, file_type: Option<&str>) -> Result<bool> {
    match file_type {
        Some("f") | Some("file") => Ok(entry.file_type().is_file()),
        Some("d") | Some("dir") | Some("directory") => Ok(entry.file_type().is_dir()),
        Some("l") | Some("link") => Ok(entry.file_type().is_symlink()),
        None => Ok(true),
        Some(t) => Err(anyhow!("Unknown file type: {}", t)),
    }
}

fn format_entry_path(root_path: &PathBuf, path: &std::path::Path) -> String {
    path.strip_prefix(root_path)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn normalize_glob_pattern(pattern: &str) -> String {
    let normalized = pattern.replace('\\', "/");
    if normalized.contains('/') || normalized.starts_with("**") {
        normalized
    } else {
        format!("**/{normalized}")
    }
}

#[derive(Debug, Clone)]
struct WebSource {
    title: Option<String>,
    url: Option<String>,
    snippet: Option<String>,
}

fn collect_duckduckgo_sources(value: &serde_json::Value, sources: &mut Vec<WebSource>) {
    if let Some(url) = value
        .get("AbstractURL")
        .and_then(serde_json::Value::as_str)
        .filter(|url| !url.is_empty())
    {
        sources.push(WebSource {
            title: value
                .get("Heading")
                .and_then(serde_json::Value::as_str)
                .filter(|title| !title.is_empty())
                .map(str::to_string),
            url: Some(url.to_string()),
            snippet: value
                .get("AbstractText")
                .and_then(serde_json::Value::as_str)
                .filter(|snippet| !snippet.is_empty())
                .map(str::to_string),
        });
    }
    collect_duckduckgo_related(value.get("Results"), sources);
    collect_duckduckgo_related(value.get("RelatedTopics"), sources);
    sources.sort_by(|left, right| {
        left.url
            .cmp(&right.url)
            .then_with(|| left.title.cmp(&right.title))
    });
    sources.dedup_by(|left, right| left.url == right.url && left.title == right.title);
}

fn collect_duckduckgo_related(value: Option<&serde_json::Value>, sources: &mut Vec<WebSource>) {
    let Some(items) = value.and_then(serde_json::Value::as_array) else {
        return;
    };
    for item in items {
        if item.get("Topics").is_some() {
            collect_duckduckgo_related(item.get("Topics"), sources);
            continue;
        }
        let title = item
            .get("Text")
            .and_then(serde_json::Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_string);
        let url = item
            .get("FirstURL")
            .and_then(serde_json::Value::as_str)
            .filter(|url| !url.is_empty())
            .map(str::to_string);
        if title.is_some() || url.is_some() {
            sources.push(WebSource {
                snippet: title.clone(),
                title,
                url,
            });
        }
    }
}

fn append_sources(out: &mut Vec<String>, sources: &[WebSource]) {
    out.push(format!("## Sources ({})", sources.len()));
    for (idx, source) in sources.iter().enumerate() {
        out.push(format!(
            "[{}] {}",
            idx + 1,
            source.title.as_deref().unwrap_or("Untitled")
        ));
        if let Some(url) = &source.url {
            out.push(format!("    {}", url));
        }
        if let Some(snippet) = source.snippet.as_deref() {
            out.push(format!("    {}", truncate_chars(snippet, 240)));
        }
    }
}

fn bing_search_url(query: &str, recency: Option<&str>) -> String {
    let mut url = format!(
        "https://www.bing.com/search?q={}",
        urlencoding::encode(query)
    );
    let filter = match recency {
        Some("day") => Some("ex1:%22ez1%22"),
        Some("week") => Some("ex1:%22ez2%22"),
        Some("month") => Some("ex1:%22ez3%22"),
        Some("year") => Some("ex1:%22ez5_0_0%22"),
        _ => None,
    };
    if let Some(filter) = filter {
        url.push_str("&filters=");
        url.push_str(&urlencoding::encode(filter));
    }
    url
}

fn extract_bing_sources(html: &str) -> Vec<WebSource> {
    let mut sources = Vec::new();
    let Ok(item_regex) =
        regex::Regex::new(r#"(?is)<li\b[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>(.*?)</li>"#)
    else {
        return sources;
    };
    let link_regex =
        regex::Regex::new(r#"(?is)<h2[^>]*>.*?<a\b[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#)
            .expect("valid Bing link regex");
    let caption_regex =
        regex::Regex::new(r#"(?is)<p\b[^>]*class="[^"]*\bb_lineclamp[^"]*"[^>]*>(.*?)</p>"#)
            .expect("valid Bing caption regex");
    for item in item_regex.captures_iter(html) {
        let Some(block) = item.get(1).map(|value| value.as_str()) else {
            continue;
        };
        let Some(link) = link_regex.captures(block) else {
            continue;
        };
        let Some(url) = link
            .get(1)
            .map(|value| decode_basic_html_entities(value.as_str()))
        else {
            continue;
        };
        if !url.starts_with("http://") && !url.starts_with("https://") {
            continue;
        }
        let title = link
            .get(2)
            .map(|value| clean_html_inline(value.as_str()))
            .filter(|value| !value.is_empty());
        let snippet = caption_regex
            .captures(block)
            .and_then(|captures| captures.get(1))
            .map(|value| clean_html_inline(value.as_str()))
            .filter(|value| !value.is_empty());
        sources.push(WebSource {
            title,
            url: Some(url),
            snippet,
        });
    }
    sources.dedup_by(|left, right| left.url == right.url);
    sources
}

fn normalize_url(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("ReadUrl url must not be empty"));
    }
    let url = if trimmed.starts_with("www.") {
        format!("https://{}", trimmed)
    } else {
        trimmed.to_string()
    };
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(anyhow!("ReadUrl only supports http:// and https:// URLs"));
    }

    // SSRF guard: reject private/loopback/link-local IPs
    if let Ok(parsed) = url::Url::parse(&url) {
        if let Some(host) = parsed.host_str() {
            // Block localhost/loopback
            if host == "localhost" || host == "127.0.0.1" || host.starts_with("127.")
                || host == "::1" || host == "0.0.0.0" {
                return Err(anyhow!("ReadUrl blocked: localhost/loopback not allowed"));
            }
            // Block link-local (AWS metadata, etc.)
            if host.starts_with("169.254.") || host.starts_with("fe80:") {
                return Err(anyhow!("ReadUrl blocked: link-local addresses not allowed"));
            }
            // Block RFC1918 private ranges
            if host.starts_with("10.")
                || host.starts_with("192.168.")
                || (host.starts_with("172.") && host.split('.').nth(1)
                    .and_then(|s| s.parse::<u8>().ok())
                    .map_or(false, |n| n >= 16 && n <= 31)) {
                return Err(anyhow!("ReadUrl blocked: private IP ranges not allowed"));
            }
        }
    }

    Ok(url)
}

fn render_url_body(body: &str, content_type: &str, raw: bool) -> (&'static str, String) {
    if raw {
        return ("raw", body.to_string());
    }
    let lowered = content_type.to_ascii_lowercase();
    if lowered.contains("application/json") || looks_like_json_body(body) {
        return ("json", pretty_json_or_raw(body));
    }
    if lowered.contains("text/html") || looks_like_html(body) {
        return ("html-text", html_to_text(body));
    }
    ("text", body.to_string())
}

fn html_to_text(html: &str) -> String {
    let mut text = html.to_string();
    for pattern in [
        r"(?is)<script\b[^>]*>.*?</script>",
        r"(?is)<style\b[^>]*>.*?</style>",
        r"(?is)<!--.*?-->",
    ] {
        if let Ok(regex) = regex::Regex::new(pattern) {
            text = regex.replace_all(&text, " ").to_string();
        }
    }
    for (pattern, replacement) in [
        (r"(?i)<\s*br\s*/?\s*>", "\n"),
        (r"(?i)</\s*p\s*>", "\n\n"),
        (r"(?i)</\s*div\s*>", "\n"),
        (r"(?i)</\s*li\s*>", "\n"),
        (r"(?i)</\s*h[1-6]\s*>", "\n\n"),
    ] {
        if let Ok(regex) = regex::Regex::new(pattern) {
            text = regex.replace_all(&text, replacement).to_string();
        }
    }
    if let Ok(regex) = regex::Regex::new(r"(?is)<[^>]+>") {
        text = regex.replace_all(&text, " ").to_string();
    }
    decode_basic_html_entities(&collapse_text(&text))
}

fn collapse_text(text: &str) -> String {
    let mut out = String::new();
    let mut blank_lines = 0usize;
    for line in text.lines() {
        let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if collapsed.is_empty() {
            blank_lines += 1;
            if blank_lines <= 1 && !out.ends_with('\n') {
                out.push('\n');
            }
            continue;
        }
        blank_lines = 0;
        out.push_str(&collapsed);
        out.push('\n');
    }
    out.trim().to_string()
}

fn decode_basic_html_entities(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&ensp;", " ")
        .replace("&#0183;", "-")
}

fn clean_html_inline(html: &str) -> String {
    let without_tags = regex::Regex::new(r"(?is)<[^>]+>")
        .ok()
        .map(|regex| regex.replace_all(html, " ").to_string())
        .unwrap_or_else(|| html.to_string());
    decode_basic_html_entities(
        &without_tags
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" "),
    )
}

fn looks_like_html(body: &str) -> bool {
    let trimmed = body.trim_start().to_ascii_lowercase();
    trimmed.starts_with("<!doctype html")
        || trimmed.starts_with("<html")
        || trimmed.contains("<body")
        || trimmed.contains("<head")
}

fn looks_like_json_body(body: &str) -> bool {
    let trimmed = body.trim_start();
    trimmed.starts_with('{') || trimmed.starts_with('[')
}

fn pretty_json_or_raw(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| serde_json::to_string_pretty(&value).ok())
        .unwrap_or_else(|| body.to_string())
}

fn slice_lines(text: &str, offset: usize, limit: Option<usize>) -> String {
    let start = offset.saturating_sub(1);
    let iter = text.lines().skip(start);
    match limit {
        Some(limit) => iter.take(limit).collect::<Vec<_>>().join("\n"),
        None => iter.collect::<Vec<_>>().join("\n"),
    }
}

fn normalize_limit(value: Option<usize>, default: usize, max: usize) -> usize {
    value.unwrap_or(default).clamp(1, max)
}

fn truncate_chars(value: &str, max: usize) -> String {
    let mut chars = value.chars();
    let mut out = chars.by_ref().take(max).collect::<String>();
    if chars.next().is_some() {
        out.push_str("...");
    }
    out
}

fn first_nonempty<'a>(values: impl IntoIterator<Item = Option<&'a str>>) -> Option<&'a str> {
    values
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| !value.is_empty())
}

#[derive(Debug)]
struct AstCandidate {
    path: PathBuf,
    display: String,
}

#[derive(Debug)]
struct AstMatch {
    path: String,
    language: AstLanguage,
    text: String,
    byte_start: usize,
    byte_end: usize,
    start_line: usize,
    start_column: usize,
    end_line: usize,
    end_column: usize,
    meta: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone)]
struct LspSymbol {
    name: String,
    kind: String,
    file: String,
    line: usize,
    column: usize,
    depth: usize,
    preview: String,
}

#[derive(Debug, Clone)]
struct LspLocation {
    file: String,
    line: usize,
    column: usize,
    kind: String,
    preview: String,
}

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
enum AstLanguage {
    JavaScript,
    TypeScript,
    Tsx,
    Rust,
    Python,
}

impl AstLanguage {
    fn canonical_name(self) -> &'static str {
        match self {
            Self::JavaScript => "javascript",
            Self::TypeScript => "typescript",
            Self::Tsx => "tsx",
            Self::Rust => "rust",
            Self::Python => "python",
        }
    }

    fn from_path(path: &Path) -> Option<Self> {
        let ext = path.extension()?.to_str()?.to_ascii_lowercase();
        match ext.as_str() {
            "js" | "jsx" | "mjs" | "cjs" => Some(Self::JavaScript),
            "ts" | "mts" | "cts" => Some(Self::TypeScript),
            "tsx" => Some(Self::Tsx),
            "rs" => Some(Self::Rust),
            "py" | "py3" | "pyi" | "bzl" => Some(Self::Python),
            _ => None,
        }
    }
}

impl Language for AstLanguage {
    fn kind_to_id(&self, kind: &str) -> u16 {
        self.get_ts_language().id_for_node_kind(kind, true)
    }

    fn field_to_id(&self, field: &str) -> Option<u16> {
        self.get_ts_language()
            .field_id_for_name(field)
            .map(|f| f.get())
    }

    fn expando_char(&self) -> char {
        match self {
            Self::JavaScript | Self::TypeScript | Self::Tsx => '$',
            Self::Rust | Self::Python => '_',
        }
    }

    fn pre_process_pattern<'q>(&self, query: &'q str) -> Cow<'q, str> {
        match self {
            Self::JavaScript | Self::TypeScript | Self::Tsx => Cow::Borrowed(query),
            Self::Rust | Self::Python => preprocess_ast_pattern(self.expando_char(), query),
        }
    }

    fn build_pattern(
        &self,
        builder: &PatternBuilder,
    ) -> Result<Pattern, ast_grep_core::PatternError> {
        builder.build(|src| StrDoc::try_new(src, *self))
    }
}

impl LanguageExt for AstLanguage {
    fn get_ts_language(&self) -> TSLanguage {
        match self {
            Self::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Self::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Self::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Self::Rust => tree_sitter_rust::LANGUAGE.into(),
            Self::Python => tree_sitter_python::LANGUAGE.into(),
        }
    }
}

fn preprocess_ast_pattern(expando: char, query: &str) -> Cow<'_, str> {
    let mut ret = Vec::with_capacity(query.len());
    let mut dollar_count = 0;
    for ch in query.chars() {
        if ch == '$' {
            dollar_count += 1;
            continue;
        }
        let need_replace = matches!(ch, 'A'..='Z' | '_') || dollar_count == 3;
        let sigil = if need_replace { expando } else { '$' };
        ret.extend(std::iter::repeat(sigil).take(dollar_count));
        dollar_count = 0;
        ret.push(ch);
    }
    let sigil = if dollar_count == 3 { expando } else { '$' };
    ret.extend(std::iter::repeat(sigil).take(dollar_count));
    Cow::Owned(ret.into_iter().collect())
}

fn resolve_ast_language(value: &str) -> Result<AstLanguage> {
    match value.trim().to_ascii_lowercase().as_str() {
        "javascript" | "js" | "jsx" | "mjs" | "cjs" => Ok(AstLanguage::JavaScript),
        "typescript" | "ts" | "mts" | "cts" => Ok(AstLanguage::TypeScript),
        "tsx" => Ok(AstLanguage::Tsx),
        "rust" | "rs" => Ok(AstLanguage::Rust),
        "python" | "py" | "py3" | "pyi" => Ok(AstLanguage::Python),
        other => Err(anyhow!(
            "Unsupported AstGrep language '{}'. Supported: javascript, typescript, tsx, rust, python",
            other
        )),
    }
}

fn parse_ast_strictness(value: Option<&str>) -> Result<MatchStrictness> {
    match value.unwrap_or("smart").trim().to_ascii_lowercase().as_str() {
        "" | "smart" => Ok(MatchStrictness::Smart),
        "cst" => Ok(MatchStrictness::Cst),
        "ast" => Ok(MatchStrictness::Ast),
        "relaxed" => Ok(MatchStrictness::Relaxed),
        "signature" => Ok(MatchStrictness::Signature),
        "template" => Ok(MatchStrictness::Template),
        other => Err(anyhow!(
            "Unsupported AstGrep strictness '{}'. Supported: cst, smart, ast, relaxed, signature, template",
            other
        )),
    }
}

fn build_single_glob_set(pattern: &str) -> Result<globset::GlobSet> {
    let mut builder = GlobSetBuilder::new();
    let glob = GlobBuilder::new(&normalize_glob_pattern(pattern))
        .literal_separator(true)
        .build()
        .with_context(|| format!("Invalid glob pattern: {}", pattern))?;
    builder.add(glob);
    builder.build().context("Failed to build glob set")
}

fn collect_ast_candidates(
    root_path: &PathBuf,
    glob_set: Option<&globset::GlobSet>,
    include_hidden: bool,
    include_node_modules: bool,
    explicit_lang: bool,
) -> Result<Vec<AstCandidate>> {
    if root_path.is_file() {
        if !explicit_lang && AstLanguage::from_path(root_path).is_none() {
            return Ok(Vec::new());
        }
        return Ok(vec![AstCandidate {
            path: root_path.clone(),
            display: root_path.to_string_lossy().replace('\\', "/"),
        }]);
    }
    if !root_path.is_dir() {
        return Err(anyhow!(
            "Search path must be a file or directory: {}",
            root_path.display()
        ));
    }

    let mut candidates = Vec::new();
    for entry in workspace_walk(root_path, include_hidden, include_node_modules) {
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }
        if !explicit_lang && AstLanguage::from_path(entry.path()).is_none() {
            continue;
        }
        let rel = entry.path().strip_prefix(root_path).unwrap_or(entry.path());
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if glob_set.is_some_and(|glob_set| !glob_set.is_match(&rel_str)) {
            continue;
        }
        candidates.push(AstCandidate {
            path: entry.path().to_path_buf(),
            display: rel_str,
        });
    }
    candidates.sort_by(|left, right| left.display.cmp(&right.display));
    Ok(candidates)
}

fn compile_ast_pattern(
    pattern: &str,
    selector: Option<&str>,
    strictness: MatchStrictness,
    lang: AstLanguage,
) -> Result<Pattern> {
    let mut compiled =
        if let Some(selector) = selector.map(str::trim).filter(|value| !value.is_empty()) {
            Pattern::contextual(pattern, selector, lang)
        } else {
            Pattern::try_new(pattern, lang)
        }
        .map_err(|err| anyhow!("Invalid AstGrep pattern: {}", err))?;
    compiled.strictness = strictness;
    Ok(compiled)
}

fn collect_ast_matches(
    display_path: &str,
    content: &str,
    lang: AstLanguage,
    pattern: Pattern,
    include_meta: bool,
) -> Vec<AstMatch> {
    let ast = lang.ast_grep(content);
    let mut matches = Vec::new();
    for matched in ast.root().find_all(pattern.clone()) {
        let start = matched.start_pos();
        let end = matched.end_pos();
        let range = matched.range();
        let meta = if include_meta {
            let meta = HashMap::<String, String>::from(matched.get_env().clone())
                .into_iter()
                .collect::<BTreeMap<_, _>>();
            (!meta.is_empty()).then_some(meta)
        } else {
            None
        };
        matches.push(AstMatch {
            path: display_path.to_string(),
            language: lang,
            text: matched.text().into_owned(),
            byte_start: range.start,
            byte_end: range.end,
            start_line: start.line() + 1,
            start_column: start.column(matched.get_node()) + 1,
            end_line: end.line() + 1,
            end_column: end.column(matched.get_node()) + 1,
            meta,
        });
    }
    matches
}

fn collect_lsp_symbols_for_file(path: &Path, display: &str) -> Result<Vec<LspSymbol>> {
    if !path.exists() {
        return Err(anyhow!("File not found: {}", display));
    }
    let content =
        fs::read_to_string(path).with_context(|| format!("Failed to read file: {}", display))?;
    let Some(lang) = AstLanguage::from_path(path) else {
        return Ok(Vec::new());
    };
    let ast = lang.ast_grep(&content);
    let root = ast.root();
    let mut symbols = Vec::new();
    collect_lsp_symbols_from_node(
        root.get_inner_node(),
        &content,
        lang,
        display,
        0,
        &mut symbols,
    );
    symbols.sort_by(|left, right| {
        left.line
            .cmp(&right.line)
            .then_with(|| left.column.cmp(&right.column))
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(symbols)
}

fn collect_lsp_symbols_from_node(
    node: tree_sitter::Node<'_>,
    content: &str,
    lang: AstLanguage,
    display: &str,
    depth: usize,
    symbols: &mut Vec<LspSymbol>,
) {
    if let Some((name, kind, name_node)) = lsp_symbol_from_node(node, content, lang) {
        let start = name_node.start_position();
        symbols.push(LspSymbol {
            name,
            kind,
            file: display.to_string(),
            line: start.row + 1,
            column: start.column + 1,
            depth,
            preview: source_line_preview(content, start.row),
        });
    }
    let child_depth = depth + usize::from(lsp_symbol_from_node(node, content, lang).is_some());
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_lsp_symbols_from_node(child, content, lang, display, child_depth, symbols);
    }
}

fn lsp_symbol_from_node<'a>(
    node: tree_sitter::Node<'a>,
    content: &str,
    lang: AstLanguage,
) -> Option<(String, String, tree_sitter::Node<'a>)> {
    let kind = node.kind();
    let name_node = match lang {
        AstLanguage::JavaScript | AstLanguage::TypeScript | AstLanguage::Tsx => match kind {
            "function_declaration"
            | "class_declaration"
            | "method_definition"
            | "abstract_method_signature"
            | "interface_declaration"
            | "type_alias_declaration"
            | "enum_declaration" => node.child_by_field_name("name"),
            "lexical_declaration" | "variable_declaration" => node
                .named_child(0)
                .and_then(|decl| decl.child_by_field_name("name")),
            _ => None,
        },
        AstLanguage::Rust => match kind {
            "function_item" | "struct_item" | "enum_item" | "trait_item" | "impl_item"
            | "mod_item" | "type_item" | "const_item" | "static_item" | "macro_definition" => {
                node.child_by_field_name("name")
            }
            _ => None,
        },
        AstLanguage::Python => match kind {
            "function_definition" | "class_definition" => node.child_by_field_name("name"),
            _ => None,
        },
    }?;
    let name = node_text(name_node, content).trim().to_string();
    if name.is_empty() {
        return None;
    }
    Some((name, lsp_symbol_kind(kind).to_string(), name_node))
}

fn lsp_symbol_kind(kind: &str) -> &'static str {
    match kind {
        "function_declaration" | "function_definition" | "function_item" => "function",
        "method_definition" | "abstract_method_signature" => "method",
        "class_declaration" | "class_definition" => "class",
        "interface_declaration" | "trait_item" => "interface",
        "type_alias_declaration" | "type_item" => "type",
        "enum_declaration" | "enum_item" => "enum",
        "struct_item" => "struct",
        "mod_item" => "module",
        "const_item" | "static_item" => "constant",
        "macro_definition" => "macro",
        "lexical_declaration" | "variable_declaration" => "variable",
        "impl_item" => "implementation",
        _ => "symbol",
    }
}

fn find_symbol_definitions(
    symbol: &str,
    preferred_file: Option<&Path>,
    limit: usize,
) -> Result<Vec<LspLocation>> {
    let root = PathBuf::from(".");
    let mut candidates = Vec::new();
    if let Some(file) = preferred_file.filter(|file| file.exists()) {
        candidates.push(AstCandidate {
            path: file.to_path_buf(),
            display: file.to_string_lossy().replace('\\', "/"),
        });
    }
    for candidate in collect_ast_candidates(&root, None, false, false, false)? {
        if preferred_file.is_some_and(|file| equivalent_paths(file, &candidate.path)) {
            continue;
        }
        candidates.push(candidate);
    }

    let mut locations = Vec::new();
    let mut seen = BTreeSet::new();
    for candidate in candidates {
        let symbols = match collect_lsp_symbols_for_file(&candidate.path, &candidate.display) {
            Ok(symbols) => symbols,
            Err(_) => continue,
        };
        for item in symbols {
            if item.name == symbol || item.name.eq_ignore_ascii_case(symbol) {
                let key = format!("{}:{}:{}", item.file, item.line, item.column);
                if seen.insert(key) {
                    locations.push(LspLocation {
                        file: item.file,
                        line: item.line,
                        column: item.column,
                        kind: item.kind,
                        preview: item.preview,
                    });
                    if locations.len() >= limit {
                        return Ok(locations);
                    }
                }
            }
        }
    }
    Ok(locations)
}

fn find_text_occurrences(
    symbol: &str,
    preferred_file: Option<&Path>,
    limit: usize,
) -> Result<Vec<LspLocation>> {
    let root = PathBuf::from(".");
    let mut candidates = Vec::new();
    if let Some(file) = preferred_file.filter(|file| file.exists()) {
        candidates.push(AstCandidate {
            path: file.to_path_buf(),
            display: file.to_string_lossy().replace('\\', "/"),
        });
    }
    for candidate in collect_ast_candidates(&root, None, false, false, false)? {
        if preferred_file.is_some_and(|file| equivalent_paths(file, &candidate.path)) {
            continue;
        }
        candidates.push(candidate);
    }
    let mut locations = Vec::new();
    let mut seen = BTreeSet::new();
    for candidate in candidates {
        let Ok(content) = fs::read_to_string(&candidate.path) else {
            continue;
        };
        for (line_idx, line) in content.lines().enumerate() {
            for column in symbol_occurrence_columns(line, symbol) {
                let key = format!("{}:{}:{}", candidate.display, line_idx + 1, column);
                if seen.insert(key) {
                    locations.push(LspLocation {
                        file: candidate.display.clone(),
                        line: line_idx + 1,
                        column,
                        kind: "text".to_string(),
                        preview: truncate_chars(line.trim(), 160),
                    });
                    if locations.len() >= limit {
                        return Ok(locations);
                    }
                }
            }
        }
    }
    Ok(locations)
}

fn symbol_occurrence_columns(line: &str, symbol: &str) -> Vec<usize> {
    if symbol.is_empty() {
        return Vec::new();
    }
    let mut columns = Vec::new();
    let mut search_from = 0usize;
    while let Some(relative) = line[search_from..].find(symbol) {
        let start = search_from + relative;
        let end = start + symbol.len();
        let before = line[..start].chars().next_back();
        let after = line[end..].chars().next();
        if !before.is_some_and(is_identifier_char) && !after.is_some_and(is_identifier_char) {
            columns.push(start + 1);
        }
        search_from = end;
    }
    columns
}

fn resolve_lsp_symbol(input: &LspInput) -> Result<String> {
    if let Some(symbol) = input
        .symbol
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(symbol
            .split_once('#')
            .map(|(name, _)| name)
            .unwrap_or(symbol)
            .to_string());
    }
    let file = required_lsp_file(input)?;
    let line_number = input.line.unwrap_or(1);
    let content =
        fs::read_to_string(&file).with_context(|| format!("Failed to read file: {}", file))?;
    let line = content
        .lines()
        .nth(line_number.saturating_sub(1))
        .ok_or_else(|| anyhow!("Line {} is out of range for {}", line_number, file))?;
    first_identifier_on_line(line)
        .map(str::to_string)
        .ok_or_else(|| {
            anyhow!(
                "No symbol provided and no identifier found on {}:{}",
                file,
                line_number
            )
        })
}

fn required_lsp_file(input: &LspInput) -> Result<String> {
    input
        .file
        .as_deref()
        .map(str::trim)
        .filter(|file| !file.is_empty() && *file != "*")
        .map(str::to_string)
        .ok_or_else(|| anyhow!("Lsp action {} requires file", input.action))
}

fn first_identifier_on_line(line: &str) -> Option<&str> {
    let mut start = None;
    for (idx, ch) in line.char_indices() {
        if start.is_none() {
            if is_identifier_start(ch) {
                start = Some(idx);
            }
            continue;
        }
        if !is_identifier_char(ch) {
            return line.get(start?..idx);
        }
    }
    start.and_then(|idx| line.get(idx..))
}

fn node_text<'a>(node: tree_sitter::Node<'_>, content: &'a str) -> &'a str {
    node.utf8_text(content.as_bytes()).unwrap_or("")
}

fn source_line_preview(content: &str, zero_based_row: usize) -> String {
    truncate_chars(
        content.lines().nth(zero_based_row).unwrap_or("").trim(),
        160,
    )
}

fn tree_has_error(node: tree_sitter::Node<'_>) -> bool {
    if node.is_error() || node.is_missing() {
        return true;
    }
    let mut cursor = node.walk();
    let has_error = node.children(&mut cursor).any(tree_has_error);
    has_error
}

fn looks_like_glob(value: &str) -> bool {
    value.contains('*') || value.contains('?') || value.contains('[')
}

fn is_identifier_start(ch: char) -> bool {
    ch == '_' || ch == '$' || ch.is_ascii_alphabetic()
}

fn is_identifier_char(ch: char) -> bool {
    is_identifier_start(ch) || ch.is_ascii_digit()
}

fn equivalent_paths(left: &Path, right: &Path) -> bool {
    let left = left.canonicalize().unwrap_or_else(|_| left.to_path_buf());
    let right = right.canonicalize().unwrap_or_else(|_| right.to_path_buf());
    left == right
}

fn command_available(command: &str) -> bool {
    if command.contains(std::path::MAIN_SEPARATOR) {
        return Path::new(command).is_file();
    }
    env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| env::split_paths(&paths).collect::<Vec<_>>())
        .any(|dir| dir.join(command).is_file())
}

fn detect_lsp_candidates(root: &Path) -> Vec<String> {
    let mut candidates = Vec::new();
    for (name, command, markers) in [
        ("rust-analyzer", "rust-analyzer", vec!["Cargo.toml"]),
        (
            "typescript-language-server",
            "typescript-language-server",
            vec!["tsconfig.json", "package.json"],
        ),
        (
            "pyright",
            "pyright-langserver",
            vec!["pyproject.toml", "requirements.txt", "setup.py"],
        ),
        ("gopls", "gopls", vec!["go.mod"]),
    ] {
        if markers.iter().any(|marker| root.join(marker).exists()) {
            let availability = if command_available(command) {
                "available"
            } else {
                "not on PATH"
            };
            candidates.push(format!("{} ({})", name, availability));
        }
    }
    candidates
}

fn reject_overlapping_matches(matches: &[AstMatch]) -> Result<()> {
    let mut previous_end = None;
    for item in matches {
        if previous_end.is_some_and(|end| item.byte_start < end) {
            return Err(anyhow!(
                "Overlapping replacements detected; refine pattern to avoid ambiguous edits"
            ));
        }
        previous_end = Some(item.byte_end);
    }
    Ok(())
}

fn reject_overlapping_line_ranges(matches: &[AstMatch]) -> Result<()> {
    let mut previous_end_line = None;
    for item in matches {
        if previous_end_line.is_some_and(|end| item.start_line <= end) {
            return Err(anyhow!(
                "Multiple replacements map to the same line range; refine pattern to avoid ambiguous edits"
            ));
        }
        previous_end_line = Some(item.end_line);
    }
    Ok(())
}

fn ast_edit_replacement_lines(
    item: &AstMatch,
    lines: &[String],
    line_ranges: &[(usize, usize)],
    replacement: &str,
) -> Result<Vec<String>> {
    let start_index = item
        .start_line
        .checked_sub(1)
        .ok_or_else(|| anyhow!("AST match line numbers must be 1-based"))?;
    let end_index = item
        .end_line
        .checked_sub(1)
        .ok_or_else(|| anyhow!("AST match line numbers must be 1-based"))?;
    let start_line = lines.get(start_index).ok_or_else(|| {
        anyhow!(
            "AST match start line {} exceeds source line count {}",
            item.start_line,
            lines.len()
        )
    })?;
    let end_line = lines.get(end_index).ok_or_else(|| {
        anyhow!(
            "AST match end line {} exceeds source line count {}",
            item.end_line,
            lines.len()
        )
    })?;
    let (start_line_byte_start, _) = *line_ranges
        .get(start_index)
        .ok_or_else(|| anyhow!("Missing start line byte range"))?;
    let (_, end_line_byte_end) = *line_ranges
        .get(end_index)
        .ok_or_else(|| anyhow!("Missing end line byte range"))?;
    if item.byte_start < start_line_byte_start || item.byte_end > end_line_byte_end {
        return Err(anyhow!(
            "AST match byte range does not map cleanly to its line range"
        ));
    }
    let prefix_end = item.byte_start - start_line_byte_start;
    let suffix_start = item.byte_end - line_ranges[end_index].0;
    if !start_line.is_char_boundary(prefix_end) || !end_line.is_char_boundary(suffix_start) {
        return Err(anyhow!(
            "AST match byte range does not align to UTF-8 character boundaries"
        ));
    }

    let prefix = &start_line[..prefix_end];
    let suffix = &end_line[suffix_start..];
    let replacement = normalize_text(replacement);
    let mut replacement_lines = split_patch_body_lines(&replacement);
    if replacement_lines.is_empty() {
        let preserved = format!("{prefix}{suffix}");
        return Ok((!preserved.is_empty())
            .then_some(preserved)
            .into_iter()
            .collect());
    }

    if let Some(first) = replacement_lines.first_mut() {
        first.insert_str(0, prefix);
    }
    if let Some(last) = replacement_lines.last_mut() {
        last.push_str(suffix);
    }
    Ok(replacement_lines)
}

fn split_patch_body_lines(content: &str) -> Vec<String> {
    if content.is_empty() {
        return Vec::new();
    }
    let body = content.strip_suffix('\n').unwrap_or(content);
    if body.is_empty() {
        Vec::new()
    } else {
        body.split('\n').map(str::to_string).collect()
    }
}

fn first_line_preview(value: &str) -> String {
    truncate_chars(value.lines().next().unwrap_or(""), 120)
}

fn render_ast_grep_output(
    matches: &[AstMatch],
    total_matches: usize,
    files_with_matches: usize,
    files_searched: usize,
    limit_reached: bool,
    parse_errors: &[String],
) -> String {
    let mut out = Vec::new();
    out.push(format!(
        "AstGrep: {} match(es) in {} file(s); searched {} file(s)",
        total_matches, files_with_matches, files_searched
    ));
    out.push(String::new());

    if matches.is_empty() {
        out.push("No matches found".to_string());
    } else {
        let mut current_path = "";
        for item in matches {
            if current_path != item.path {
                if !current_path.is_empty() {
                    out.push(String::new());
                }
                current_path = &item.path;
                out.push(format!(
                    "[{}:{}]",
                    item.path,
                    item.language.canonical_name()
                ));
            }
            let mut lines = item.text.lines();
            let first = lines.next().unwrap_or("");
            out.push(format!(
                "*{}:{}-{}:{} bytes {}..{} | {}",
                item.start_line,
                item.start_column,
                item.end_line,
                item.end_column,
                item.byte_start,
                item.byte_end,
                first
            ));
            for line in lines.take(12) {
                out.push(format!(" {}", line));
            }
            if item.text.lines().count() > 13 {
                out.push(" [match text truncated]".to_string());
            }
            if let Some(meta) = &item.meta {
                let meta_line = meta
                    .iter()
                    .map(|(key, value)| format!("{}={}", key, truncate_chars(value, 120)))
                    .collect::<Vec<_>>()
                    .join(", ");
                out.push(format!(" meta: {}", meta_line));
            }
        }
    }
    if limit_reached {
        out.push(String::new());
        out.push("Result limit reached; narrow path/glob or increase limit.".to_string());
    }
    if !parse_errors.is_empty() {
        out.push(String::new());
        out.push(format!("Parse/compile issues ({}):", parse_errors.len()));
        for error in parse_errors.iter().take(20) {
            out.push(format!("- {}", error));
        }
        if parse_errors.len() > 20 {
            out.push(format!("- ... {} more issue(s)", parse_errors.len() - 20));
        }
    }
    out.push(String::new());
    out.join("\n")
}

fn normalize_fuzzy_text(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

fn fuzzy_score(query: &str, candidate: &str) -> Option<i64> {
    let candidate_norm = normalize_fuzzy_text(candidate);
    if candidate_norm.is_empty() {
        return None;
    }
    if candidate_norm == query {
        return Some(10_000 - candidate_norm.len() as i64);
    }
    if candidate_norm.starts_with(query) {
        return Some(8_000 - candidate_norm.len() as i64);
    }
    if let Some(index) = candidate_norm.find(query) {
        return Some(6_000 - index as i64 - candidate_norm.len() as i64);
    }

    let mut score = 0_i64;
    let mut last_index: Option<usize> = None;
    let mut search_from = 0_usize;
    for ch in query.chars() {
        let slice = &candidate_norm[search_from..];
        let Some(relative) = slice.find(ch) else {
            return None;
        };
        let index = search_from + relative;
        score += if last_index.is_some_and(|last| last + 1 == index) {
            15
        } else {
            5
        };
        if index == 0
            || candidate_norm
                .as_bytes()
                .get(index.saturating_sub(1))
                .is_some_and(|byte| matches!(*byte, b'/' | b'-' | b'_'))
        {
            score += 10;
        }
        last_index = Some(index);
        search_from = index + ch.len_utf8();
    }
    Some(score - candidate_norm.len() as i64)
}

#[derive(Debug)]
struct HashlineSection {
    path: String,
    tag: String,
    edits: Vec<HashlineEdit>,
}

#[derive(Debug)]
enum HashlineEdit {
    Swap {
        start: usize,
        end: usize,
        body: Vec<String>,
    },
    Delete {
        start: usize,
        end: usize,
    },
    Insert {
        cursor: InsertCursor,
        body: Vec<String>,
    },
}

#[derive(Debug)]
enum InsertCursor {
    Head,
    Tail,
    Before(usize),
    After(usize),
}

impl HashlineEdit {
    fn anchor_index(&self) -> usize {
        match self {
            Self::Swap { start, .. } | Self::Delete { start, .. } => *start,
            Self::Insert { cursor, .. } => match cursor {
                InsertCursor::Head => 0,
                InsertCursor::Tail => usize::MAX,
                InsertCursor::Before(line) | InsertCursor::After(line) => *line,
            },
        }
    }
}

fn parse_hashline_patch(raw: &str) -> Result<HashlineSection> {
    let mut lines = raw.lines().peekable();
    let header = lines
        .by_ref()
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| anyhow!("Hashline patch is empty"))?
        .trim();
    let (path, tag) = parse_hashline_header(header)?;
    let mut edits = Vec::new();
    while let Some(line) = lines.next() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('[') {
            return Err(anyhow!(
                "EditHashline currently accepts one file section per call"
            ));
        }
        if let Some(spec) = trimmed.strip_prefix("SWAP ") {
            let spec = spec
                .strip_suffix(':')
                .ok_or_else(|| anyhow!("SWAP operation must end with ':'"))?;
            let (start, end) = parse_line_range(spec)?;
            let body = parse_plus_body(&mut lines);
            edits.push(HashlineEdit::Swap { start, end, body });
        } else if let Some(spec) = trimmed.strip_prefix("DEL ") {
            let (start, end) = parse_line_range(spec)?;
            edits.push(HashlineEdit::Delete { start, end });
        } else if trimmed == "INS.HEAD:" {
            let body = parse_plus_body(&mut lines);
            edits.push(HashlineEdit::Insert {
                cursor: InsertCursor::Head,
                body,
            });
        } else if trimmed == "INS.TAIL:" {
            let body = parse_plus_body(&mut lines);
            edits.push(HashlineEdit::Insert {
                cursor: InsertCursor::Tail,
                body,
            });
        } else if let Some(spec) = trimmed.strip_prefix("INS.PRE ") {
            let line = parse_line_cursor(spec)?;
            let body = parse_plus_body(&mut lines);
            edits.push(HashlineEdit::Insert {
                cursor: InsertCursor::Before(line),
                body,
            });
        } else if let Some(spec) = trimmed.strip_prefix("INS.POST ") {
            let line = parse_line_cursor(spec)?;
            let body = parse_plus_body(&mut lines);
            edits.push(HashlineEdit::Insert {
                cursor: InsertCursor::After(line),
                body,
            });
        } else {
            return Err(anyhow!("Unsupported hashline operation: {}", trimmed));
        }
    }
    if edits.is_empty() {
        return Err(anyhow!("Hashline patch contains no edits"));
    }
    Ok(HashlineSection { path, tag, edits })
}

fn parse_hashline_header(header: &str) -> Result<(String, String)> {
    let inner = header
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .ok_or_else(|| anyhow!("Hashline patch must start with [path#tag]"))?;
    let (path, tag) = inner
        .rsplit_once('#')
        .ok_or_else(|| anyhow!("Hashline section header must include #tag"))?;
    if path.is_empty() || tag.is_empty() {
        return Err(anyhow!(
            "Hashline section header requires non-empty path and tag"
        ));
    }
    Ok((path.to_string(), tag.to_string()))
}

fn parse_line_range(spec: &str) -> Result<(usize, usize)> {
    let (start, end) = spec
        .split_once(".=")
        .ok_or_else(|| anyhow!("Expected line range A.=B, got {}", spec))?;
    let start = parse_positive_usize(start)?;
    let end = parse_positive_usize(end)?;
    if start > end {
        return Err(anyhow!("Line range start {} is after end {}", start, end));
    }
    Ok((start, end))
}

fn parse_line_cursor(spec: &str) -> Result<usize> {
    let spec = spec
        .strip_suffix(':')
        .ok_or_else(|| anyhow!("Insert operation must end with ':'"))?;
    parse_positive_usize(spec)
}

fn parse_positive_usize(raw: &str) -> Result<usize> {
    let value = raw
        .trim()
        .parse::<usize>()
        .with_context(|| format!("Invalid line number: {}", raw))?;
    if value == 0 {
        return Err(anyhow!("Line numbers are 1-based"));
    }
    Ok(value)
}

fn parse_plus_body<'a, I>(lines: &mut std::iter::Peekable<I>) -> Vec<String>
where
    I: Iterator<Item = &'a str>,
{
    let mut body = Vec::new();
    while let Some(line) = lines.peek().copied() {
        if let Some(rest) = line.strip_prefix('+') {
            body.push(rest.to_string());
            lines.next();
        } else if line.trim().is_empty() {
            lines.next();
        } else {
            break;
        }
    }
    body
}

fn apply_hashline_edit(
    lines: &mut Vec<String>,
    original_line_count: usize,
    edit: HashlineEdit,
) -> Result<()> {
    match edit {
        HashlineEdit::Swap { start, end, body } => {
            ensure_original_range(start, end, original_line_count)?;
            lines.splice((start - 1)..end, body);
        }
        HashlineEdit::Delete { start, end } => {
            ensure_original_range(start, end, original_line_count)?;
            lines.drain((start - 1)..end);
        }
        HashlineEdit::Insert { cursor, body } => {
            let idx = match cursor {
                InsertCursor::Head => 0,
                InsertCursor::Tail => original_line_count,
                InsertCursor::Before(line) => {
                    ensure_original_cursor(line, original_line_count)?;
                    line - 1
                }
                InsertCursor::After(line) => {
                    ensure_original_cursor(line, original_line_count)?;
                    line
                }
            };
            if idx > lines.len() {
                return Err(anyhow!("Insert cursor no longer maps to the edited file"));
            }
            lines.splice(idx..idx, body);
        }
    }
    Ok(())
}

fn ensure_original_range(start: usize, end: usize, original_line_count: usize) -> Result<()> {
    if end > original_line_count {
        return Err(anyhow!(
            "Line range {}.={} exceeds file length {}",
            start,
            end,
            original_line_count
        ));
    }
    Ok(())
}

fn ensure_original_cursor(line: usize, original_line_count: usize) -> Result<()> {
    if line > original_line_count {
        return Err(anyhow!(
            "Line cursor {} exceeds file length {}",
            line,
            original_line_count
        ));
    }
    Ok(())
}

fn validate_edit_ranges(edits: &[HashlineEdit], original_line_count: usize) -> Result<()> {
    let mut ranges: Vec<(usize, usize, &str)> = Vec::new();

    for edit in edits {
        match edit {
            HashlineEdit::Swap { start, end, .. } => {
                ranges.push((*start, *end, "SWAP"));
            }
            HashlineEdit::Delete { start, end } => {
                ranges.push((*start, *end, "DEL"));
            }
            HashlineEdit::Insert { cursor, .. } => {
                let idx = match cursor {
                    InsertCursor::Head => 1,
                    InsertCursor::Tail => original_line_count + 1,
                    InsertCursor::Before(line) => *line,
                    InsertCursor::After(line) => *line + 1,
                };
                ranges.push((idx, idx, "INS"));
            }
        }
    }

    // Check for overlaps: ranges sorted by anchor_index (descending in caller), check adjacent pairs
    ranges.sort_by_key(|(start, _, _)| *start);
    for window in ranges.windows(2) {
        let (start1, end1, op1) = window[0];
        let (start2, end2, op2) = window[1];

        // Check if ranges overlap (accounting for insert-at-boundary edge cases)
        if op1 == "INS" && op2 == "INS" && start1 == start2 {
            // Multiple inserts at same position is OK (they stack)
            continue;
        }

        // For non-insert or mixed operations, check strict overlap
        if start2 < end1 {
            return Err(anyhow!(
                "Overlapping edits detected: {} at {}.={} overlaps with {} at {}.={}",
                op1, start1, end1, op2, start2, end2
            ));
        }
    }

    Ok(())
}

fn normalize_text(content: &str) -> String {
    content.replace("\r\n", "\n").replace('\r', "\n")
}

fn preferred_line_ending(content: &str) -> &'static str {
    if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

fn split_normalized_lines(content: &str) -> (Vec<String>, bool) {
    let trailing_newline = content.ends_with('\n');
    let body = if trailing_newline {
        &content[..content.len().saturating_sub(1)]
    } else {
        content
    };
    let lines = if body.is_empty() {
        Vec::new()
    } else {
        body.split('\n').map(str::to_string).collect()
    };
    (lines, trailing_newline)
}

fn normalized_line_ranges(lines: &[String]) -> Vec<(usize, usize)> {
    let mut ranges = Vec::with_capacity(lines.len());
    let mut cursor = 0usize;
    for line in lines {
        let start = cursor;
        let end = start + line.len();
        ranges.push((start, end));
        cursor = end + 1;
    }
    ranges
}

fn join_lines(lines: &[String], trailing_newline: bool) -> String {
    let mut out = lines.join("\n");
    if trailing_newline {
        out.push('\n');
    }
    out
}

fn stable_hash_hex(input: &str, chars: usize) -> String {
    let mut hasher = Fnv1a64::default();
    hasher.write(input.as_bytes());
    let full = format!("{:016x}", hasher.finish());
    full.chars().take(chars.min(full.len())).collect()
}

struct Fnv1a64(u64);

impl Default for Fnv1a64 {
    fn default() -> Self {
        Self(0xcbf29ce484222325)
    }
}

impl Hasher for Fnv1a64 {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 ^= u64::from(*byte);
            self.0 = self.0.wrapping_mul(0x100000001b3);
        }
    }
}
