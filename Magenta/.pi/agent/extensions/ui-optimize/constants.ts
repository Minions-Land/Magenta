export const MARKDOWN_PATCH = Symbol.for("local.ui-optimize.markdown.patch");
export const TOOL_EXECUTION_GROUP_PATCH = Symbol.for("local.ui-optimize.tool-execution.group.patch");
export const ASSISTANT_SEPARATOR_PATCH = Symbol.for("local.ui-optimize.assistant-separator.patch");
export const CONTAINER_PARENT_PATCH = Symbol.for("local.ui-optimize.container-parent.patch");
export const COMPONENT_PARENT = Symbol.for("local.ui-optimize.component-parent");

export const CLIPBOARD_PATH_RE = /(?:[^\s"'`<>]+[\\/])?pi-clipboard-[0-9a-f-]+\.(?:png|jpe?g|webp|gif)/gi;
export const IMAGE_FILE_RE = /\.(?:png|jpe?g|webp|gif)$/i;
export const TOKEN_RE = /\[image(\d+)\]/g;
export const TOKEN_LINE_RE = /\[image\d+\]/g;

export const MACOS_CLIPBOARD_FILE_PATHS_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('Foundation');
const pb = $.NSPasteboard.generalPasteboard;
const classes = $.NSArray.arrayWithObject($.NSURL);
const options = $.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true), $.NSPasteboardURLReadingFileURLsOnlyKey);
const urls = pb.readObjectsForClassesOptions(classes, options);
const paths = [];
if (urls) {
  for (let i = 0; i < urls.count; i++) {
    const url = urls.objectAtIndex(i);
    if (url.isFileURL) paths.push(ObjC.unwrap(url.path));
  }
}
JSON.stringify(paths);
`;
