"""A* on a NumPy cost grid, plus line-of-sight path smoothing.

`cost[row, col]` is a per-metre multiplier; `inf` means blocked.
"""

from __future__ import annotations

import heapq
import math

import numpy as np

SQRT2 = math.sqrt(2.0)
# (d_row, d_col, length in cells)
MOVES = [
    (-1, 0, 1.0), (1, 0, 1.0), (0, -1, 1.0), (0, 1, 1.0),
    (-1, -1, SQRT2), (-1, 1, SQRT2), (1, -1, SQRT2), (1, 1, SQRT2),
]

Cell = tuple[int, int]


def astar(cost: np.ndarray, start: Cell, goal: Cell, min_cost: float) -> list[Cell] | None:
    """Cheapest 8-connected path, or None if unreachable.

    Step cost = step length (cells) x cost of the cell entered. Diagonal moves
    are only allowed when both orthogonal neighbours are free, so the path
    never squeezes between two blocked cells touching at a corner. The
    heuristic (Euclidean x min_cost) never overestimates, so A* is optimal.
    """
    rows, cols = cost.shape
    if not (np.isfinite(cost[start]) and np.isfinite(cost[goal])):
        return None
    free = np.isfinite(cost)
    g = np.full(cost.shape, np.inf)
    parent = np.full(cost.shape + (2,), -1, np.int32)
    closed = np.zeros(cost.shape, bool)
    gr, gc = goal

    def h(r: int, c: int) -> float:
        return math.hypot(r - gr, c - gc) * min_cost

    g[start] = 0.0
    heap = [(h(*start), 0.0, start)]
    while heap:
        _, g_cur, (r, c) = heapq.heappop(heap)
        if closed[r, c]:
            continue
        if (r, c) == goal:
            return _reconstruct(parent, start, goal)
        closed[r, c] = True
        for dr, dc, length in MOVES:
            nr, nc = r + dr, c + dc
            if not (0 <= nr < rows and 0 <= nc < cols) or not free[nr, nc] or closed[nr, nc]:
                continue
            if dr and dc and not (free[r + dr, c] and free[r, c + dc]):
                continue  # corner cutting
            ng = g_cur + length * cost[nr, nc]
            if ng < g[nr, nc]:
                g[nr, nc] = ng
                parent[nr, nc] = (r, c)
                heapq.heappush(heap, (ng + h(nr, nc), ng, (nr, nc)))
    return None


def _reconstruct(parent: np.ndarray, start: Cell, goal: Cell) -> list[Cell]:
    path = [goal]
    while path[-1] != start:
        r, c = parent[path[-1]]
        path.append((int(r), int(c)))
    return path[::-1]


def line_cells(a: Cell, b: Cell) -> list[Cell]:
    """Cells touched by the segment between two cell centres (supercover).

    Samples every quarter cell; when a step changes row and column at once
    (crossing near a corner) both orthogonal neighbours are included too, so a
    segment can never slip diagonally between two blocked cells.
    """
    (r0, c0), (r1, c1) = a, b
    n = max(abs(r1 - r0), abs(c1 - c0)) * 4 or 1
    cells: list[Cell] = [a]
    for i in range(1, n + 1):
        t = i / n
        cell = (math.floor(r0 + (r1 - r0) * t + 0.5), math.floor(c0 + (c1 - c0) * t + 0.5))
        pr, pc = cells[-1]
        if cell == (pr, pc):
            continue
        if cell[0] != pr and cell[1] != pc:
            cells += [(cell[0], pc), (pr, cell[1])]
        cells.append(cell)
    return cells


def segment_cost(cost: np.ndarray, a: Cell, b: Cell) -> float:
    vals = np.array([cost[c] for c in line_cells(a, b)])
    if not np.all(np.isfinite(vals)):
        return math.inf
    return math.hypot(b[0] - a[0], b[1] - a[1]) * float(vals.mean())


def smooth(cost: np.ndarray, path: list[Cell], tolerance: float) -> list[Cell]:
    """Greedy line-of-sight smoothing that never crosses a blocked cell.

    A shortcut a->b is taken only if every touched cell is free and its cost is
    within `tolerance` of the A* sub-path it replaces, so cost preferences
    (river, parks) survive smoothing.
    """
    if len(path) <= 2:
        return path
    cum = [0.0]
    for (r0, c0), (r1, c1) in zip(path, path[1:]):
        cum.append(cum[-1] + math.hypot(r1 - r0, c1 - c0) * cost[r1, c1])
    out = [path[0]]
    i = 0
    while i < len(path) - 1:
        j = i + 1
        for k in range(i + 2, len(path)):
            seg = segment_cost(cost, path[i], path[k])
            if seg == math.inf or seg > (cum[k] - cum[i]) * tolerance:
                break
            j = k
        out.append(path[j])
        i = j
    return out
