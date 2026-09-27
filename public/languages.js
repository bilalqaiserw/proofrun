const extensions = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin",
  cs: "C#",
  rb: "Ruby",
  php: "PHP",
  c: "C",
  cpp: "C++",
  cc: "C++",
  swift: "Swift",
  scala: "Scala",
  sql: "SQL",
  html: "HTML",
  htm: "HTML",
  css: "CSS",
  scss: "SCSS",
  sh: "Shell",
  bash: "Shell",
  ps1: "PowerShell",
  dart: "Dart",
  astro: "Astro templates",
  vue: "Vue templates",
  svelte: "Svelte templates",
};
export function sourceLanguages(files) {
  const counts = new Map();
  for (const file of files) {
    if (file.binary) continue;
    const name = extensions[file.path.split(".").at(-1).toLowerCase()];
    if (!name) continue;
    const item = counts.get(name) || { name, files: 0, examples: [] };
    item.files++;
    if (item.examples.length < 3) item.examples.push(file.path);
    counts.set(name, item);
  }
  return [...counts.values()].sort(
    (a, b) => b.files - a.files || a.name.localeCompare(b.name),
  );
}
