/**
 * Only plain JSON data may enter an approval digest. Silently dropping or
 * coercing a value would sign something different from what the kernel sees.
 */
export function assertJsonStable(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || value === null) {
    throw new TypeError("approval digest must contain only JSON-stable values");
  }
  assertJsonContainer(value, ancestors);
  ancestors.add(value);
  try {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (Array.isArray(value) && key === "length") continue;
      assertJsonProperty(descriptor, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function assertJsonContainer(value: object, ancestors: Set<object>): void {
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  const plain = array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null;
  if (!plain || ancestors.has(value)) {
    throw new TypeError("approval digest must contain plain, acyclic JSON data");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("approval digest cannot contain symbol keys");
  }
  const keys = Object.keys(value);
  if (array && (keys.length !== value.length || keys.some((key, index) => key !== String(index)))) {
    throw new TypeError("approval digest cannot contain sparse or extended arrays");
  }
}

function assertJsonProperty(descriptor: PropertyDescriptor, ancestors: Set<object>): void {
  if (!descriptor.enumerable || !("value" in descriptor)) {
    throw new TypeError("approval digest cannot contain hidden properties or accessors");
  }
  assertJsonStable(descriptor.value, ancestors);
}
