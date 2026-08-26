/**
 * The only shape allowed in `metadata` bags that cross a trust boundary
 * (registry files, plugin manifests, API payloads). Structured cloning and
 * `JSON.stringify` are both total over this type, so a metadata bag can never
 * carry a function, a class instance, or a cycle into a registry.
 */
export type SafeJsonValue = string | number | boolean | null | SafeJsonValue[] | { [key: string]: SafeJsonValue };

const MAX_DEPTH = 8;

/** Depth-bounded so a hostile registry cannot blow the stack during validation. */
export function isSafeJsonValue(value: unknown, depth = 0): value is SafeJsonValue {
  if (depth > MAX_DEPTH) return false;
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return true;
  if (type === 'number') return Number.isFinite(value as number);
  if (Array.isArray(value)) return value.every((entry) => isSafeJsonValue(entry, depth + 1));
  if (type !== 'object') return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value as Record<string, unknown>).every((entry) => isSafeJsonValue(entry, depth + 1));
}

export function isSafeMetadata(value: unknown): value is Record<string, SafeJsonValue> {
  return value === undefined || (isSafeJsonValue(value) && typeof value === 'object' && value !== null && !Array.isArray(value));
}
