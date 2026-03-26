/**
 * Dagre-based auto-layout for ERD nodes.
 * Arranges table nodes in a layered graph layout that minimizes FK edge crossings.
 */

import dagre from "@dagrejs/dagre";
import type { Node, Edge } from "@xyflow/react";

export interface LayoutOptions {
  direction?: "TB" | "LR";
  nodeWidth?: number;
  nodeHeight?: number;
  rankSep?: number;
  nodeSep?: number;
}

const DEFAULTS: Required<LayoutOptions> = {
  direction: "LR",
  nodeWidth: 280,
  nodeHeight: 300,
  rankSep: 100,
  nodeSep: 50,
};

/**
 * Apply dagre layout to nodes given edges.
 * Returns new node array with updated positions. Edges are unchanged.
 */
export function applyDagreLayout(
  nodes: Node[],
  edges: Edge[],
  options?: LayoutOptions,
): Node[] {
  const opts = { ...DEFAULTS, ...options };

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: opts.direction,
    ranksep: opts.rankSep,
    nodesep: opts.nodeSep,
  });

  for (const node of nodes) {
    g.setNode(node.id, { width: opts.nodeWidth, height: opts.nodeHeight });
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const dagreNode = g.node(node.id);
    // dagre gives center coordinates; ReactFlow uses top-left
    return {
      ...node,
      position: {
        x: dagreNode.x - opts.nodeWidth / 2,
        y: dagreNode.y - opts.nodeHeight / 2,
      },
    };
  });
}
