/**
 * algorithms.js — Brain-Viz Core Graph Algorithms
 * Dijkstra shortest-path (strongest structural pathway) + graph utilities.
 * All functions operate on the processed connectome data structure.
 */

"use strict";

window.BrainAlgorithms = (() => {

  // ── MinHeap (priority queue for Dijkstra) ─────────────────────────────────
  class MinHeap {
    constructor() { this._heap = []; }
    push(item, priority) {
      this._heap.push({ item, priority });
      this._bubbleUp(this._heap.length - 1);
    }
    pop() {
      const top = this._heap[0];
      const last = this._heap.pop();
      if (this._heap.length > 0) {
        this._heap[0] = last;
        this._siftDown(0);
      }
      return top;
    }
    get size() { return this._heap.length; }
    _bubbleUp(i) {
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (this._heap[parent].priority <= this._heap[i].priority) break;
        [this._heap[parent], this._heap[i]] = [this._heap[i], this._heap[parent]];
        i = parent;
      }
    }
    _siftDown(i) {
      const n = this._heap.length;
      while (true) {
        let smallest = i;
        const l = 2 * i + 1, r = 2 * i + 2;
        if (l < n && this._heap[l].priority < this._heap[smallest].priority) smallest = l;
        if (r < n && this._heap[r].priority < this._heap[smallest].priority) smallest = r;
        if (smallest === i) break;
        [this._heap[smallest], this._heap[i]] = [this._heap[i], this._heap[smallest]];
        i = smallest;
      }
    }
  }

  /**
   * Build an adjacency map from the edges array.
   * @param {Array} edges  — [{source, target, weight}, ...]
   * @param {number} n     — total node count
   * @returns {Map<number, Array<{to, weight}>>}
   */
  function buildAdjacency(edges, n) {
    const adj = new Map();
    for (let i = 0; i < n; i++) adj.set(i, []);
    for (const { source, target, weight } of edges) {
      adj.get(source).push({ to: target, weight });
      adj.get(target).push({ to: source, weight });
    }
    return adj;
  }

  /**
   * Dijkstra shortest-structural-path between two brain regions.
   * "Strongest" pathway = shortest distance when distance = 1/weight
   * (high connectivity weight → small cost → preferred route).
   *
   * @param {number} src   — source node id
   * @param {number} dst   — destination node id
   * @param {Map}    adj   — adjacency map from buildAdjacency()
   * @param {number} n     — total node count
   * @returns {{ path: number[], totalWeight: number, found: boolean }}
   */
  function dijkstra(src, dst, adj, n) {
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const visited = new Uint8Array(n);
    dist[src] = 0;

    const pq = new MinHeap();
    pq.push(src, 0);

    while (pq.size > 0) {
      const { item: u, priority: d } = pq.pop();
      if (visited[u]) continue;
      visited[u] = 1;
      if (u === dst) break;

      for (const { to: v, weight: w } of (adj.get(u) || [])) {
        if (visited[v]) continue;
        // cost = 1/weight so high-weight edges are cheap to traverse
        const cost = d + (1.0 / (w + 1e-9));
        if (cost < dist[v]) {
          dist[v] = cost;
          prev[v] = u;
          pq.push(v, cost);
        }
      }
    }

    if (dist[dst] === Infinity) return { path: [], totalWeight: 0, found: false };

    // Reconstruct path
    const path = [];
    let cur = dst;
    while (cur !== -1) { path.push(cur); cur = prev[cur]; }
    path.reverse();

    // Compute total structural weight along path
    let totalWeight = 0;
    let count = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const neighbors = adj.get(path[i]) || [];
      const edge = neighbors.find(e => e.to === path[i + 1]);
      if (edge) { totalWeight += edge.weight; count++; }
    }
    const avgWeight = count > 0 ? totalWeight / count : 0;

    return { path, totalWeight: avgWeight, found: true };
  }

  /**
   * Collect all edge indices that connect to a given node.
   * @param {number} nodeId
   * @param {Array}  edges
   * @returns {Set<number>} — edge indices
   */
  function getNodeEdgeIndices(nodeId, edges) {
    const result = new Set();
    for (let i = 0; i < edges.length; i++) {
      if (edges[i].source === nodeId || edges[i].target === nodeId) result.add(i);
    }
    return result;
  }

  /**
   * Get direct neighbors of a node.
   * @param {number} nodeId
   * @param {Map}    adj
   * @returns {Set<number>}
   */
  function getNeighbors(nodeId, adj) {
    const nbrs = adj.get(nodeId) || [];
    return new Set(nbrs.map(e => e.to));
  }

  /**
   * Filter edges by minimum weight threshold.
   * @param {Array}  edges
   * @param {number} minWeight  [0, 1]
   * @returns {Set<number>} — visible edge indices
   */
  function filterEdgesByWeight(edges, minWeight) {
    const result = new Set();
    for (let i = 0; i < edges.length; i++) {
      if (edges[i].weight >= minWeight) result.add(i);
    }
    return result;
  }

  /**
   * Filter to edges within selected communities only.
   * @param {Array}  edges
   * @param {Array}  nodes
   * @param {Set<number>} activeCommunities — community ids to show
   * @param {boolean} crossCommunity — also show inter-community edges
   * @returns {Set<number>}
   */
  function filterEdgesByCommunity(edges, nodes, activeCommunities, crossCommunity = true) {
    const nodeComm = new Map(nodes.map(n => [n.id, n.community]));
    const result = new Set();
    for (let i = 0; i < edges.length; i++) {
      const cs = nodeComm.get(edges[i].source);
      const ct = nodeComm.get(edges[i].target);
      if (activeCommunities.has(cs) && activeCommunities.has(ct)) result.add(i);
      else if (crossCommunity && (activeCommunities.has(cs) || activeCommunities.has(ct))) result.add(i);
    }
    return result;
  }

  /**
   * Compute global efficiency (mean inverse shortest-path length).
   * Runs on a sampled subgraph for performance.
   */
  function globalEfficiency(adj, n, sampleSize = 30) {
    const ids = Array.from({ length: n }, (_, i) => i);
    const sample = ids.sort(() => Math.random() - 0.5).slice(0, Math.min(sampleSize, n));
    let sum = 0, count = 0;
    for (const src of sample) {
      const dist = new Float64Array(n).fill(Infinity);
      dist[src] = 0;
      const pq = new MinHeap();
      pq.push(src, 0);
      const vis = new Uint8Array(n);
      while (pq.size > 0) {
        const { item: u, priority: d } = pq.pop();
        if (vis[u]) continue; vis[u] = 1;
        for (const { to: v, weight: w } of (adj.get(u) || [])) {
          const c = d + 1.0 / (w + 1e-9);
          if (c < dist[v]) { dist[v] = c; pq.push(v, c); }
        }
      }
      for (const dst of ids) {
        if (dst !== src && dist[dst] !== Infinity) {
          sum += 1.0 / dist[dst]; count++;
        }
      }
    }
    return count > 0 ? sum / count : 0;
  }

  return { buildAdjacency, dijkstra, getNodeEdgeIndices, getNeighbors,
           filterEdgesByWeight, filterEdgesByCommunity, globalEfficiency };

})();
