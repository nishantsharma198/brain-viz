# Brain-Viz: Interactive Human Connectome Explorer

Brain-Viz is a browser-based tool for exploring brain connectivity networks (connectomes) in 3D and 2D. A Python pipeline builds the network data, and a JavaScript front-end lets you filter, explore, and compare brain networks interactively.

## Features

**Front-end (HTML, CSS, JavaScript)**
- **3D brain view** (Three.js): brain regions are rendered as nodes at their anatomical positions, with orbit controls, hover highlighting, and raycast-based selection.
- **2D views** (D3.js): a circular network layout and a chord diagram showing connection strength between brain networks.
- **Shortest pathway**: click two regions to find the strongest connection path, computed with Dijkstra's algorithm on a binary min-heap (edge cost = 1 / weight).
- **Filtering**: edge-weight threshold slider, toggles for individual networks (communities), and hemisphere filter (left/right/both).
- **Region info panel**: function, clinical relevance, degree, strength, betweenness, and hub classification for the selected region.
- **Dataset comparison**: load two datasets side by side, with linked hover and a summary of differences in nodes, edges, and density.
- **Data loading and export**: drag-and-drop JSON loading, multiple dataset tabs, and PNG export of the 3D view.
- **Architecture**: a small event-driven state store (publish/subscribe) keeps the 3D view, 2D views, and panels in sync.

**Data pipeline (`process_hcp.py`)**
- Fetches brain atlases automatically with **nilearn**: Schaefer 2018 (100/200/400 regions) or Destrieux.
- Builds connectivity in one of three ways:
  - **Real resting-state fMRI**: downloads nilearn's development fMRI dataset (5 subjects), extracts regional time series, and computes a mean partial-correlation matrix (`--fmri`).
  - **Atlas-geometry synthetic connectivity**: distance-decay and network-based weights for quick offline use.
  - **Custom CSV input**: your own connectivity matrix, coordinates, and labels.
- Thresholds the matrix and keeps the strongest edges.
- Detects communities with the **Louvain method** (python-louvain, with a pure-Python fallback).
- Computes graph metrics: degree, strength, and weighted **betweenness centrality** (Brandes' algorithm).
- Writes a single JSON file (nodes, edges, communities, metadata) for the front-end.

## Included datasets (`data/`)

| File | Atlas | Connectivity | Nodes | Edges |
|---|---|---|---|---|
| `fmri.json`, `healthy_fmri.json` | Schaefer 100 | fMRI partial correlation | 100 | 224 |
| `connectome.json`, `healthy.json` | Schaefer 100 | Atlas-geometry synthetic | 100 | 700 |
| `healthy_200.json` | Schaefer 200 | Atlas-geometry synthetic | 200 | 700 |

## Running the app

The front-end is a static site; serve the folder with any local web server:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000 and load one of the JSON files from `data/`.

## Generating data

```bash
pip install numpy nilearn pandas networkx python-louvain

# Atlas positions with synthetic connectivity (fast, no fMRI download)
python process_hcp.py --nilearn --atlas schaefer100 --output data/connectome.json

# Real fMRI connectivity (downloads about 200 MB the first time)
python process_hcp.py --nilearn --atlas schaefer100 --fmri --output data/fmri.json

# Your own connectivity matrix
python process_hcp.py --matrix conn.csv --coords coords.csv --labels labels.csv

# Offline demo (Desikan-Killiany, 84 regions)
python process_hcp.py --demo
```

## Project structure

```text
.
├── index.html          # App layout: landing page, main view, compare page
├── css/style.css       # Styling
├── js/
│   ├── algorithms.js   # Min-heap, Dijkstra, filtering, global efficiency
│   ├── store.js        # Event-driven state store (pub/sub)
│   ├── brain3d.js      # Three.js 3D brain renderer
│   ├── graph2d.js      # D3.js circular layout and chord diagram
│   └── main.js         # App control, UI bindings, compare mode
├── process_hcp.py      # Python data pipeline (nilearn, Louvain, metrics)
└── data/               # Pre-generated connectome JSON files
```

## Tech stack

JavaScript, Three.js, D3.js, HTML/CSS, Python, NumPy, nilearn
