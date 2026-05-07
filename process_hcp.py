#!/usr/bin/env python3
"""
process_hcp.py — Brain-Viz HCP Data Ingestion & Processing Pipeline
=====================================================================
Usage modes:

  # 1. Auto-fetch via nilearn (no manual downloads required):
  python process_hcp.py --nilearn --atlas schaefer100
  python process_hcp.py --nilearn --atlas schaefer200
  python process_hcp.py --nilearn --atlas destrieux

  # 2. Auto-fetch nilearn atlas + REAL fMRI connectivity (downloads ~200 MB):
  python process_hcp.py --nilearn --atlas schaefer100 --fmri

  # 3. Real HCP local CSVs:
  python process_hcp.py --matrix connectivity.csv --coords coords.csv --labels labels.csv

  # 4. Synthetic demo (no files needed):
  python process_hcp.py --demo --output data/connectome.json

Dependencies:
  pip install numpy
  pip install nilearn            # for --nilearn mode
  pip install pandas             # for --matrix/--coords mode
  pip install networkx python-louvain  # optional, improves community detection
"""

import argparse, json, math, random, heapq, sys
from pathlib import Path
import numpy as np

# ── Optional dependency guards ───────────────────────────────────────────────

try:
    import pandas as pd
    HAS_PANDAS = True
except ImportError:
    HAS_PANDAS = False

try:
    import networkx as nx
    import community as community_louvain
    HAS_LOUVAIN = True
except ImportError:
    HAS_LOUVAIN = False

try:
    import nilearn
    HAS_NILEARN = True
except ImportError:
    HAS_NILEARN = False


# ── Pure-Python Louvain (fallback when python-louvain is absent) ─────────────

class _Louvain:
    def __init__(self, adj):
        self.adj  = adj
        self.nodes = list(adj.keys())
        self.m2   = sum(w for u in adj for w in adj[u].values()) or 1.0

    def _gain(self, node, community, com_nodes, node_com):
        ki    = sum(self.adj[node].values())
        ki_in = sum(self.adj[node].get(nb, 0.0) for nb in com_nodes.get(community, []))
        sigma = sum(sum(self.adj[nb].values()) for nb in com_nodes.get(community, []))
        return (ki_in / self.m2) - (sigma * ki) / (self.m2 ** 2)

    def run(self, iters=15):
        nc = {n: n for n in self.nodes}
        cn = {n: [n] for n in self.nodes}
        for _ in range(iters):
            improved = False
            random.shuffle(self.nodes)
            for node in self.nodes:
                cc = nc[node]; best_c = cc; best_g = 0.0
                for nb_c in {nc[nb] for nb in self.adj[node] if nb != node}:
                    if nb_c == cc: continue
                    g = self._gain(node, nb_c, cn, nc)
                    if g > best_g:
                        best_g = g; best_c = nb_c
                if best_c != cc:
                    cn[cc].remove(node)
                    if not cn[cc]: del cn[cc]
                    cn.setdefault(best_c, []).append(node)
                    nc[node] = best_c; improved = True
            if not improved:
                break
        uq = sorted(set(nc.values()))
        rm = {c: i for i, c in enumerate(uq)}
        return {n: rm[c] for n, c in nc.items()}


def detect_communities(adj):
    """Detect communities using Louvain method (networkx or pure-Python fallback)."""
    if HAS_LOUVAIN:
        G = nx.Graph()
        for u, nbrs in adj.items():
            for v, w in nbrs.items():
                if u <= v:
                    G.add_edge(u, v, weight=w)
        return community_louvain.best_partition(G, weight='weight', random_state=42)
    return _Louvain(adj).run()


# ── Graph Metrics ─────────────────────────────────────────────────────────────

def compute_metrics(nodes, adj):
    """Compute degree, strength, and betweenness centrality for all nodes."""
    node_ids = [n["id"] for n in nodes]
    bc = {i: 0.0 for i in node_ids}

    for nd in nodes:
        nd["degree"]   = len(adj.get(nd["id"], {}))
        nd["strength"] = round(sum(adj.get(nd["id"], {}).values()), 4)

    for src in node_ids:
        dist  = {i: math.inf for i in node_ids}
        dist[src] = 0.0
        sigma = {i: 0 for i in node_ids}
        sigma[src] = 1
        pred  = {i: [] for i in node_ids}
        stack = []
        pq    = [(0.0, src)]
        while pq:
            d, u = heapq.heappop(pq)
            if d > dist[u]: continue
            stack.append(u)
            for v, w in adj.get(u, {}).items():
                nd2 = d + (1.0 / (w + 1e-9))
                if nd2 < dist[v]:
                    dist[v] = nd2; sigma[v] = sigma[u]; pred[v] = [u]
                    heapq.heappush(pq, (nd2, v))
                elif abs(nd2 - dist[v]) < 1e-9:
                    sigma[v] += sigma[u]; pred[v].append(u)
        delta = {i: 0.0 for i in node_ids}
        while stack:
            w2 = stack.pop()
            for p in pred[w2]:
                delta[p] += (sigma[p] / max(sigma[w2], 1)) * (1 + delta[w2])
            if w2 != src:
                bc[w2] += delta[w2]

    mx = max(bc.values()) or 1.0
    for nd in nodes:
        nd["betweenness"] = round(bc[nd["id"]] / mx, 4)
    return nodes


# ── Matrix Thresholding ────────────────────────────────────────────────────────

def threshold_matrix(matrix, threshold, max_edges):
    """Keep only the top edges above threshold, normalise weights to [0,1]."""
    n = matrix.shape[0]
    edges = []
    for i in range(n):
        for j in range(i + 1, n):
            w = float(matrix[i, j])
            if w > threshold:
                edges.append((i, j, w))
    if edges:
        mx  = max(e[2] for e in edges)
        mn  = min(e[2] for e in edges)
        rng = mx - mn or 1.0
        edges = [(i, j, (w - mn) / rng) for i, j, w in edges]
    edges.sort(key=lambda e: e[2], reverse=True)
    return edges[:max_edges]


# ── nilearn Auto-Fetch Functions ──────────────────────────────────────────────

def _require_nilearn():
    if not HAS_NILEARN:
        sys.exit(
            "nilearn is required for --nilearn mode.\n"
            "Install it with:  pip install nilearn"
        )


def fetch_atlas_coords_labels(atlas_name):
    """
    Download and return (coords_mni, labels, atlas_img) for the chosen atlas.

    Supported atlas_name values:
      'schaefer100'  — Schaefer 2018, 100 parcels (7 Yeo networks)
      'schaefer200'  — Schaefer 2018, 200 parcels
      'schaefer400'  — Schaefer 2018, 400 parcels
      'destrieux'    — Destrieux 2009 cortical atlas
    """
    _require_nilearn()
    from nilearn import datasets
    from nilearn.plotting import find_parcellation_cut_coords

    print(f"  Fetching atlas: {atlas_name} …")

    if atlas_name.startswith("schaefer"):
        n_rois = int(atlas_name.replace("schaefer", ""))
        atlas = datasets.fetch_atlas_schaefer_2018(
            n_rois=n_rois, yeo_networks=7, resolution_mm=2
        )
        atlas_img = atlas.maps
        raw_labels = atlas.labels
        # Decode bytes if necessary
        labels = [
            (lb.decode("utf-8") if isinstance(lb, bytes) else str(lb))
            for lb in raw_labels
        ]
        coords_mni = find_parcellation_cut_coords(atlas_img)

    elif atlas_name == "destrieux":
        atlas = datasets.fetch_atlas_destrieux_2009(lateralized=True)
        atlas_img = atlas.maps
        # Destrieux labels include index 0 (background); skip it
        raw_labels = atlas.labels[1:]
        labels = [
            (lb[1].decode("utf-8") if isinstance(lb[1], bytes) else str(lb[1]))
            for lb in raw_labels
        ]
        coords_mni = find_parcellation_cut_coords(atlas_img)

    else:
        sys.exit(f"Unknown atlas: {atlas_name}. Choose schaefer100, schaefer200, schaefer400, or destrieux.")

    coords_mni = np.array(coords_mni, dtype=float)

    # ── Fix: nilearn's Schaefer atlas sometimes includes a background label
    # at index 0 so len(labels) == n_rois + 1, while find_parcellation_cut_coords
    # returns only n_rois coordinates (one per real parcel, no background).
    # Strip the leading background entry when there is a mismatch, then
    # safety-trim both arrays to the same length.
    if len(labels) > len(coords_mni):
        first = labels[0].lower().strip()
        if first in ("0", "background", "none", "") or first.startswith("background"):
            labels = labels[1:]
            print(f"  Stripped background label — now {len(labels)} regions")
        else:
            labels = labels[:len(coords_mni)]

    n = min(len(labels), len(coords_mni))
    labels     = labels[:n]
    coords_mni = coords_mni[:n]

    print(f"  Atlas loaded: {len(labels)} regions, {len(coords_mni)} coordinates")
    return coords_mni, labels, atlas_img


def fetch_fmri_connectivity(atlas_img, n_subjects=5):
    """
    Download real resting-state fMRI data (development dataset, ~200 MB),
    extract regional time-series from the atlas, and return a mean
    partial-correlation connectivity matrix.

    This uses nilearn's built-in dataset fetcher — no manual downloads required.
    """
    _require_nilearn()
    from nilearn import datasets
    from nilearn.maskers import NiftiLabelsMasker
    from nilearn.connectome import ConnectivityMeasure

    print(f"  Downloading fMRI dataset ({n_subjects} subjects) — this may take a few minutes…")
    dataset = datasets.fetch_development_fmri(n_subjects=n_subjects, reduce_confounds=True)

    masker = NiftiLabelsMasker(
        labels_img=atlas_img,
        standardize=True,
        memory="nilearn_cache",
        verbose=0,
    )

    measure = ConnectivityMeasure(kind="partial correlation")

    time_series_list = []
    for func_img, confounds in zip(dataset.func, dataset.confounds):
        ts = masker.fit_transform(func_img, confounds=confounds)
        time_series_list.append(ts)

    print(f"  Computing connectivity ({len(time_series_list)} subjects)…")
    matrices = measure.fit_transform(time_series_list)
    mean_matrix = measure.mean_

    # Keep only positive correlations (analogous to structural white-matter weights)
    mean_matrix = np.clip(mean_matrix, 0, 1)
    np.fill_diagonal(mean_matrix, 0)

    print(f"  Connectivity matrix: {mean_matrix.shape}, "
          f"mean={mean_matrix.mean():.4f}, max={mean_matrix.max():.4f}")
    return mean_matrix


def build_synthetic_connectivity_from_atlas(coords_mni, labels, seed=42):
    """
    Build a biologically plausible synthetic connectivity matrix using the
    atlas spatial geometry (distance decay + bilateral symmetry).

    Used when --fmri is NOT passed so the user gets atlas-accurate node positions
    without waiting for an fMRI download.
    """
    rng = np.random.default_rng(seed)
    n   = len(labels)
    M   = np.zeros((n, n))

    # Determine hemisphere from label names (Schaefer: 7Networks_LH_ / RH_)
    def _hemi(lbl):
        lbl = lbl.lower()
        if "lh" in lbl or "left" in lbl or lbl.startswith("l-"):
            return "L"
        if "rh" in lbl or "right" in lbl or lbl.startswith("r-"):
            return "R"
        return "?"

    # Estimate network membership from label text (Schaefer 7-network convention)
    NET_KEYWORDS = {
        0: ["default", "dmn"],
        1: ["visual", "vis"],
        2: ["somato", "motor", "somatomotor"],
        3: ["frontoparietal", "control", "cont"],
        4: ["limbic"],
        5: ["dorsal", "dattention", "dattn"],
        6: ["ventral", "salience", "vattention", "vattn"],
    }

    def _network(lbl):
        lbl = lbl.lower()
        for net_id, kws in NET_KEYWORDS.items():
            if any(k in lbl for k in kws):
                return net_id
        return 0  # default

    net = [_network(lb) for lb in labels]
    hemi = [_hemi(lb) for lb in labels]

    # Pairwise distance (normalised)
    dists = np.sqrt(((coords_mni[:, None, :] - coords_mni[None, :, :]) ** 2).sum(-1))
    max_d = dists.max() or 1.0
    dists_n = dists / max_d

    for i in range(n):
        for j in range(i + 1, n):
            same_net  = (net[i] == net[j])
            same_hemi = (hemi[i] == hemi[j])
            dist      = dists_n[i, j]

            # Within-network: strong distance-decayed weight
            if same_net and same_hemi:
                if rng.random() < 0.60:
                    w = rng.beta(6, 2) * np.exp(-3 * dist)
                    M[i, j] = M[j, i] = max(w, 0.05)
            # Cross-network, same hemisphere
            elif same_hemi:
                if rng.random() < 0.15:
                    w = rng.beta(2, 5) * np.exp(-4 * dist)
                    M[i, j] = M[j, i] = max(w, 0.02)
            # Bilateral homologous (same network, opposite hemisphere)
            elif same_net:
                if rng.random() < 0.50:
                    w = rng.beta(5, 3) * 0.85
                    M[i, j] = M[j, i] = max(w, 0.10)
            # Cross-hemisphere, different network
            else:
                if rng.random() < 0.06:
                    w = rng.beta(2, 8)
                    M[i, j] = M[j, i] = w

    np.fill_diagonal(M, 0)
    return M


# ── nilearn End-to-End Loader ─────────────────────────────────────────────────

def load_nilearn(atlas_name, use_fmri, threshold, max_edges, seed=42):
    """
    Full pipeline using nilearn:
      1. Fetch atlas (coordinates + labels)
      2. Either download real fMRI connectivity OR build biologically-plausible
         synthetic connectivity from atlas geometry
      3. Threshold → community detection → metrics → JSON
    """
    coords_mni, labels, atlas_img = fetch_atlas_coords_labels(atlas_name)
    n = len(labels)

    if use_fmri:
        matrix = fetch_fmri_connectivity(atlas_img, n_subjects=5)
        # Trim to atlas size if mismatched (rare with Schaefer)
        matrix = matrix[:n, :n]
    else:
        print("  Building atlas-geometry connectivity (no fMRI download) …")
        matrix = build_synthetic_connectivity_from_atlas(coords_mni, labels, seed)

    edges_raw = threshold_matrix(matrix, threshold, max_edges)
    print(f"  After threshold={threshold}: {len(edges_raw)} edges retained")

    adj = {i: {} for i in range(n)}
    for i, j, w in edges_raw:
        adj[i][j] = w
        adj[j][i] = w

    partition = detect_communities(adj)

    centroid  = coords_mni.mean(0)
    scale     = np.abs(coords_mni - centroid).max()
    coords_n  = (coords_mni - centroid) / (scale + 1e-9)

    def _hemi(lbl):
        lbl_low = lbl.lower()
        if "lh" in lbl_low or "left" in lbl_low or lbl_low.startswith("l-"):
            return "L"
        if "rh" in lbl_low or "right" in lbl_low or lbl_low.startswith("r-"):
            return "R"
        return "L" if coords_mni[labels.index(lbl)][0] < 0 else "R"

    nodes = [
        {
            "id":        i,
            "label":     labels[i],
            "x":         round(float(coords_n[i, 0]), 4),
            "y":         round(float(coords_n[i, 1]), 4),
            "z":         round(float(coords_n[i, 2]), 4),
            "mni_x":     float(coords_mni[i, 0]),
            "mni_y":     float(coords_mni[i, 1]),
            "mni_z":     float(coords_mni[i, 2]),
            "community": int(partition.get(i, 0)),
            "hemisphere": _hemi(labels[i]),
        }
        for i in range(n)
    ]
    nodes  = compute_metrics(nodes, adj)
    edges  = [{"source": i, "target": j, "weight": round(w, 4)} for i, j, w in edges_raw]

    modality = "fMRI Partial Correlation" if use_fmri else "Geometry-Weighted Synthetic (nilearn atlas)"
    return build_output(nodes, edges, parcellation=atlas_name.title(), modality=modality)


# ── Real HCP CSV Loader ────────────────────────────────────────────────────────

def load_hcp(matrix_path, coords_path, labels_path, threshold, max_edges):
    """Load connectivity from manually-provided CSV files (original behaviour)."""
    if not HAS_PANDAS:
        sys.exit("pip install pandas  — required for --matrix/--coords mode")

    matrix = pd.read_csv(matrix_path, header=None).values.astype(float)
    np.fill_diagonal(matrix, 0)
    n = matrix.shape[0]

    coords = pd.read_csv(coords_path, header=None).iloc[:n, :3].values.astype(float)
    labels = [f"Region-{i}" for i in range(n)]
    if labels_path:
        labels = pd.read_csv(labels_path, header=None).iloc[:n, 0].astype(str).tolist()

    edges_raw = threshold_matrix(matrix, threshold, max_edges)
    adj = {i: {} for i in range(n)}
    for i, j, w in edges_raw:
        adj[i][j] = w
        adj[j][i] = w

    partition = detect_communities(adj)
    centroid  = coords.mean(0)
    scale     = np.abs(coords - centroid).max()
    coords_n  = (coords - centroid) / (scale + 1e-9)

    nodes = [
        {
            "id":        i,
            "label":     labels[i],
            "x":         round(float(coords_n[i, 0]), 4),
            "y":         round(float(coords_n[i, 1]), 4),
            "z":         round(float(coords_n[i, 2]), 4),
            "mni_x":     float(coords[i, 0]),
            "mni_y":     float(coords[i, 1]),
            "mni_z":     float(coords[i, 2]),
            "community": int(partition.get(i, 0)),
            "hemisphere": "L" if coords[i, 0] < 0 else "R",
        }
        for i in range(n)
    ]
    nodes  = compute_metrics(nodes, adj)
    edges  = [{"source": i, "target": j, "weight": round(w, 4)} for i, j, w in edges_raw]
    return build_output(nodes, edges, parcellation="Custom HCP", modality="DTI Structural Connectivity")


# ── Synthetic Demo (offline fallback) ─────────────────────────────────────────

DK84 = [
    ("L-bankssts",-57,-47,12,2),("L-caudal-ACC",-5,26,28,0),("L-caudal-MFG",-45,14,42,3),
    ("L-cuneus",-10,-90,18,1),("L-entorhinal",-26,-10,-31,4),("L-fusiform",-40,-50,-18,1),
    ("L-inferior-parietal",-48,-62,38,3),("L-inferior-temporal",-56,-32,-20,4),
    ("L-isthmus-cingulate",-9,-44,24,0),("L-lateral-occipital",-40,-80,12,1),
    ("L-lateral-OFC",-30,42,-15,4),("L-lingual",-16,-73,-6,1),
    ("L-medial-OFC",-7,50,-13,0),("L-middle-temporal",-64,-32,-10,0),
    ("L-parahippocampal",-26,-30,-18,4),("L-paracentral",-8,-26,60,2),
    ("L-parsopercularis",-53,18,8,6),("L-parsorbitalis",-48,40,-7,4),
    ("L-parstriangularis",-50,31,14,6),("L-pericalcarine",-9,-87,2,1),
    ("L-postcentral",-50,-25,43,2),("L-posterior-cingulate",-7,-50,28,0),
    ("L-precentral",-48,-5,48,2),("L-precuneus",-10,-58,50,0),
    ("L-rostral-ACC",-7,37,11,0),("L-rostral-MFG",-37,48,22,3),
    ("L-superior-frontal",-18,24,54,3),("L-superior-parietal",-26,-65,55,5),
    ("L-superior-temporal",-62,-28,8,6),("L-supramarginal",-60,-38,34,5),
    ("L-frontal-pole",-12,65,8,3),("L-temporal-pole",-41,11,-34,4),
    ("L-transverse-temporal",-54,-20,12,2),("L-insula",-39,1,5,6),
    ("R-bankssts",57,-47,12,2),("R-caudal-ACC",5,26,28,0),("R-caudal-MFG",45,14,42,3),
    ("R-cuneus",10,-90,18,1),("R-entorhinal",26,-10,-31,4),("R-fusiform",40,-50,-18,1),
    ("R-inferior-parietal",48,-62,38,3),("R-inferior-temporal",56,-32,-20,4),
    ("R-isthmus-cingulate",9,-44,24,0),("R-lateral-occipital",40,-80,12,1),
    ("R-lateral-OFC",30,42,-15,4),("R-lingual",16,-73,-6,1),
    ("R-medial-OFC",7,50,-13,0),("R-middle-temporal",64,-32,-10,0),
    ("R-parahippocampal",26,-30,-18,4),("R-paracentral",8,-26,60,2),
    ("R-parsopercularis",53,18,8,6),("R-parsorbitalis",48,40,-7,4),
    ("R-parstriangularis",50,31,14,6),("R-pericalcarine",9,-87,2,1),
    ("R-postcentral",50,-25,43,2),("R-posterior-cingulate",7,-50,28,0),
    ("R-precentral",48,-5,48,2),("R-precuneus",10,-58,50,0),
    ("R-rostral-ACC",7,37,11,0),("R-rostral-MFG",37,48,22,3),
    ("R-superior-frontal",18,24,54,3),("R-superior-parietal",26,-65,55,5),
    ("R-superior-temporal",62,-28,8,6),("R-supramarginal",60,-38,34,5),
    ("R-frontal-pole",12,65,8,3),("R-temporal-pole",41,11,-34,4),
    ("R-transverse-temporal",54,-20,12,2),("R-insula",39,1,5,6),
    ("L-Thalamus",-12,-18,7,7),("L-Caudate",-14,12,12,7),("L-Putamen",-25,4,0,7),
    ("L-Pallidum",-19,-4,2,7),("L-Hippocampus",-27,-22,-14,4),("L-Amygdala",-23,-5,-20,4),
    ("L-Accumbens",-10,10,-7,7),("L-VentralDC",-10,-20,-6,7),
    ("R-Thalamus",12,-18,7,7),("R-Caudate",14,12,12,7),("R-Putamen",25,4,0,7),
    ("R-Pallidum",19,-4,2,7),("R-Hippocampus",27,-22,-14,4),("R-Amygdala",23,-5,-20,4),
    ("R-Accumbens",10,10,-7,7),("R-VentralDC",10,-20,-6,7),
]

NET_NAMES  = ["Default Mode","Visual","Somatomotor","Frontoparietal",
              "Limbic","Dorsal Attention","Ventral Attention","Subcortical"]
NET_COLORS = ["#E63946","#2EC4B6","#FF6B35","#7B2FBE",
              "#06D6A0","#118AB2","#F72585","#FFD166"]


def _synthetic_matrix(n, communities, seed=42):
    rng = np.random.default_rng(seed)
    M   = np.zeros((n, n))
    for i in range(n):
        for j in range(i + 1, n):
            ci, cj = communities[i], communities[j]
            if ci == cj:
                if rng.random() < 0.55:
                    M[i, j] = M[j, i] = rng.beta(5, 2)
            else:
                if rng.random() < 0.12:
                    M[i, j] = M[j, i] = rng.beta(2, 6)
    nc2 = len(DK84) // 2
    for i in range(nc2 // 2):
        j = i + nc2 // 2
        M[i, j] = M[j, i] = max(M[i, j], rng.beta(6, 2))
    return M


def generate_demo(max_edges=700, threshold=0.08, seed=42):
    random.seed(seed); np.random.seed(seed)
    n      = len(DK84)
    labels = [r[0] for r in DK84]
    mni    = np.array([[r[1], r[2], r[3]] for r in DK84], dtype=float)
    gt     = [r[4] for r in DK84]
    M      = _synthetic_matrix(n, gt, seed)

    edges_raw = threshold_matrix(M, threshold, max_edges)
    print(f"  Demo: {n} nodes, {len(edges_raw)} edges")

    adj = {i: {} for i in range(n)}
    for i, j, w in edges_raw:
        adj[i][j] = w; adj[j][i] = w

    partition = detect_communities(adj)
    centroid  = mni.mean(0)
    scale     = np.abs(mni - centroid).max()
    coords_n  = (mni - centroid) / (scale + 1e-9)

    nodes = [
        {
            "id":        i,
            "label":     labels[i],
            "x":         round(float(coords_n[i, 0]), 4),
            "y":         round(float(coords_n[i, 1]), 4),
            "z":         round(float(coords_n[i, 2]), 4),
            "mni_x":     float(mni[i, 0]),
            "mni_y":     float(mni[i, 1]),
            "mni_z":     float(mni[i, 2]),
            "community": int(partition.get(i, gt[i])),
            "hemisphere": "L" if labels[i].startswith("L") else "R",
        }
        for i in range(n)
    ]
    nodes = compute_metrics(nodes, adj)
    edges = [{"source": i, "target": j, "weight": round(w, 4)} for i, j, w in edges_raw]
    return build_output(nodes, edges, parcellation="Desikan-Killiany (DK-84)", modality="DTI Structural Connectivity")


# ── Output Builder ─────────────────────────────────────────────────────────────

def build_output(nodes, edges, parcellation="Unknown", modality="Unknown"):
    """Remap community IDs to 0-indexed and emit the full JSON object."""
    all_c = sorted(set(n["community"] for n in nodes))
    rm    = {c: i for i, c in enumerate(all_c)}
    for nd in nodes:
        nd["community"] = rm[nd["community"]]

    nc = len(all_c)
    communities = [
        {
            "id":    c,
            "name":  NET_NAMES[c] if c < len(NET_NAMES) else f"Net-{c}",
            "color": NET_COLORS[c % len(NET_COLORS)],
            "size":  sum(1 for nd in nodes if nd["community"] == c),
        }
        for c in range(nc)
    ]
    wts  = [e["weight"] for e in edges]
    meta = {
        "parcellation":  parcellation,
        "source":        "Human Connectome Project / nilearn",
        "modality":      modality,
        "n_nodes":       len(nodes),
        "n_edges":       len(edges),
        "n_communities": nc,
        "density":       round(2 * len(edges) / max(len(nodes) * (len(nodes) - 1), 1), 4),
        "avg_degree":    round(2 * len(edges) / max(len(nodes), 1), 2),
        "weight_mean":   round(float(np.mean(wts)), 4) if wts else 0,
        "weight_std":    round(float(np.std(wts)),  4) if wts else 0,
    }
    return {"metadata": meta, "nodes": nodes, "edges": edges, "communities": communities}


# ── CLI ────────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(
        description="Brain-Viz connectome data pipeline",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples
--------
  # Fastest: atlas coords + realistic synthetic connectivity
  python process_hcp.py --nilearn --atlas schaefer100

  # Real fMRI connectivity (downloads ~200 MB once, then cached):
  python process_hcp.py --nilearn --atlas schaefer100 --fmri

  # Larger parcellation:
  python process_hcp.py --nilearn --atlas schaefer200

  # Destrieux atlas (148 cortical regions):
  python process_hcp.py --nilearn --atlas destrieux

  # From local HCP CSVs:
  python process_hcp.py --matrix conn.csv --coords mni.csv --labels labels.csv

  # Quick offline demo (no network required):
  python process_hcp.py --demo
        """,
    )

    # Mode flags (mutually exclusive)
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument("--nilearn", action="store_true",
                      help="Auto-fetch via nilearn (no manual CSV downloads)")
    mode.add_argument("--demo",    action="store_true",
                      help="Generate offline synthetic DK-84 demo")
    mode.add_argument("--matrix",  type=str, metavar="CSV",
                      help="Path to square connectivity matrix CSV")

    # nilearn options
    p.add_argument("--atlas", type=str, default="schaefer100",
                   choices=["schaefer100", "schaefer200", "schaefer400", "destrieux"],
                   help="Atlas to use with --nilearn (default: schaefer100)")
    p.add_argument("--fmri", action="store_true",
                   help="Download real fMRI data for connectivity (slower, ~200 MB)")

    # HCP CSV options
    p.add_argument("--coords",    type=str, metavar="CSV")
    p.add_argument("--labels",    type=str, metavar="CSV", default=None)

    # Common options
    p.add_argument("--threshold", type=float, default=0.10,
                   help="Minimum edge weight to retain (default: 0.10)")
    p.add_argument("--max-edges", type=int,   default=700,
                   help="Maximum edges in output (default: 700)")
    p.add_argument("--output",    type=str,   default="data/connectome.json",
                   help="Output path (default: data/connectome.json)")
    p.add_argument("--seed",      type=int,   default=42)

    args = p.parse_args()

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)

    # ── Dispatch ─────────────────────────────────────────────────────────────
    if args.nilearn:
        print(f"[nilearn mode] Atlas: {args.atlas}, fMRI: {args.fmri}")
        res = load_nilearn(
            atlas_name=args.atlas,
            use_fmri=args.fmri,
            threshold=args.threshold,
            max_edges=args.max_edges,
            seed=args.seed,
        )
    elif args.demo:
        print("Generating synthetic demo connectome…")
        res = generate_demo(args.max_edges, args.threshold, args.seed)
    else:
        if not args.coords:
            p.error("--matrix mode requires --coords as well")
        res = load_hcp(args.matrix, args.coords, args.labels,
                       args.threshold, args.max_edges)

    with open(out, "w") as f:
        json.dump(res, f, separators=(",", ":"))

    m = res["metadata"]
    print(
        f"\n✓ Written to: {out}\n"
        f"  Nodes: {m['n_nodes']}  |  Edges: {m['n_edges']}  |  "
        f"Networks: {m['n_communities']}  |  Density: {m['density']}\n"
        f"  Parcellation: {m['parcellation']}\n"
        f"  Modality:     {m['modality']}"
    )


if __name__ == "__main__":
    main()