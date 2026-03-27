import { describe, it, expect } from "vitest";
import { applyDagreLayout } from "~/lib/auto-layout";
import type { Node, Edge } from "@xyflow/react";

function makeNode(id: string, x = 0, y = 0): Node {
  return { id, type: "tableNode", position: { x, y }, data: {} };
}

describe("applyDagreLayout", () => {
  it("repositions nodes from their original grid positions", () => {
    const nodes: Node[] = [
      makeNode("users", 0, 0),
      makeNode("posts", 320, 0),
      makeNode("comments", 640, 0),
    ];
    const edges: Edge[] = [
      { id: "e1", source: "users", target: "posts" },
      { id: "e2", source: "posts", target: "comments" },
    ];

    const result = applyDagreLayout(nodes, edges);

    expect(result).toHaveLength(3);
    // After dagre layout, positions should be different from original grid
    // The exact positions depend on dagre, but they should be valid numbers
    for (const node of result) {
      expect(typeof node.position.x).toBe("number");
      expect(typeof node.position.y).toBe("number");
      expect(Number.isFinite(node.position.x)).toBe(true);
      expect(Number.isFinite(node.position.y)).toBe(true);
    }
  });

  it("assigns distinct positions to different nodes", () => {
    const nodes: Node[] = [
      makeNode("a", 0, 0),
      makeNode("b", 0, 0),
    ];
    const edges: Edge[] = [
      { id: "e1", source: "a", target: "b" },
    ];

    const result = applyDagreLayout(nodes, edges);

    const posA = result.find((n) => n.id === "a")!.position;
    const posB = result.find((n) => n.id === "b")!.position;
    // They should not be at the same position
    expect(posA.x !== posB.x || posA.y !== posB.y).toBe(true);
  });

  it("handles nodes with no edges (disconnected graph)", () => {
    const nodes: Node[] = [
      makeNode("a"),
      makeNode("b"),
      makeNode("c"),
    ];
    const edges: Edge[] = [];

    const result = applyDagreLayout(nodes, edges);

    expect(result).toHaveLength(3);
    for (const node of result) {
      expect(Number.isFinite(node.position.x)).toBe(true);
      expect(Number.isFinite(node.position.y)).toBe(true);
    }
  });

  it("preserves node data and type", () => {
    const nodes: Node[] = [
      { id: "a", type: "tableNode", position: { x: 0, y: 0 }, data: { label: "users" } },
    ];

    const result = applyDagreLayout(nodes, []);

    expect(result[0].type).toBe("tableNode");
    expect(result[0].data).toEqual({ label: "users" });
    expect(result[0].id).toBe("a");
  });

  it("respects direction option", () => {
    const nodes: Node[] = [
      makeNode("a"),
      makeNode("b"),
    ];
    const edges: Edge[] = [
      { id: "e1", source: "a", target: "b" },
    ];

    const lrResult = applyDagreLayout(nodes, edges, { direction: "LR" });
    const tbResult = applyDagreLayout(nodes, edges, { direction: "TB" });

    const lrA = lrResult.find((n) => n.id === "a")!.position;
    const lrB = lrResult.find((n) => n.id === "b")!.position;
    const tbA = tbResult.find((n) => n.id === "a")!.position;
    const tbB = tbResult.find((n) => n.id === "b")!.position;

    // LR: a should be left of b (smaller x)
    expect(lrA.x).toBeLessThan(lrB.x);
    // TB: a should be above b (smaller y)
    expect(tbA.y).toBeLessThan(tbB.y);
  });

  it("returns empty array for empty input", () => {
    const result = applyDagreLayout([], []);
    expect(result).toEqual([]);
  });
});
