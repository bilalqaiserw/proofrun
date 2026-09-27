export function allowedWorkspacePath(path) {
  return typeof path === 'string' && (
    /^(status|projects)(\/[-a-zA-Z0-9]+)*$/.test(path) ||
    /^projects\/[0-9a-f-]{36}\/artifact\/[a-z0-9-]+\.png$/.test(path)
  );
}
