const OPENAPI_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

export function filterChatOpenApiDocument(document: unknown, allowAdmin = false): unknown {
  if (!isRecord(document) || !isRecord(document.paths)) {
    return document;
  }

  const filteredPaths: Record<string, unknown> = {};
  for (const [operationPath, rawPathItem] of Object.entries(document.paths)) {
    if (pathContainsRestrictedSegment(operationPath, allowAdmin)) {
      continue;
    }
    if (!isRecord(rawPathItem)) {
      filteredPaths[operationPath] = rawPathItem;
      continue;
    }

    const filteredPathItem = { ...rawPathItem };
    let operationCount = 0;
    let allowedOperationCount = 0;
    for (const method of OPENAPI_METHODS) {
      if (!(method in rawPathItem)) {
        continue;
      }
      operationCount += 1;
      const operation = rawPathItem[method];
      if (
        !isRecord(operation) ||
        !isChatOpenApiOperationAllowed(operationPath, operation, allowAdmin)
      ) {
        delete filteredPathItem[method];
        continue;
      }
      allowedOperationCount += 1;
    }

    if (operationCount === 0 || allowedOperationCount > 0) {
      filteredPaths[operationPath] = filteredPathItem;
    }
  }

  return {
    ...document,
    paths: filteredPaths,
  };
}

export function isChatOpenApiOperationAllowed(
  operationPath: string,
  operation: Record<string, unknown>,
  allowAdmin = false,
): boolean {
  if (pathContainsRestrictedSegment(operationPath, allowAdmin)) {
    return false;
  }
  if (
    Array.isArray(operation.tags) &&
    operation.tags.some(
      (tag) => typeof tag === "string" && containsRestrictedToken(tag, allowAdmin),
    )
  ) {
    return false;
  }
  return !containsRestrictedToken(operation.operationId, allowAdmin);
}

function pathContainsRestrictedSegment(operationPath: string, allowAdmin: boolean): boolean {
  return operationPath.split("/").some((segment) => {
    try {
      return containsRestrictedToken(decodeURIComponent(segment), allowAdmin);
    } catch {
      return containsRestrictedToken(segment, allowAdmin);
    }
  });
}

function containsRestrictedToken(value: unknown, allowAdmin: boolean): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .some((token) => {
      const normalized = token.toLowerCase();
      return (!allowAdmin && normalized === "admin") || normalized === "internal";
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
