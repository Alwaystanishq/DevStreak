function isIgnored(relativePath, ignoredFolders) {
  const folders = relativePath.replace(/\\/g, "/").split("/").slice(0, -1);
  const directory = "/" + folders.join("/") + "/";
  return ignoredFolders.some((entry) => {
    if (typeof entry !== "string") return false;
    const value = entry.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    return value.length > 0 && directory.includes("/" + value + "/");
  });
}

/** @param {typeof import('vscode')} vscode
 * @param {import('vscode').TextDocument | undefined} document
 * @param {string[]} ignoredFolders */
function documentContext(vscode, document, ignoredFolders) {
  if (!document || !["file", "vscode-remote", "untitled"].includes(document.uri.scheme)) {
    return { eligible: false, projectId: "", projectName: "" };
  }
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const uriPath = document.uri.path;
  const relativePath = folder
    ? uriPath.slice(folder.uri.path.replace(/\/$/, "").length + 1)
    : uriPath;
  return {
    eligible: !isIgnored(relativePath, ignoredFolders),
    projectId: folder ? folder.uri.toString() : "unassigned",
    projectName: folder ? folder.name : "Other files",
    languageId: document.languageId || "unknown",
    file: { id: document.uri.toString(), path: relativePath || document.fileName },
  };
}

module.exports = { isIgnored, documentContext };
