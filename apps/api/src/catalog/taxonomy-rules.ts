import { MAX_CATEGORY_DEPTH } from '@hamro-pasal/shared-types';

/** The two columns that make the taxonomy a tree. */
export interface TaxonomyNode {
  readonly id: string;
  readonly parent_id: string | null;
}

export type PlacementProblem = 'PARENT_NOT_FOUND' | 'CYCLE' | 'TOO_DEEP';

/** Levels from the root down to `id` (a root is 1). */
export function depthOf(nodes: ReadonlyMap<string, TaxonomyNode>, id: string): number {
  let depth = 0;
  let current: string | null = id;
  // Bounded by the node count, so stored bad data (a cycle) cannot loop forever.
  while (current !== null && depth <= nodes.size) {
    depth += 1;
    current = nodes.get(current)?.parent_id ?? null;
  }
  return depth;
}

/** Levels in the subtree rooted at `id`, itself included (a leaf is 1). */
export function heightOf(nodes: ReadonlyMap<string, TaxonomyNode>, id: string): number {
  const children = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (node.parent_id === null) continue;
    const siblings = children.get(node.parent_id);
    if (siblings === undefined) children.set(node.parent_id, [node.id]);
    else siblings.push(node.id);
  }
  const height = (nodeId: string, seen: ReadonlySet<string>): number =>
    1 +
    Math.max(
      0,
      ...(children.get(nodeId) ?? [])
        .filter((child) => !seen.has(child))
        .map((child) => height(child, new Set([...seen, child]))),
    );
  return height(id, new Set([id]));
}

/**
 * Why a category may not sit under `parentId` (null: as a root), or null when it may.
 * `categoryId` is the category being moved, or null for a new one. A category can never be placed
 * under itself or one of its own descendants, and no branch may grow deeper than `maxDepth`.
 */
export function placementProblem(
  all: readonly TaxonomyNode[],
  categoryId: string | null,
  parentId: string | null,
  maxDepth = MAX_CATEGORY_DEPTH,
): PlacementProblem | null {
  const nodes = new Map(all.map((node) => [node.id, node]));
  if (parentId !== null && !nodes.has(parentId)) return 'PARENT_NOT_FOUND';

  if (categoryId !== null) {
    let ancestor = parentId;
    for (let steps = 0; ancestor !== null && steps <= nodes.size; steps++) {
      if (ancestor === categoryId) return 'CYCLE';
      ancestor = nodes.get(ancestor)?.parent_id ?? null;
    }
  }

  const parentDepth = parentId === null ? 0 : depthOf(nodes, parentId);
  const subtreeHeight = categoryId === null ? 1 : heightOf(nodes, categoryId);
  return parentDepth + subtreeHeight > maxDepth ? 'TOO_DEEP' : null;
}
