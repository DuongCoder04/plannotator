import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type HostReferences = { references: string[]; errors: string[] };

type JsonRead =
  | { kind: "missing" }
  | { kind: "value"; value: unknown }
  | { kind: "error"; message: string };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function readJson(file: string, field: string): JsonRead {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (missing(error)) return { kind: "missing" };
    return { kind: "error", message: `Could not inspect ${file}, ${field}; make the file readable before retrying.` };
  }
  try {
    return { kind: "value", value: JSON.parse(text) };
  } catch {
    return { kind: "error", message: `Could not inspect ${file}, ${field}; repair its invalid JSON before retrying.` };
  }
}

function objectFile(file: string, field: string): HostReferences & { value: Record<string, unknown> | null } {
  const read = readJson(file, field);
  if (read.kind === "missing") return { references: [], errors: [], value: null };
  if (read.kind === "error") return { references: [], errors: [read.message], value: null };
  const value = record(read.value);
  return {
    references: [],
    errors: value ? [] : [`Could not inspect ${file}, ${field}; expected a JSON object. Repair it before retrying.`],
    value,
  };
}

export function enabledPluginReferences(file: string, id: string): HostReferences {
  const field = `enabledPlugins[${JSON.stringify(id)}]`;
  const read = objectFile(file, field);
  const enabled = record(read.value?.enabledPlugins);
  return { references: enabled?.[id] === true ? [`${file}, ${field}`] : [], errors: read.errors };
}

export function pluginReferences(directory: string, id: string): HostReferences {
  const enabled = enabledPluginReferences(join(directory, "settings.json"), id);
  const file = join(directory, "plugins", "installed_plugins.json");
  const field = `plugins[${JSON.stringify(id)}]`;
  const installed = objectFile(file, field);
  const entries = record(installed.value?.plugins)?.[id];
  return {
    references: [...enabled.references, ...(Array.isArray(entries) && entries.length ? [`${file}, ${field}`] : [])],
    errors: [...enabled.errors, ...installed.errors],
  };
}

export function piPackageReferences(file: string): HostReferences {
  const read = objectFile(file, "packages");
  const packages = read.value?.packages;
  return {
    errors: read.errors,
    references: Array.isArray(packages) ? packages.flatMap((entry: unknown, index) => {
      const source = typeof entry === "string" ? entry : record(entry)?.source;
      return typeof source === "string" && /^npm:@plannotator\/pi-extension(?:@|$)/.test(source)
        ? [`${file}, packages[${index}]${typeof entry === "string" ? "" : ".source"}`]
        : [];
    }) : [],
  };
}

export function directoryReferences(directory: string, prefix: string): HostReferences {
  try {
    return {
      references: readdirSync(directory).filter((entry) => entry.startsWith(prefix)).map((entry) => join(directory, entry)),
      errors: [],
    };
  } catch (error) {
    return {
      references: [],
      errors: missing(error) ? [] : [`Could not inspect ${directory}; make the directory readable before retrying.`],
    };
  }
}

/** VS Code can unregister an extension while leaving its files for later cleanup. */
export function vscodeReferences(directory: string): HostReferences {
  const id = "backnotprop.plannotator-webview";
  const file = join(directory, "extensions.json");
  const registry = readJson(file, "extension registrations");
  if (registry.kind === "error") return { references: [], errors: [registry.message] };
  if (registry.kind === "value") {
    if (!Array.isArray(registry.value)) {
      return { references: [], errors: [`Could not inspect ${file}; expected an extension registration array. Repair it before retrying.`] };
    }
    return {
      references: registry.value.flatMap((entry: unknown, index) => {
        const identifier = record(record(entry)?.identifier)?.id;
        return typeof identifier === "string" && identifier.toLowerCase() === id
          ? [`${file}, [${index}].identifier.id (${id})`]
          : [];
      }),
      errors: [],
    };
  }
  // Older installations may not have a registration index. Honor their removal markers.
  const directories = directoryReferences(directory, `${id}-`);
  if (directories.references.length === 0) return directories;
  const obsolete = objectFile(join(directory, ".obsolete"), "removed extensions");
  return {
    references: directories.references.filter((path) => obsolete.value?.[path.slice(directory.length + 1)] !== true),
    errors: [...directories.errors, ...obsolete.errors],
  };
}
