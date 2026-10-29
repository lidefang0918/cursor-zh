export { detectCursor } from './detect.js';
export { createBackup, sha256File } from './backup.js';
export { restoreBackup, dropBackup } from './restore.js';
export { loadAnchors, loadDict, loadPatterns } from './anchors.js';
export { applyPatch, applyFragments, filesToBackup, vscodeChecksum, updateChecksums } from './patch.js';
export * from './langpack.js';
export { injectDomRuntime, buildInjection, stripInjection } from './inject.js';
export { localize, revert, status, defaultPaths, readState } from './localize.js';
